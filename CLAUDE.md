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
| `scripts/` | Bootstrap + launch + package scripts: PowerShell (`*.ps1`, Windows) and shell (`*.sh`, macOS/Linux), hand-mirrored pairs | `scripts/CLAUDE.md` |

The IR schema is defined twice and **must be kept in sync by hand**: Pydantic models in
`backend/app/models/ir.py` and TypeScript types in `frontend/src/types/ir.ts`. There is no
codegen between them. When you change one, change the other.

## Running

**Windows:**
- `./scripts/setup.ps1` — one-time bootstrap: installs ffmpeg/MiKTeX via winget, creates the
  Python venv at `backend/.venv/`, installs Manim + npm packages.
- `./scripts/start.ps1` — launches backend (uvicorn `--reload`) and frontend (vite) each in
  its own window, then opens http://localhost:5173.

**macOS (and Linux):**
- `bash scripts/setup.sh` — same bootstrap via Homebrew (ffmpeg + MacTeX, plus `cairo`/`pkg-config`,
  which macOS needs because pycairo ships Windows-only wheels and must compile). Creates the venv at
  `backend/.venv/` — note the interpreter is `backend/.venv/bin/python` here, **not**
  `Scripts\python.exe`. Requires Python **3.11–3.13**: the pinned `pydantic==2.9.0` has no
  `pydantic-core` wheels past cp313, so 3.14 fails to install. The script probes for a supported
  interpreter rather than trusting bare `python3`, and recreates an out-of-range venv.
- `bash scripts/start.sh` — runs both dev servers as background jobs of one shell; a
  `trap … kill 0` on Ctrl+C/exit tears down the whole process group (the Unix stand-in for the
  Windows Job Object — see the platform note below), then opens http://localhost:5173.

**Both OSes:** `./scripts/package.ps1` / `bash scripts/package.sh` — single-process packaging
step 1: `vite build` → `frontend/dist`, which the backend mounts so one uvicorn on :8000 serves
the whole app (no Vite). The ps1 also has a `-PyInstaller` backend-bundle skeleton.

The backend Python is platform-agnostic already (it uses `sys.executable -m manim`, `Path.home()`,
and off-thread `subprocess.run`), so only the `scripts/` layer and the venv path differ by OS.
Per-script details (incl. the rule that every `.ps1` and its `.sh` twin must be kept in sync by
hand): `scripts/CLAUDE.md`.

Vite proxies `/api/*` and `/ws/*` to `http://localhost:8000` (see `frontend/vite.config.ts`),
so the frontend talks to same-origin paths and CORS is configured for `localhost:5173`.

Projects are stored as human-readable JSON at `~/MathAnimStudio/projects/<id>/project.json`;
renders land under `.../<id>/renders/<job_id>/`.

## Platform constraints (important)

The app runs on **Windows 10** and **macOS** (and, with manual dep install, Linux). The backend
code is written to be portable; the two rules below come from Windows but are safe everywhere, so
**keep following them** rather than special-casing per-OS:

- **Never use `asyncio.create_subprocess_exec`** in the backend — it raises `NotImplementedError`
  (with an *empty* message) on the Windows asyncio **SelectorEventLoop** that uvicorn uses under
  `--reload`. Run blocking `subprocess.run` via `asyncio.to_thread` instead (this also works fine
  on macOS/Linux). See `backend/CLAUDE.md`.
- **Invoke Manim as `[sys.executable, "-m", "manim", ...]`**, never a bare `"manim"` — the venv
  is not activated, so its `manim` entrypoint is not on PATH. `sys.executable` is the venv's
  Python on both OSes (`…/Scripts/python.exe` vs `…/bin/python`), so this resolves correctly.

**Process-tree cleanup for `--reload`:** on Windows `scripts/run-in-job.ps1` wraps each dev-server
window in a **Job Object** (`KILL_ON_JOB_CLOSE`); on macOS/Linux `scripts/start.sh` runs both
servers in one shell and traps Ctrl+C/exit to `kill 0` (the process group). Either way, stopping
the launcher kills the whole child tree so no orphaned reloader/worker/node processes leak.

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
manipulation** — draggable line/arrow **endpoint handles**, **snap-to-center** (toggleable), and
**rotate handles** on any rotatable object (a rotate-only Transformer gizmo / HTML handle setting
the baked `rotation` prop, or baking into points for polygons/vectors);
**auto-numbered** duplicate default names; **"Duplicate final state"** (snapshot a scene's end-of-
animation look into a static scene); timeline **sub-rows** for simultaneous same-object animations,
which the codegen **fuses** into one chained `.animate` (move+scale+rotate that overlap in time); a
codegen fix so objects created part-way through don't pop in before their creation animation; and
**creation+transform fusion** — a Write/Create/DrawBorderThenFill overlapping a move/scale/rotate on
the same object emits one `MasIntro` composite (the object draws in *while* it moves), instead of two
animations fighting over one mobject. Newer still: a plain **`text` object type** ("Text & Math" in the
Add panel — LaTeX-escaped prose via `Tex`, bold/italic, KaTeX-mirrored preview); **multi-line equation
alignment** (l/c/r via an `array` wrap, since MathTex's `align*` default right-aligns unmarked lines);
**matrix font size** (emitted as `.scale(font_size/48)`); timeline **group-drag** of multi-selected
keyframes (one shared delta, one undo entry); and a **rotation pivot** — rotate keyframes take an
optional `about_point` (scene coords → Manim's `about_point`), placed by dragging a ⊕ handle on the
canvas, with the ghost preview orbiting accurately about it. Also **rounded rectangles** (an opt-in
`corner_radius` prop; 0 keeps a plain `Rectangle`, > 0 emits `RoundedRectangle` clamped to half the
shorter side) and **system fonts for `text` objects** (a `font` prop switches codegen from LaTeX
`Tex` to Pango `Text`, listed by `GET /api/fonts` — see `backend/app/codegen/CLAUDE.md`).

**Images**: an `image` object type places an uploaded raster file (png/jpg/webp/bmp) on the
canvas — uploaded to the project's `assets/` dir like audio, rendered via `ImageMobject` with the
absolute asset path baked into the script. Vector-only verbs (Write/Create/Draw+Fill) degrade to
FadeIn for images, and a group containing an image emits Manim's `Group` instead of `VGroup`.

**Slideshow projects**: `Project.kind` is `animation` (default — scenes stitch into one video)
or `slideshow`, chosen in the New Project form and fixed thereafter. In a slideshow each scene is
a **slide**: it plays, freezes on its last frame, and the next one starts on a click. Slides are
never stitched. The `slideshow` render *format* renders every scene to its own mp4 and packages
them with a generated single-file HTML player (`backend/app/render/slideshow.py` → `index.html` +
`manifest.json` + `slides/slide_NN.mp4`, zipped for download); the unzipped folder stays in the
job dir so the editor's **Present** mode (`frontend/src/components/Presenter.tsx`) can stream the
slides from `/api/render/{job_id}/slides[/{i}]`. The "hold" between slides is just a paused
`<video>`, so no ffmpeg padding is involved. `Scene.auto_advance` skips the click for one slide.
`Scene.breaks` (`SceneBreak[]`, timestamps in seconds) are **mid-slide** stops: the slide renders as
one continuous mp4 and the player pauses it at each break until the next click — same trick as the
end-of-slide freeze, so breaks cost no render time and never reach codegen. They show in the
timeline as amber dashed verticals alongside the red playhead, and dragging one is a **ripple edit**
— every keyframe, audio clip and later break that starts at or after it moves along, so a segment's
length is set by dragging its end (see `frontend/CLAUDE.md`).
The in-app presenter and the exported player deliberately mirror each other's controls —
**change both together**.

**Voiceover / audio track**: each scene has an `audio: AudioClip[]` track — upload an audio file
(stored under the project's `assets/` dir), place clips on a dedicated timeline lane with waveforms,
drag/trim/split (non-destructive: clips window into the source via `offset`+`duration`), per-clip
volume/fades/mute, and Web Audio playback in the editor with a scrubbable playhead. On mp4 export
the render worker mixes the clips under the video with an ffmpeg filtergraph (codegen/Manim never
see audio); multi-scene stitching stays audio-aware (silent tracks for stream parity).
