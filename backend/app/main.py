"""FastAPI application entry point."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import deps_check
from app.models.ir import (
    MorphPreviewRequest, Project, ProjectSummary, RenderJob, RenderRequest,
)
from app.render import queue as rq
from app.render.worker import run_worker
from app.storage.projects import (
    create_project,
    list_projects,
    load_project,
    save_project,
)


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
    return FileResponse(str(path), media_type="video/mp4", filename=path.name)


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
