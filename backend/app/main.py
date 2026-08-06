"""FastAPI application entry point."""
from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import deps_check
from app.codegen.scene import generate_scene_script
from app.models.ir import (
    MorphPreviewRequest, Project, ProjectKind, ProjectSummary, RenderJob, RenderRequest, new_id,
)
from app.render import queue as rq
from app.render.slideshow import MANIFEST_NAME, SLIDES_SUBDIR, slide_filename
from app.render.stitch import probe_duration
from app.render.worker import run_worker
from app.storage.projects import (
    assets_dir,
    create_project,
    delete_project,
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

# Raster formats PIL/ImageMobject can load (SVG would need SVGMobject — not supported).
_IMAGE_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".bmp": "image/bmp",
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


_FONT_CACHE: list[str] | None = None


@app.get("/api/fonts")
async def system_fonts() -> dict[str, Any]:
    """System fonts usable by a `text` object's `font` prop.

    Enumerated through manimpango — the same Pango stack Manim's `Text` renders
    with, so anything listed here is guaranteed to resolve at render time (a
    missing font would silently fall back to the default). Rendering happens on
    this machine, so the editor's list is always the renderer's list. Cached for
    the process: scanning the font dirs is slow and fonts rarely change.
    """
    global _FONT_CACHE
    if _FONT_CACHE is None:
        try:
            import manimpango

            # Drop the dot-prefixed private system faces (".AppleSystemUIFont").
            _FONT_CACHE = sorted(f for f in manimpango.list_fonts() if not f.startswith("."))
        except Exception:
            _FONT_CACHE = []
    return {"fonts": _FONT_CACHE}


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

class CreateProjectBody(BaseModel):
    name: str = "Untitled Project"
    kind: ProjectKind = ProjectKind.ANIMATION


@app.get("/api/projects", response_model=list[ProjectSummary])
async def get_projects() -> list[ProjectSummary]:
    return list_projects()


@app.post("/api/projects", response_model=Project)
async def post_project(body: CreateProjectBody) -> Project:
    return create_project(body.name, body.kind)


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


@app.delete("/api/projects/{project_id}", status_code=204)
async def del_project(project_id: str) -> Response:
    """Delete a project and everything under it. The client confirms first — there
    is no undo and no trash."""
    try:
        # rmtree can walk a big renders/ tree, so keep it off the event loop.
        await asyncio.to_thread(delete_project, project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Media assets (voiceover audio / image uploads). The body is the raw file
# bytes (no multipart, so no extra dependency); the original filename rides in
# a query param and only its extension + stem are used.
# ---------------------------------------------------------------------------

async def _save_asset(project_id: str, request: Request, filename: str,
                      allowed: dict[str, str], kind: str, prefix: str) -> tuple[str, Path]:
    try:
        load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    ext = Path(filename).suffix.lower()
    if ext not in allowed:
        supported = ", ".join(sorted(allowed))
        raise HTTPException(status_code=400, detail=f"Unsupported {kind} type '{ext}' (supported: {supported})")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    asset_name = f"{prefix}_{new_id()}{ext}"
    dest = assets_dir(project_id) / asset_name
    await asyncio.to_thread(dest.write_bytes, data)
    return asset_name, dest


@app.post("/api/projects/{project_id}/assets/audio")
async def upload_audio_asset(project_id: str, request: Request, filename: str = "voiceover.mp3") -> dict[str, Any]:
    asset_name, dest = await _save_asset(project_id, request, filename, _AUDIO_MEDIA_TYPES, "audio", "au")
    duration = await asyncio.to_thread(probe_duration, dest)
    return {"filename": asset_name, "duration": duration, "name": Path(filename).stem}


@app.post("/api/projects/{project_id}/assets/image")
async def upload_image_asset(project_id: str, request: Request, filename: str = "image.png") -> dict[str, Any]:
    asset_name, _ = await _save_asset(project_id, request, filename, _IMAGE_MEDIA_TYPES, "image", "im")
    return {"filename": asset_name, "name": Path(filename).stem}


@app.get("/api/projects/{project_id}/assets/{filename}")
async def get_asset(project_id: str, filename: str) -> FileResponse:
    if not _ASSET_NAME_RE.match(filename) or ".." in filename:
        raise HTTPException(status_code=400, detail="Bad asset filename")
    path = assets_dir(project_id) / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    media_type = {**_AUDIO_MEDIA_TYPES, **_IMAGE_MEDIA_TYPES}.get(path.suffix.lower(), "application/octet-stream")
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
# Slideshow playback — a finished `slideshow` render leaves an unzipped player
# folder in the job dir, so the editor's Present mode can stream the slides one
# by one instead of downloading the zip.
# ---------------------------------------------------------------------------

def _deck_dir(job_id: str) -> Path:
    job = rq.get_job(job_id)
    if not job or job.status != "done" or not job.output_path or job.format != "slideshow":
        raise HTTPException(status_code=404, detail="No finished slideshow for this job")
    d = Path(job.output_path).parent / "slideshow"
    if not d.is_dir():
        raise HTTPException(status_code=404, detail="Slideshow files are missing")
    return d


@app.get("/api/render/{job_id}/slides")
async def get_slide_manifest(job_id: str) -> dict[str, Any]:
    manifest_file = _deck_dir(job_id) / MANIFEST_NAME
    if not manifest_file.is_file():
        raise HTTPException(status_code=404, detail="Slideshow manifest is missing")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    # Swap the archive-relative paths for URLs this server can serve.
    for slide in manifest.get("slides", []):
        slide["url"] = f"/api/render/{job_id}/slides/{slide['index']}"
    return manifest


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _serve_range(path: Path, range_header: str | None, media_type: str) -> Response:
    """Serve a file, honouring a single `Range: bytes=…` request.

    Presenting seeks (stepping back lands on a slide's last frame), and a browser
    will only seek a video the server can serve in pieces. This installed
    Starlette (0.38) has no range support in FileResponse, so do it here.
    """
    size = path.stat().st_size
    m = _RANGE_RE.match((range_header or "").strip()) if range_header else None
    if not m:
        return FileResponse(str(path), media_type=media_type, filename=path.name,
                            headers={"Accept-Ranges": "bytes"})

    first, last = m.group(1), m.group(2)
    if first:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
    else:
        # A suffix range ("bytes=-500") asks for the final N bytes.
        start, end = max(0, size - int(last or 0)), size - 1
    if start >= size or start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    def chunks(chunk_size: int = 64 * 1024):
        remaining = end - start + 1
        with path.open("rb") as fh:
            fh.seek(start)
            while remaining > 0:
                data = fh.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(chunks(), status_code=206, media_type=media_type, headers={
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(end - start + 1),
        "Accept-Ranges": "bytes",
    })


@app.get("/api/render/{job_id}/slides/{index}")
async def get_slide_video(job_id: str, index: int, request: Request) -> Response:
    path = _deck_dir(job_id) / SLIDES_SUBDIR / slide_filename(index + 1)
    if index < 0 or not path.is_file():
        raise HTTPException(status_code=404, detail="Slide not found")
    return _serve_range(path, request.headers.get("range"), "video/mp4")


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
