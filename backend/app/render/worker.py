"""Render worker: pulls jobs, runs Manim as a subprocess, streams progress.

One job runs at a time. Manim is invoked through THIS interpreter (the venv's
python) as a module, so it works without the venv being on PATH.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from app.codegen.scene import generate_scene_script, generate_morph_preview_script
from app.codegen.template import SCENE_CLASS_NAME
from app.models.ir import RenderJob
from app.render import queue as rq
from app.storage.projects import load_project, renders_dir

_QUALITY_FLAG = {"preview": "-ql", "final": "-qh"}


async def run_worker() -> None:
    while True:
        job = await rq.get_next()
        try:
            await _process(job)
        except Exception as exc:  # never let the worker loop die
            rq.update_job(job.job_id, status="error", message=f"{type(exc).__name__}: {exc}")
        finally:
            rq.task_done()


def _find_output(media_dir: Path) -> Path | None:
    candidates = [
        p for p in media_dir.rglob("*.mp4")
        if "partial_movie_files" not in p.parts
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


async def _progress_ticker(job_id: str) -> None:
    """Nudge the progress bar while Manim runs (its output is sparse)."""
    pct = 12
    try:
        while True:
            await asyncio.sleep(1.5)
            pct = min(90, pct + 3)
            rq.update_job(job_id, progress=pct)
    except asyncio.CancelledError:
        pass


async def _process(job: RenderJob) -> None:
    rq.update_job(job.job_id, status="running", progress=5, message="Preparing scene…")

    project = load_project(job.project_id)
    if not project.scenes:
        rq.update_job(job.job_id, status="error", message="Project has no scenes")
        return

    scene = None
    if job.scene_id:
        scene = next((s for s in project.scenes if s.id == job.scene_id), None)
        if scene is None:
            rq.update_job(
                job.job_id,
                status="error",
                message=f"Scene not found: {job.scene_id}",
            )
            return
    else:
        if len(project.scenes) > 1:
            rq.update_job(
                job.job_id,
                status="error",
                message="scene_id is required when the project has multiple scenes",
            )
            return
        scene = project.scenes[0]

    if job.mode == "morph" and job.keyframe_id:
        script = generate_morph_preview_script(project, scene, job.keyframe_id)
    else:
        script = generate_scene_script(project, scene)

    job_dir = renders_dir(job.project_id) / job.job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    script_path = job_dir / "scene.py"
    script_path.write_text(script, encoding="utf-8")
    media_dir = job_dir / "media"

    qflag = _QUALITY_FLAG.get(job.quality, "-ql")
    cmd = [
        sys.executable, "-m", "manim", "render", qflag,
        "--media_dir", str(media_dir),
        "--progress_bar", "none",
        str(script_path), SCENE_CLASS_NAME,
    ]

    rq.update_job(job.job_id, progress=10, message="Launching Manim…")

    # Run Manim in a worker thread with a plain blocking subprocess. asyncio's
    # create_subprocess_exec is unavailable on the Windows SelectorEventLoop that
    # uvicorn uses under --reload, so we avoid it entirely.
    def _run() -> tuple[int, list[str]]:
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            cwd=str(job_dir), timeout=1800,
        )
        lines = [ln for ln in proc.stdout.decode(errors="replace").splitlines() if ln.strip()]
        return proc.returncode, lines[-40:]

    ticker = asyncio.create_task(_progress_ticker(job.job_id))
    try:
        returncode, tail = await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
        ticker.cancel()
        rq.update_job(job.job_id, status="error", message="Manim render timed out (30 min)")
        return
    finally:
        ticker.cancel()

    if returncode != 0:
        detail = " | ".join(tail[-6:]) or "unknown error"
        rq.update_job(job.job_id, status="error", message=f"Manim failed: {detail}")
        return

    out = _find_output(media_dir)
    if out is None:
        rq.update_job(job.job_id, status="error", message="Render finished but no MP4 was produced")
        return

    rq.update_job(
        job.job_id,
        status="done",
        progress=100,
        message="Render complete",
        output_path=str(out),
    )
