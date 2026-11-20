# Backend — FastAPI + codegen + render worker

Python ≥ 3.10 per `pyproject.toml`, but **3.11–3.13 in practice** (the pinned `pydantic==2.9.0` has no
wheels past cp313, and the setup scripts enforce that range). FastAPI + Pydantic v2 + Jinja2 + asyncio. No database, no Redis/Celery —
storage is JSON files on disk and the render queue is an in-process `asyncio.Queue`.

## Module map (`app/`)

| Module | Responsibility |
|--------|----------------|
| `main.py` | FastAPI app: all routes + the WebSocket progress stream. Launches the render worker in the lifespan. |
| `models/ir.py` | **Canonical IR schema.** Every other module imports from here. Mirror of `frontend/src/types/ir.ts`. |
| `storage/projects.py` | Load/save/delete `Project` JSON under `~/Locus/projects/`. **Every path into a project goes through `_project_dir`, which refuses a non-slug id** (`_ID_RE`) by raising `FileNotFoundError` — path params arrive URL-decoded and on Windows `%5C` is a separator, so `..%5C..` would otherwise escape the root. `project_exists` is the cheap existence check (no JSON parse). `delete_project` additionally asserts the target is a direct child of the root before rmtree-ing it. |
| `deps_check.py` | Verifies manim/ffmpeg/latex are available; cached in-memory per process. |
| `codegen/` | IR `Scene` → Manim Python script — the subtle core. See `app/codegen/CLAUDE.md`. |
| `render/` | Job queue, the Manim subprocess, and all ffmpeg post-processing (voiceover mixing, multi-scene stitching, slideshow packaging). See `app/render/CLAUDE.md`. |
| `tests/` | Standalone codegen regression harnesses (not pytest). See `tests/CLAUDE.md`. |

## Run / develop

```
# from backend/ — Windows:      .venv\Scripts\python.exe -m uvicorn app.main:app --reload --reload-dir app --port 8000
#                macOS/Linux:   .venv/bin/python        -m uvicorn app.main:app --reload --reload-dir app --port 8000
```

(Normally via `../scripts/start.ps1` / `start.sh`.) **The venv python is what must run Manim** — the
interpreter path is the one thing that differs by OS, since the venv is never "activated".

`sympy` is an **optional** dep (needed for implicit plots); it is not in the venv by default —
`pip install sympy` in the venv to enable. Its absence shows a banner, not a hard gate.

## Platform rules (do not violate)

These come from running on the Windows asyncio **SelectorEventLoop** under uvicorn `--reload`:

1. **No `asyncio.create_subprocess_exec` / `create_subprocess_shell`.** They raise
   `NotImplementedError` (whose `str()` is `""`, so it surfaces as a blank/empty error) on the
   SelectorEventLoop. Always run blocking `subprocess.run` / `Popen` via `asyncio.to_thread`.
   Applied in `deps_check.py`, `render/worker.py`, and `render/stitch.py` (ffmpeg/ffprobe).
2. **Invoke Manim as `[sys.executable, "-m", "manim", "render", ...]`** — never `["manim", ...]`
   (the venv isn't on PATH, so a bare `manim` subprocess fails with `FileNotFoundError`).
   ffmpeg / pdflatex are system tools resolved via PATH — those are fine to call by name.
3. **Worker-thread → event-loop hand-off.** `queue.update_job` broadcasts via
   `asyncio.Queue.put_nowait`, which is only safe on the loop thread. The worker streams Manim's
   stdout with `Popen` inside `asyncio.to_thread`, so its progress callbacks fire on the worker
   thread — `_process` marshals each one back with `loop.call_soon_threadsafe`. Any new code that
   updates a job from a thread must do the same.

## Render (routes in, job out)

`POST /api/render` (or `/api/render/morph-preview`) → `queue.enqueue(RenderJob)` → the single
background worker (`run_worker`, started in `main.lifespan`) processes **one job at a time**. The client
watches `WS /ws/render/{job_id}` and downloads from `/api/render/{job_id}/download` (media type inferred
from the file suffix). `RenderJob.scene_id` is a specific scene or **`None` = every scene**;
`RenderJob.format` ∈ `mp4 | gif | png | still | slideshow`; `RenderJob.mode` is `"scene"` or `"morph"`
(a 1s standalone `morph_equation` preview). Jobs live in a module dict, so a restart loses them.

**Everything the worker then does — Manim flags, timeouts, audio mixing, stitching, slideshow
packaging — is in `app/render/CLAUDE.md`.** Audio never reaches codegen: it is mixed under the rendered
mp4 afterwards, so the ejected script has no trace of it.

**Assets**: `POST /api/projects/{id}/assets/audio` and `.../assets/image` upload a file (raw bytes body
+ `?filename=` query param — deliberately no multipart parsing; `python-multipart` is still pinned in
`requirements.txt` but nothing uses it) into the project's
`assets/` dir; audio returns `{filename, duration, name}` (ffprobe), image `{filename, name}`.
`GET .../assets/{filename}` serves either kind (404s for a non-existent project rather than creating its
`assets/` dir — `assets_dir()` mkdirs on access). Image assets are referenced by `image` objects and baked
into the generated script as absolute `ImageMobject` paths (see `app/codegen/CLAUDE.md`).

**Fonts**: `GET /api/fonts` lists the system fonts a `text` object's `font` prop may name, via
`manimpango.list_fonts()` — the same Pango stack Manim's `Text` renders with, so the editor's list
is exactly what the renderer can resolve (dot-prefixed private faces are filtered out). Cached in a
module global: the scan is slow and fonts don't change mid-process.

**Slideshow playback**: `GET /api/render/{job_id}/slides` returns the deck manifest (with each
slide's URL rewritten to this API) and `.../slides/{index}` serves one slide's mp4. That endpoint
implements **HTTP `Range`** itself (`_serve_range` in `main.py`) — browsers refuse to *seek* a
video the server can't serve in pieces, and Present mode seeks to a slide's last frame when you
step back. The installed Starlette (0.38) has no range support in `FileResponse`, so don't replace
it with a plain `FileResponse`.

`GET /api/projects/{id}/scenes/{scene_id}/script` ejects the generated Manim `.py` (one-way). If
`frontend/dist` exists it's mounted at `/` (single-process / packaged mode); API + WS routes are
registered first so they win over the catch-all SPA mount.

## Conventions

- IR uses string enums (`ObjectType`, `AnimationVerb`, …). `SceneObject.props` is a free-form
  `dict[str, Any]` — per-type prop models (`ShapeProps`, `GraphProps`, …) exist for documentation
  but the IR stores a plain dict, so adding a new prop needs **no schema change** on either side.
- `new_id()` → 8-char uuid slug for IR entities; `queue.new_job_id()` → 12-char for jobs.
- Times are seconds; the timeline is wall-clock (`start_time` + `duration`).
