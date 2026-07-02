# Math Animation Studio (MAS)

A localhost GUI editor that wraps **Manim Community Edition**. Users compose 2D math
animation scenes visually; the app generates a Manim Python script and renders it to MP4.
No Python authoring required from the user.

## Architecture

```
frontend (React + Konva + KaTeX)  ──REST/WS──>  backend (FastAPI)
                                                      │ codegen (IR → Manim .py)
                                                      ▼
                                              Manim CE (subprocess) ──> MP4
```

**The JSON IR is the single source of truth** — not the generated Python. The generated
script is a disposable build artifact; never treat it as canonical or hand-edit it.

Data flow: the React stores hold a `Project` object → autosaved as JSON via `PUT /api/projects/{id}`
→ on render, the backend codegen transpiles the IR `Scene` to a Manim script → the render
worker runs it as a subprocess and streams progress over WebSocket → the client downloads the MP4.

## Layout

| Path | What | More |
|------|------|------|
| `frontend/` | Vite + React + TS editor (Konva canvas, Zustand stores) | `frontend/CLAUDE.md` |
| `backend/` | FastAPI app: REST/WS API, codegen, render queue, storage | `backend/CLAUDE.md` |
| `backend/app/codegen/` | IR → Manim Python transpiler (the subtle core) | `backend/app/codegen/CLAUDE.md` |
| `scripts/` | Windows PowerShell bootstrap + launch scripts | below |

The IR schema is defined twice and **must be kept in sync by hand**: Pydantic models in
`backend/app/models/ir.py` and TypeScript types in `frontend/src/types/ir.ts`. There is no
codegen between them. When you change one, change the other.

## Running (Windows)

- `./scripts/setup.ps1` — one-time bootstrap: installs ffmpeg/MiKTeX via winget, creates the
  Python venv at `backend/.venv/`, installs Manim + npm packages.
- `./scripts/start.ps1` — launches backend (uvicorn `--reload`) and frontend (vite) each in
  its own window, then opens http://localhost:5173.

Vite proxies `/api/*` and `/ws/*` to `http://localhost:8000` (see `frontend/vite.config.ts`),
so the frontend talks to same-origin paths and CORS is configured for `localhost:5173`.

Projects are stored as human-readable JSON at `~/MathAnimStudio/projects/<id>/project.json`;
renders land under `.../<id>/renders/<job_id>/`.

## Platform constraints (important)

This project targets **Windows 10** and the dev servers run on the Windows asyncio
**SelectorEventLoop** (especially under `--reload`). Two rules fall out of that:

- **Never use `asyncio.create_subprocess_exec`** in the backend — it raises `NotImplementedError`
  (with an *empty* message) on the SelectorEventLoop. Run blocking `subprocess.run` via
  `asyncio.to_thread` instead. See `backend/CLAUDE.md`.
- **Invoke Manim as `[sys.executable, "-m", "manim", ...]`**, never a bare `"manim"` — the venv
  is not activated, so `manim.exe` is not on PATH.

`scripts/run-in-job.ps1` wraps each dev-server window in a Windows **Job Object**
(`KILL_ON_JOB_CLOSE`) so closing the window kills the whole child tree — this is what makes
uvicorn `--reload` safe (no orphaned reloader/worker processes).

## Status

Phases 0–6 complete (v1 feature-complete). Highlights beyond the basics: the **camera system**
(keyframeable pan/zoom/focus on a dedicated timeline track, continuous object tracking, codegen
auto-switching to `MovingCameraScene`); live **transform previews** on the canvas (faded ghosts of
where a selected move/scale/rotate keyframe lands, stacking earlier transforms, with a draggable
destination handle for moves); and **export / multi-scene** (multiple scenes per project with a
reorderable `ScenePanel`, whole-project stitching via ffmpeg concat/crossfade, MP4 / GIF / PNG-
sequence / still output at selectable resolution+fps, transparent background, eject-to-code +
read-only code/JSON view). The backend can also serve the built frontend (`frontend/dist`) for
single-process running. See `README.md` for the milestone table; `PLAN.md` for the full spec.

Post-v1 editor/codegen refinements: on-canvas **axis tick numbers** (with editable size); **direct
manipulation** — draggable line/arrow **endpoint handles** and **snap-to-center** (toggleable);
**auto-numbered** duplicate default names; **"Duplicate final state"** (snapshot a scene's end-of-
animation look into a static scene); timeline **sub-rows** for simultaneous same-object animations,
which the codegen **fuses** into one chained `.animate` (move+scale+rotate that overlap in time); and
a codegen fix so objects created part-way through don't pop in before their creation animation.

**Voiceover / audio track**: each scene has an `audio: AudioClip[]` track — upload an audio file
(stored under the project's `assets/` dir), place clips on a dedicated timeline lane with waveforms,
drag/trim/split (non-destructive: clips window into the source via `offset`+`duration`), per-clip
volume/fades/mute, and Web Audio playback in the editor with a scrubbable playhead. On mp4 export
the render worker mixes the clips under the video with an ffmpeg filtergraph (codegen/Manim never
see audio); multi-scene stitching stays audio-aware (silent tracks for stream parity).
