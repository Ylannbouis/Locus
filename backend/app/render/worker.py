"""Render worker: pulls jobs, runs Manim as a subprocess, streams progress.

One job runs at a time. Manim is invoked through THIS interpreter (the venv's
python) as a module, so it works without the venv being on PATH. Supports per-
scene rendering plus whole-project stitching, and mp4/gif/png-sequence/still
output formats at a chosen resolution/fps.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
import time
from collections import Counter, deque
from functools import partial
from pathlib import Path
from typing import Callable

from app.codegen.scene import (generate_scene_script, generate_morph_preview_script,
                               scene_runtime_seconds)
from app.codegen.template import SCENE_CLASS_NAME
from app.models.ir import RenderJob, Scene
from app.render import queue as rq
from app.render.audio import audible_clips, mux_scene_audio
from app.render.slideshow import build_slideshow, zip_slideshow
from app.render.stitch import concat_scenes, crossfade_scenes, zip_dir
from app.storage.projects import assets_dir, load_project, renders_dir

_QUALITY_FLAG = {"preview": "-ql", "final": "-qh"}

_RESOLUTION = {
    "480p": (854, 480),
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "4k": (3840, 2160),
}

# Per-scene wall-clock cap on the Manim subprocess, in seconds. Heavy scenes
# (4k, long durations, lots of LaTeX) legitimately run for hours, so this is a
# runaway guard, not a deadline: set LOCUS_RENDER_TIMEOUT=0 to disable it.
_DEFAULT_RENDER_TIMEOUT = 21600  # 6 hours


def _render_timeout() -> int | None:
    """Manim subprocess timeout in seconds; None = wait forever."""
    raw = os.environ.get("LOCUS_RENDER_TIMEOUT", "").strip()
    if not raw:
        return _DEFAULT_RENDER_TIMEOUT
    try:
        secs = int(float(raw))
    except ValueError:
        return _DEFAULT_RENDER_TIMEOUT
    return secs if secs > 0 else None


async def run_worker() -> None:
    while True:
        job = await rq.get_next()
        try:
            await _process(job)
        except Exception as exc:  # never let the worker loop die
            rq.update_job(job.job_id, status="error", message=f"{type(exc).__name__}: {exc}")
        finally:
            rq.task_done()


def _mtime(p: Path) -> float:
    return p.stat().st_mtime


def _find_output(media_dir: Path, fmt: str) -> Path | None:
    """Locate Manim's output for a format. Returns a file, except `png` which
    returns the directory holding the frame sequence."""
    if fmt == "gif":
        c = list(media_dir.rglob("*.gif"))
        return max(c, key=_mtime) if c else None
    if fmt == "still":
        c = [p for p in media_dir.rglob("*.png") if "partial_movie_files" not in p.parts]
        return max(c, key=_mtime) if c else None
    if fmt == "png":
        pngs = [p for p in media_dir.rglob("*.png") if "partial_movie_files" not in p.parts]
        if not pngs:
            return None
        # The sequence lives in one folder; pick the folder with the most frames.
        return Counter(p.parent for p in pngs).most_common(1)[0][0]
    # mp4 — also the "slideshow" case, whose slides are ordinary mp4 renders.
    c = [p for p in media_dir.rglob("*.mp4") if "partial_movie_files" not in p.parts]
    return max(c, key=_mtime) if c else None


def _build_cmd(script_path: Path, media_dir: Path, job: RenderJob) -> list[str]:
    cmd = [sys.executable, "-m", "manim", "render", _QUALITY_FLAG.get(job.quality, "-ql")]
    if job.resolution in _RESOLUTION:
        w, h = _RESOLUTION[job.resolution]
        cmd += ["--resolution", f"{w},{h}"]
    if job.fps:
        cmd += ["--fps", str(int(job.fps))]
    if job.format == "gif":
        cmd += ["--format", "gif"]
    elif job.format == "png":
        cmd += ["--format", "png"]
    elif job.format == "still":
        cmd += ["-s"]  # save the last frame as a single image
    if job.transparent and job.format in ("png", "gif", "still"):
        cmd += ["-t"]
    cmd += ["--media_dir", str(media_dir), "--progress_bar", "none",
            str(script_path), SCENE_CLASS_NAME]
    return cmd


# Progress bands. Everything below RENDER_FLOOR is setup, everything above the
# ceiling is ffmpeg post-processing; Manim's frames fill the middle.
_RENDER_FLOOR = 10
_PROGRESS_PREFIX = "LOCUS_PROGRESS "


class _JobProgress:
    """Turns per-scene frame fractions into a job percentage + an ETA.

    Scenes are weighted by their animation length, so scene 2 of a 5s + 60s pair
    owns most of the bar. Manim's own frame counter drives it (the generated
    script prints `LOCUS_PROGRESS done total`); `_drift` only covers the stretch
    before the first frame — process start-up, LaTeX, mobject construction.

    Not thread-safe by design: every method must be called on the event loop
    thread, which is what `_render_one`'s callback marshals back to.
    """

    def __init__(self, job_id: str, weights: list[float], ceiling: int) -> None:
        self.job_id = job_id
        self.weights = weights or [1.0]
        self.total_weight = sum(self.weights) or 1.0
        self.ceiling = ceiling
        self.index = 0            # scene being rendered
        self.done_weight = 0.0    # weight of scenes already finished
        self.pct = float(_RENDER_FLOOR)
        self.saw_frames = False
        self.eta: int | None = None
        self._anchor: tuple[float, float] | None = None  # (time, overall) of scene's 1st frame
        self._published: tuple[int, int | None] = (_RENDER_FLOOR, None)

    def start_scene(self, index: int) -> None:
        self.index = index
        self.done_weight = sum(self.weights[:index])
        self.saw_frames = False  # this scene's start-up is unmeasured again
        self._anchor = None      # and it re-measures its own frame rate

    def finish_scene(self) -> None:
        self.done_weight = sum(self.weights[:self.index + 1])
        self._advance(self.done_weight / self.total_weight)

    def on_frames(self, fraction: float) -> None:
        """`fraction` ∈ [0,1] of the current scene's animation seconds rendered.
        Squeezed into the scene's slice so the bar keeps a little headroom for
        that scene's start-up and its final ffmpeg pass."""
        self.saw_frames = True
        scene_frac = 0.04 + 0.92 * max(0.0, min(1.0, fraction))
        weight = self.weights[self.index] if self.index < len(self.weights) else 1.0
        self._advance((self.done_weight + weight * scene_frac) / self.total_weight)

    def drift(self) -> None:
        """Tick for the stretch before the current scene's first frame — Manim
        starting up, LaTeX, building mobjects. Creeps a quarter of the way into
        that scene's slice and asymptotes there, which is honest about not
        knowing; the old fixed +3%/1.5s pinned itself at 90% within a minute of
        a render that could still have hours to run."""
        if self.saw_frames:
            return
        band = self.ceiling - _RENDER_FLOOR
        base = _RENDER_FLOOR + band * (self.done_weight / self.total_weight)
        share = band * (self.weights[self.index] if self.index < len(self.weights)
                        else 1.0) / self.total_weight
        headroom = (base + 0.25 * share) - self.pct
        if headroom > 0.05:
            self.pct += headroom * 0.06
            self._publish()

    def _advance(self, overall: float) -> None:
        target = _RENDER_FLOOR + (self.ceiling - _RENDER_FLOOR) * max(0.0, min(1.0, overall))
        self.pct = max(self.pct, target)  # never walk backwards
        now = time.monotonic()
        # Extrapolate from how fast *frames* have been landing since this scene's
        # first one. Timing from the job's start instead would fold in Manim's
        # start-up — import, LaTeX, building mobjects — as though it were frame
        # work, which on a heavy scene overstates the first estimate several-fold.
        # The flip side: a later scene's start-up isn't modelled, so a multi-scene
        # ETA reads a little short.
        if self._anchor is None:
            if self.saw_frames:
                self._anchor = (now, overall)
        else:
            t0, f0 = self._anchor
            dt, df = now - t0, overall - f0
            if dt >= 3.0 and df >= 0.02:
                remaining = dt * (1.0 - overall) / df
                # Coarse buckets: a jittery seconds-exact ETA reads as less
                # reliable than a rounded one, and rounding damps rate noise.
                step = 5 if remaining < 60 else (15 if remaining < 600 else 60)
                self.eta = max(step, int(round(remaining / step)) * step)
        self._publish()

    def _publish(self) -> None:
        state = (int(self.pct), self.eta)
        if state == self._published:
            return
        self._published = state
        rq.update_job(self.job_id, progress=state[0], eta_seconds=state[1])


async def _progress_ticker(progress: _JobProgress) -> None:
    """Creeps the bar forward until Manim reports its first frame."""
    try:
        while True:
            await asyncio.sleep(1.5)
            progress.drift()
    except asyncio.CancelledError:
        pass


def _render_one(script: str, scene_dir: Path, job: RenderJob,
                on_frames: Callable[[float], None] | None = None,
                on_stage: Callable[[str], None] | None = None) -> tuple[int, list[str], Path]:
    """Write the script and run Manim once. Returns (returncode, tail, media_dir).

    Output is consumed line by line as it arrives — that stream is what carries
    the progress markers, so it can't be collected at exit like `subprocess.run`
    does. Callbacks fire on THIS (worker) thread; callers hand them back to the
    loop thread themselves.
    """
    scene_dir.mkdir(parents=True, exist_ok=True)
    script_path = scene_dir / "scene.py"
    script_path.write_text(script, encoding="utf-8")
    media_dir = scene_dir / "media"
    cmd = _build_cmd(script_path, media_dir, job)

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(scene_dir),
    )
    # The deadline can't be enforced by the read loop: a Manim wedged before it
    # prints anything (a hung LaTeX run) would leave us blocked in readline. A
    # timer thread kills the process instead, which ends the stream.
    timeout = _render_timeout()
    timed_out = threading.Event()

    def _kill() -> None:
        timed_out.set()
        proc.kill()

    killer = threading.Timer(timeout, _kill) if timeout else None
    if killer:
        killer.daemon = True
        killer.start()

    tail: deque[str] = deque(maxlen=40)
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode(errors="replace").strip()
            if not line:
                continue
            if line.startswith(_PROGRESS_PREFIX):
                if on_frames is not None:
                    parts = line[len(_PROGRESS_PREFIX):].split()
                    try:
                        done, total = float(parts[0]), float(parts[1])
                    except (IndexError, ValueError):
                        continue
                    if total > 0:
                        on_frames(done / total)
                continue
            tail.append(line)
            # Manim's last phase: partial movie files → one mp4. No frame
            # counter covers it, and on a long scene it is minutes of work.
            if on_stage is not None and "Combining to Movie file" in line:
                on_stage("encoding")
        rc = proc.wait()
    finally:
        if killer:
            killer.cancel()
        if proc.stdout is not None:
            proc.stdout.close()
        if proc.poll() is None:  # only reachable if the read loop itself raised
            proc.kill()
            proc.wait()

    if timed_out.is_set():
        raise subprocess.TimeoutExpired(cmd, timeout or 0)
    return rc, list(tail), media_dir


async def _process(job: RenderJob) -> None:
    rq.update_job(job.job_id, status="running", progress=5, message="Preparing scene…")

    project = load_project(job.project_id)
    if not project.scenes:
        rq.update_job(job.job_id, status="error", message="Project has no scenes")
        return

    # Resolve which scenes to render.
    scenes: list[Scene]
    if job.scene_id:
        scene = next((s for s in project.scenes if s.id == job.scene_id), None)
        if scene is None:
            rq.update_job(job.job_id, status="error", message=f"Scene not found: {job.scene_id}")
            return
        scenes = [scene]
    else:
        scenes = list(project.scenes)

    is_morph = job.mode == "morph" and bool(job.keyframe_id)
    # A slideshow keeps its scenes as separate mp4s (one per slide) instead of
    # stitching them; every other multi-scene mp4 render is stitched. Other
    # formats / morph render a single scene.
    is_slideshow = job.format == "slideshow" and not is_morph
    stitch = job.format == "mp4" and not is_morph and len(scenes) > 1
    if (job.format not in ("mp4", "slideshow") or is_morph) and len(scenes) > 1:
        scenes = scenes[:1]

    job_dir = renders_dir(job.project_id) / job.job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    rq.update_job(job.job_id, progress=_RENDER_FLOOR, message="Launching Manim…")
    loop = asyncio.get_running_loop()
    progress = _JobProgress(
        job.job_id,
        weights=[scene_runtime_seconds(s) for s in scenes],
        ceiling=85 if stitch or is_slideshow else 90,
    )
    ticker = asyncio.create_task(_progress_ticker(progress))
    try:
        outputs: list[Path] = []
        unit = "slide" if is_slideshow else "scene"
        for i, scene in enumerate(scenes):
            progress.start_scene(i)
            prefix = f"Rendering {unit} {i + 1}/{len(scenes)}" if len(scenes) > 1 else "Rendering"
            if len(scenes) > 1:
                rq.update_job(job.job_id, message=f"{prefix}…")
            if is_morph:
                script = generate_morph_preview_script(project, scene, job.keyframe_id)
            else:
                script = generate_scene_script(project, scene, progress=True)
            # Manim runs off-thread, so its callbacks are marshalled back to the
            # loop thread — rq.update_job broadcasts through an asyncio.Queue.
            def on_frames(fraction: float) -> None:
                loop.call_soon_threadsafe(progress.on_frames, fraction)

            def on_stage(_stage: str, msg: str = f"{prefix} — encoding video…") -> None:
                loop.call_soon_threadsafe(partial(rq.update_job, job.job_id, message=msg))

            try:
                rc, tail, media_dir = await asyncio.to_thread(
                    _render_one, script, job_dir / f"scene_{i}", job, on_frames, on_stage)
            except subprocess.TimeoutExpired as exc:
                mins = int((exc.timeout or 0) / 60)
                rq.update_job(
                    job.job_id, status="error",
                    message=f"Manim render timed out after {mins} min "
                            f"(raise or disable with LOCUS_RENDER_TIMEOUT, in seconds; 0 = no limit)",
                )
                return
            if rc != 0:
                detail = " | ".join(tail[-6:]) or "unknown error"
                rq.update_job(job.job_id, status="error", message=f"Manim failed: {detail}")
                return
            out = _find_output(media_dir, job.format)
            if out is None:
                rq.update_job(job.job_id, status="error", message="Render finished but no output was produced")
                return
            outputs.append(out)
            progress.finish_scene()
    finally:
        ticker.cancel()

    # Past this point the remaining work is ffmpeg, which the ETA never modelled
    # — drop it rather than let a stale number count down against a stitch.
    rq.update_job(job.job_id, eta_seconds=None)

    # Mix voiceover audio under each scene's mp4 (post-render, so codegen and
    # Manim never see it). When stitching, scenes *without* clips get a silent
    # track so every input has identical streams for concat.
    if job.format in ("mp4", "slideshow") and not is_morph:
        assets = assets_dir(project.id)
        if any(audible_clips(s.audio, assets) for s in scenes):
            rq.update_job(job.job_id, progress=88 if stitch or is_slideshow else 91, message="Mixing audio…")
            try:
                for i, scene in enumerate(scenes):
                    if not stitch and not audible_clips(scene.audio, assets):
                        continue
                    mixed = outputs[i].with_name(outputs[i].stem + "_audio.mp4")
                    await asyncio.to_thread(mux_scene_audio, outputs[i], scene.audio, assets, mixed)
                    outputs[i] = mixed
            except Exception as exc:
                rq.update_job(job.job_id, status="error", message=f"Audio mixing failed: {exc}")
                return

    # Combine / package the per-scene outputs.
    try:
        if is_slideshow:
            rq.update_job(job.job_id, progress=92, message="Building slideshow…")
            # The player folder stays on disk (the editor's Present mode streams
            # the slides straight out of it); the zip is what gets downloaded.
            deck_dir = job_dir / "slideshow"
            await asyncio.to_thread(
                build_slideshow, outputs, scenes, deck_dir,
                project.metadata.get("name", "Slideshow"),
            )
            zip_path = job_dir / "slideshow.zip"
            await asyncio.to_thread(zip_slideshow, deck_dir, zip_path)
            output_path = zip_path
        elif stitch:
            rq.update_job(job.job_id, progress=92, message="Stitching scenes…")
            final = job_dir / "project.mp4"
            if job.transition:
                await asyncio.to_thread(crossfade_scenes, outputs, final, 0.6)
            else:
                await asyncio.to_thread(concat_scenes, outputs, final)
            output_path = final
        elif job.format == "png":
            rq.update_job(job.job_id, progress=92, message="Zipping frames…")
            zip_path = job_dir / "frames.zip"
            await asyncio.to_thread(zip_dir, outputs[0], zip_path)
            output_path = zip_path
        else:
            output_path = outputs[0]
    except Exception as exc:
        rq.update_job(job.job_id, status="error", message=f"Post-processing failed: {exc}")
        return

    rq.update_job(
        job.job_id,
        status="done",
        progress=100,
        message="Render complete",
        output_path=str(output_path),
    )
