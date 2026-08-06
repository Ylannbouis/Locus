# Backend — FastAPI + codegen + render worker

Python ≥ 3.10, FastAPI + Pydantic v2 + Jinja2 + asyncio. No database, no Redis/Celery —
storage is JSON files on disk and the render queue is an in-process `asyncio.Queue`.

## Module map (`app/`)

| Module | Responsibility |
|--------|----------------|
| `main.py` | FastAPI app: all routes + the WebSocket progress stream. Launches the render worker in the lifespan. |
| `models/ir.py` | **Canonical IR schema.** Every other module imports from here. Mirror of `frontend/src/types/ir.ts`. |
| `storage/projects.py` | Load/save/delete `Project` JSON under `~/MathAnimStudio/projects/`. `delete_project` rmtrees the whole project dir, and is the one place that validates the id against a regex + asserts the target is a direct child of the root (traversal would be destructive here). |
| `deps_check.py` | Verifies manim/ffmpeg/latex are available; cached in-memory per process. |
| `codegen/` | IR `Scene` → Manim Python script. See `codegen/CLAUDE.md`. |
| `render/queue.py` | In-process job registry + pub/sub for progress events. |
| `render/worker.py` | Pulls jobs, runs Manim as a subprocess, locates the output MP4. |
| `render/slideshow.py` | Slideshow packaging: copies the per-scene mp4s into a player folder and generates the single-file `index.html` (+ `manifest.json`), then zips it. The player holds between slides by *pausing* a `<video>`, so there is no ffmpeg work here — and a scene's `breaks` are the same trick *inside* a slide (`_slide_breaks` clamps them to the probed duration; the player's rAF loop pauses on each until the next click). |
| `render/stitch.py` | ffmpeg `concat_scenes` / `crossfade_scenes` (xfade) for multi-scene export, `zip_dir` for PNG sequences, `probe_duration` (ffprobe). All via blocking `subprocess.run` (see rule 1). |
| `render/audio.py` | ffmpeg voiceover mixing: trims/gains/fades/delays each `AudioClip` and muxes the mix under a scene mp4 (video copied, AAC 44.1kHz stereo — fixed params so concat can stream-copy). When a clip runs past the video, the last frame is held (`tpad`, forcing a video re-encode) so the scene ends on the later of last-animation / last-audio instead of truncating the voiceover. |

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
   Applied in `deps_check.py`, `render/worker.py`, and `render/stitch.py` (ffmpeg/ffprobe).
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
background worker (`run_worker`, started in `main.lifespan`) processes one job at a time. For each
scene to render: generate script → write `scene.py` under the job dir → run Manim (`_build_cmd`:
`-ql`/`-qh` + optional `--resolution`/`--fps`/`--format`/`-s`/`-t`) → locate the output
(`_find_output` is format-aware). Progress is nudged by a ticker (Manim's stdout is sparse) and
pushed to subscribers; the client watches via `WS /ws/render/{job_id}` and downloads from
`/api/render/{job_id}/download` (media type inferred from the file suffix).

- `RenderJob.scene_id` is a specific scene, or **`None` = every scene**. Multi-scene **mp4** jobs
  render each scene then stitch (`crossfade_scenes` when `transition`, else `concat_scenes`); other
  formats / morph render a single scene.
- `RenderJob.format` ∈ `mp4 | gif | png | still | slideshow`. `png` returns the frame *directory*,
  which the worker zips for download; `still` uses `-s` (last frame); `transparent` adds `-t`
  (non-mp4 only).
- **`slideshow`** (for `Project.kind == "slideshow"`) renders every scene as an ordinary mp4 —
  same Manim flags as `mp4`, no `--format` — and then packages them instead of stitching:
  `job_dir/slideshow/` (player folder, kept for Present mode) + `job_dir/slideshow.zip` (the
  download). Audio is mixed per slide, with no silent-track padding: nothing is concatenated, so
  stream parity doesn't matter.
- `RenderJob.mode` is `"scene"` (normal) or `"morph"` (a 1s standalone `morph_equation` preview).

**Assets**: `POST /api/projects/{id}/assets/audio` and `.../assets/image` upload a file (raw bytes
body + `?filename=` query param — deliberately no multipart, so no `python-multipart` dep) into the
project's `assets/` dir; audio returns `{filename, duration, name}` (ffprobe), image `{filename, name}`.
`GET .../assets/{filename}` serves either kind. Image assets are referenced by `image` objects and
baked into the generated script as absolute `ImageMobject` paths (see `codegen/CLAUDE.md`). After Manim renders an mp4, the worker mixes each scene's `Scene.audio` clips under the
video (`render/audio.py`) — codegen and the ejected script never see audio. When stitching, scenes
without clips get a *silent* AAC track so the concat demuxer sees uniform streams, and
`crossfade_scenes` delays+amixes the per-scene tracks to match the video offsets.

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
