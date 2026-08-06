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
from collections import Counter
from pathlib import Path

from app.codegen.scene import generate_scene_script, generate_morph_preview_script
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
# runaway guard, not a deadline: set MAS_RENDER_TIMEOUT=0 to disable it.
_DEFAULT_RENDER_TIMEOUT = 21600  # 6 hours


def _render_timeout() -> int | None:
    """Manim subprocess timeout in seconds; None = wait forever."""
    raw = os.environ.get("MAS_RENDER_TIMEOUT", "").strip()
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


async def _progress_ticker(job_id: str, ceiling: int = 90) -> None:
    """Nudge the progress bar while Manim runs (its output is sparse)."""
    pct = 12
    try:
        while True:
            await asyncio.sleep(1.5)
            pct = min(ceiling, pct + 3)
            rq.update_job(job_id, progress=pct)
    except asyncio.CancelledError:
        pass


def _render_one(script: str, scene_dir: Path, job: RenderJob) -> tuple[int, list[str], Path]:
    """Write the script and run Manim once. Returns (returncode, tail, media_dir)."""
    scene_dir.mkdir(parents=True, exist_ok=True)
    script_path = scene_dir / "scene.py"
    script_path.write_text(script, encoding="utf-8")
    media_dir = scene_dir / "media"
    cmd = _build_cmd(script_path, media_dir, job)
    proc = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd=str(scene_dir), timeout=_render_timeout(),
    )
    lines = [ln for ln in proc.stdout.decode(errors="replace").splitlines() if ln.strip()]
    return proc.returncode, lines[-40:], media_dir


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

    rq.update_job(job.job_id, progress=10, message="Launching Manim…")
    ticker = asyncio.create_task(_progress_ticker(job.job_id, ceiling=85 if stitch or is_slideshow else 90))
    try:
        outputs: list[Path] = []
        unit = "slide" if is_slideshow else "scene"
        for i, scene in enumerate(scenes):
            if len(scenes) > 1:
                rq.update_job(job.job_id, message=f"Rendering {unit} {i + 1}/{len(scenes)}…")
            if is_morph:
                script = generate_morph_preview_script(project, scene, job.keyframe_id)
            else:
                script = generate_scene_script(project, scene)
            try:
                rc, tail, media_dir = await asyncio.to_thread(_render_one, script, job_dir / f"scene_{i}", job)
            except subprocess.TimeoutExpired as exc:
                mins = int((exc.timeout or 0) / 60)
                rq.update_job(
                    job.job_id, status="error",
                    message=f"Manim render timed out after {mins} min "
                            f"(raise or disable with MAS_RENDER_TIMEOUT, in seconds; 0 = no limit)",
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
    finally:
        ticker.cancel()

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
