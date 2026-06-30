# Backend — FastAPI + codegen + render worker

Python ≥ 3.10, FastAPI + Pydantic v2 + Jinja2 + asyncio. No database, no Redis/Celery —
storage is JSON files on disk and the render queue is an in-process `asyncio.Queue`.

## Module map (`app/`)

| Module | Responsibility |
|--------|----------------|
| `main.py` | FastAPI app: all routes + the WebSocket progress stream. Launches the render worker in the lifespan. |
| `models/ir.py` | **Canonical IR schema.** Every other module imports from here. Mirror of `frontend/src/types/ir.ts`. |
| `storage/projects.py` | Load/save `Project` JSON under `~/MathAnimStudio/projects/`. |
| `deps_check.py` | Verifies manim/ffmpeg/latex are available; cached in-memory per process. |
| `codegen/` | IR `Scene` → Manim Python script. See `codegen/CLAUDE.md`. |
| `render/queue.py` | In-process job registry + pub/sub for progress events. |
| `render/worker.py` | Pulls jobs, runs Manim as a subprocess, locates the output MP4. |
| `render/stitch.py` | ffmpeg concat of per-scene renders (multi-scene export). |

## Run / develop

```
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --reload --reload-dir app --port 8000
```

(Normally via `../scripts/start.ps1`.) The venv python at `.venv/Scripts/python.exe` is what
must run Manim. Note `sys.executable` there is backed by the Anaconda base binary but
`site-packages` is the venv, so `sys.executable -m manim` resolves correctly.

`sympy` is an **optional** dep (needed for implicit plots); it is not in the venv by default —
`pip install sympy` in the venv to enable. Its absence shows a banner, not a hard gate.

## Platform rules (do not violate)

These come from running on the Windows asyncio **SelectorEventLoop** under uvicorn `--reload`:

1. **No `asyncio.create_subprocess_exec` / `create_subprocess_shell`.** They raise
   `NotImplementedError` (whose `str()` is `""`, so it surfaces as a blank/empty error) on the
   SelectorEventLoop. Always run blocking `subprocess.run` / `Popen` via `asyncio.to_thread`.
   Applied in `deps_check.py` and `render/worker.py`.
2. **Invoke Manim as `[sys.executable, "-m", "manim", "render", ...]`** — never `["manim", ...]`
   (the venv isn't on PATH, so a bare `manim` subprocess fails with `FileNotFoundError`).
   ffmpeg / pdflatex are system tools resolved via PATH — those are fine to call by name.
3. **Worker-thread → event-loop hand-off.** `queue.update_job` broadcasts via
   `asyncio.Queue.put_nowait`, which is only safe on the loop thread. The current worker
   sidesteps this by using a synchronous `subprocess.run` (off-thread) and only calling
   `update_job` from the loop thread. If you add code that updates a job *from* a worker
   thread, marshal it back with `loop.call_soon_threadsafe`.

## Render pipeline

`POST /api/render` (or `/api/render/morph-preview`) → `queue.enqueue(RenderJob)` → the single
background worker (`run_worker`, started in `main.lifespan`) processes one job at a time:
generate script → write `scene.py` under the job dir → run Manim with `-ql` (preview) or `-qh`
(final) → find the newest `*.mp4` excluding `partial_movie_files` → mark job `done`. Progress is
nudged by a ticker task (Manim's stdout is sparse) and pushed to subscribers; the client watches
via `WS /ws/render/{job_id}` and downloads from `/api/render/{job_id}/download`.

`RenderJob.mode` is `"scene"` (normal) or `"morph"` (a 1s standalone `morph_equation` preview).

## Conventions

- IR uses string enums (`ObjectType`, `AnimationVerb`, …). `SceneObject.props` is a free-form
  `dict[str, Any]` — per-type prop models (`ShapeProps`, `GraphProps`, …) exist for documentation
  but the IR stores a plain dict, so adding a new prop needs **no schema change** on either side.
- `new_id()` → 8-char uuid slug for IR entities; `queue.new_job_id()` → 12-char for jobs.
- Times are seconds; the timeline is wall-clock (`start_time` + `duration`).
