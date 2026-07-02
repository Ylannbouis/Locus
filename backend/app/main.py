"""FastAPI application entry point."""
from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import deps_check
from app.codegen.scene import generate_scene_script
from app.models.ir import (
    MorphPreviewRequest, Project, ProjectSummary, RenderJob, RenderRequest, new_id,
)
from app.render import queue as rq
from app.render.stitch import probe_duration
from app.render.worker import run_worker
from app.storage.projects import (
    assets_dir,
    create_project,
    list_projects,
    load_project,
    save_project,
)

_MEDIA_TYPES = {
    ".mp4": "video/mp4", ".gif": "image/gif", ".png": "image/png", ".zip": "application/zip",
}

_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
}

_ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


# ---------------------------------------------------------------------------
# Lifespan: launch the background render worker for the app's lifetime
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    worker_task = asyncio.create_task(run_worker())
    try:
        yield
    finally:
        worker_task.cancel()


app = FastAPI(title="Math Animation Studio", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# System / deps
# ---------------------------------------------------------------------------

@app.get("/api/system/deps")
async def system_deps() -> dict[str, Any]:
    cached = deps_check.load_cached()
    if cached:
        return cached
    result = await deps_check.check_all()
    deps_check.save_cache(result)
    return result


@app.post("/api/system/deps/refresh")
async def refresh_deps() -> dict[str, Any]:
    result = await deps_check.check_all()
    deps_check.save_cache(result)
    return result


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

class CreateProjectBody(BaseModel):
    name: str = "Untitled Project"


@app.get("/api/projects", response_model=list[ProjectSummary])
async def get_projects() -> list[ProjectSummary]:
    return list_projects()


@app.post("/api/projects", response_model=Project)
async def post_project(body: CreateProjectBody) -> Project:
    return create_project(body.name)


@app.get("/api/projects/{project_id}", response_model=Project)
async def get_project(project_id: str) -> Project:
    try:
        return load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@app.put("/api/projects/{project_id}", response_model=Project)
async def put_project(project_id: str, project: Project) -> Project:
    if project.id != project_id:
        raise HTTPException(status_code=400, detail="Project ID mismatch")
    return save_project(project)


# ---------------------------------------------------------------------------
# Audio assets (voiceover uploads). The body is the raw file bytes (no
# multipart, so no extra dependency); the original filename rides in a query
# param and only its extension + stem are used.
# ---------------------------------------------------------------------------

@app.post("/api/projects/{project_id}/assets/audio")
async def upload_audio_asset(project_id: str, request: Request, filename: str = "voiceover.mp3") -> dict[str, Any]:
    try:
        load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    ext = Path(filename).suffix.lower()
    if ext not in _AUDIO_MEDIA_TYPES:
        supported = ", ".join(sorted(_AUDIO_MEDIA_TYPES))
        raise HTTPException(status_code=400, detail=f"Unsupported audio type '{ext}' (supported: {supported})")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    asset_name = f"au_{new_id()}{ext}"
    dest = assets_dir(project_id) / asset_name
    await asyncio.to_thread(dest.write_bytes, data)
    duration = await asyncio.to_thread(probe_duration, dest)
    return {"filename": asset_name, "duration": duration, "name": Path(filename).stem}


@app.get("/api/projects/{project_id}/assets/{filename}")
async def get_audio_asset(project_id: str, filename: str) -> FileResponse:
    if not _ASSET_NAME_RE.match(filename) or ".." in filename:
        raise HTTPException(status_code=400, detail="Bad asset filename")
    path = assets_dir(project_id) / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    media_type = _AUDIO_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(str(path), media_type=media_type, filename=filename)


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------

@app.post("/api/render")
async def post_render(req: RenderRequest) -> dict[str, str]:
    job_id = rq.new_job_id()
    job = RenderJob(
        job_id=job_id,
        project_id=req.project_id,
        scene_id=req.scene_id,
        quality=req.quality,
        format=req.format,
        resolution=req.resolution.value if req.resolution else None,
        fps=req.fps,
        transparent=req.transparent,
        transition=req.transition,
    )
    rq.enqueue(job)
    return {"job_id": job_id}


@app.post("/api/render/morph-preview")
async def post_morph_preview(req: MorphPreviewRequest) -> dict[str, str]:
    job_id = rq.new_job_id()
    job = RenderJob(
        job_id=job_id,
        project_id=req.project_id,
        scene_id=req.scene_id,
        quality="preview",
        mode="morph",
        keyframe_id=req.keyframe_id,
    )
    rq.enqueue(job)
    return {"job_id": job_id}


@app.get("/api/render/{job_id}")
async def get_render_status(job_id: str) -> dict[str, Any]:
    job = rq.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.model_dump()


@app.get("/api/render/{job_id}/download")
async def download_render(job_id: str) -> FileResponse:
    job = rq.get_job(job_id)
    if not job or job.status != "done" or not job.output_path:
        raise HTTPException(status_code=404, detail="Render not ready")
    path = Path(job.output_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file missing")
    media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(str(path), media_type=media_type, filename=path.name)


# ---------------------------------------------------------------------------
# Eject to code — return the generated Manim script for a scene (one-way)
# ---------------------------------------------------------------------------

@app.get("/api/projects/{project_id}/scenes/{scene_id}/script")
async def get_scene_script(project_id: str, scene_id: str) -> dict[str, str]:
    try:
        project = load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    scene = next((s for s in project.scenes if s.id == scene_id), None)
    if scene is None:
        raise HTTPException(status_code=404, detail="Scene not found")
    return {"script": generate_scene_script(project, scene)}


# ---------------------------------------------------------------------------
# WebSocket — render progress stream
# ---------------------------------------------------------------------------

@app.websocket("/ws/render/{job_id}")
async def ws_render(websocket: WebSocket, job_id: str) -> None:
    await websocket.accept()
    job = rq.get_job(job_id)
    if not job:
        await websocket.send_json({"status": "error", "message": "Job not found", "job_id": job_id})
        await websocket.close()
        return
    await websocket.send_json(job.model_dump())
    if job.status in ("done", "error"):
        await websocket.close()
        return

    sub_q = rq.subscribe(job_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(sub_q.get(), timeout=30)
                await websocket.send_json(event)
                if event.get("status") in ("done", "error"):
                    break
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"ping": True})
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    finally:
        rq.unsubscribe(job_id, sub_q)
    await websocket.close()


# ---------------------------------------------------------------------------
# Packaged / production mode: serve the built frontend if it exists.
# In dev the frontend runs on Vite (5173); this mount is a no-op then. API and
# WebSocket routes are registered above, so they take precedence over this
# catch-all SPA mount.
# ---------------------------------------------------------------------------

_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
