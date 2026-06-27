"""Render worker: pulls jobs, runs Manim as a subprocess, streams progress.

One job runs at a time. Manim is invoked through THIS interpreter (the venv's
python) as a module, so it works without the venv being on PATH.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from app.codegen.scene import generate_scene_script
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
    scene = None
    if job.scene_id:
        scene = next((s for s in project.scenes if s.id == job.scene_id), None)
    if scene is None:
        scene = project.scenes[0] if project.scenes else None
    if scene is None:
        rq.update_job(job.job_id, status="error", message="Project has no scenes")
        return

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
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(job_dir),
    )

    ticker = asyncio.create_task(_progress_ticker(job.job_id))
    tail: list[str] = []
    try:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").rstrip()
            if not text:
                continue
            tail.append(text)
            tail[:] = tail[-40:]
            rq.update_job(job.job_id, message=text[-180:])
        await proc.wait()
    finally:
        ticker.cancel()

    if proc.returncode != 0:
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
