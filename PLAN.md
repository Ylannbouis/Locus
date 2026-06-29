# Math Animation Studio — Build Plan & Phases

A GUI-driven 2D math animation editor that wraps **Manim Community Edition**. The user
authors scenes visually (canvas + timeline); a code generator emits Manim Python as a
one-way build artifact. The **JSON scene model (IR) is the single source of truth**.

- Platform: Windows 10, localhost web app for v1 (Electron deferred).
- Stack: React + Vite + Konva + KaTeX + Zustand (frontend); FastAPI + Pydantic + Jinja2 + asyncio (backend); Manim CE via subprocess.
- Out of scope for v1: real-time collaboration, plugin systems, cloud rendering, 3D, raster images, audio/voiceover.

> Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## MVP definition (the spine)

Prove the full pipeline end to end before building breadth: **place a couple of objects →
put a fade and a write-on on a timeline → render an MP4 → download**. Everything else is layered on after the spine works.

---

## Phases

### Phase 0 — Dev environment + project skeleton ✅
- Monorepo structure (`frontend/`, `backend/`, `scripts/`).
- Vite + React + TypeScript frontend; FastAPI backend; Python venv.
- `scripts/setup.ps1` (bootstrap deps) and `scripts/start.ps1` (launch both servers).
- `deps_check.py` + `GET /api/system/deps`; dependency gate in the UI.
- Project file I/O: `GET/POST/PUT /api/projects` storing to `~/MathAnimStudio/projects/`.
- App shell layout + project open/create screen.
- **Checkpoint:** dep check works, project JSON round-trips.

### Phase 1 — Spine: end-to-end pipeline ✅
- Pydantic IR models (`backend/app/models/ir.py`) + matching TypeScript types (`frontend/src/types/ir.ts`).
- Zustand project store with Immer mutations + 50-step undo/redo + autosave.
- Konva canvas: place Rectangle/Circle, drag-to-move, click-select, pan/zoom.
- KaTeX HTML overlay for equations, synced to the canvas view transform.
- Property inspector + timeline strip (one animation per object, sequential).
- Codegen (`backend/app/codegen/`): IR → Manim script (MathTex, Rectangle, Circle; Write/Create/FadeIn/FadeOut).
- Render worker: async Manim subprocess (`python -m manim render -ql`), progress over WebSocket, locate output MP4.
- `POST /api/render`, `WS /ws/render/{job_id}`, `GET /api/render/{job_id}/download`.
- Frontend render panel: trigger, progress bar, inline video, download.
- **Checkpoint:** place objects → animate → render → view/download MP4. ✅ verified end-to-end.

### Phase 2 — Object catalog expansion ✅
- Shapes: Arrow, DoubleArrow, Line, DashedLine, Polygon, Ellipse.
- Coordinate systems: Axes, NumberLine, NumberPlane (approximate Konva canvas preview).
- Function plots: `graph.function_plot` via `axes.plot()`; topological sort so graphs emit after their axes.
- Matrices (KaTeX bmatrix/pmatrix preview).
- Per-term LaTeX coloring (`set_color_by_tex`) UI.
- Outliner panel (object tree, select, z-order, show/hide, delete).
- Full categorized "Add object" panel replacing the simple palette.
- **Checkpoint:** all non-math-specialty objects available. ✅ verified (codegen renders MP4; headless editor mounts + draws all types).

### Phase 3 — Animation system + full timeline UI ✅
- Full keyframe timeline editor: per-object tracks, time ruler with zoom, draggable keyframe blocks (move start / resize duration via right-edge handle), right-click context menu (change verb / duplicate / delete).
- Parallel groups → `AnimationGroup(lag_ratio=…)`; ungrouped keyframes sequence by start_time with `self.wait()` gaps.
- Remaining verbs: Rotate, Scale, Move, FadeOut, DrawBorderThenFill, Indicate, Circumscribe, Flash, Transform/ReplacementTransform (with params: factor / angle / target point / colors / transform target).
- Per-keyframe easing selection with SVG curve preview (KeyframeInspector).
- Relative positioning (`next_to` / `align_to` / `center_on` / `move_to_point`) UI in the Inspector + codegen (emitted after object construction).
- Object grouping/nesting → `VGroup` (Outliner Group/Ungroup, Ctrl+G; nested children; child add/creation handled via the group).
- Multi-select (shift-click + rubber-band on canvas), group drag-move, copy/paste/duplicate (Ctrl+C/V/D), delete (Del).
- Final-quality render trigger (`-qh`, 1080p) with a confirm warning, alongside the 480p preview.
- **Checkpoint:** full animation authoring UX. ✅ verified — codegen for all verbs/groups/relationships compiles and a multi-verb parallel-group scene renders to MP4 ("Played 7 animations").
- Deferred to Phase 5 as planned: the dedicated **camera track** + `camera_move` (MovingCameraScene) codegen.

### Phase 4 — Math-specific features ⬜
- Parametric curves; implicit plots (needs `sympy`); vector fields.
- **Equation morphing** (`TransformMatchingTex`) with a key-map UI + "preview morph" test render. (Flagged as fragile — first-class feature.)
- Animated parameter sweep (`ValueTracker` + `always_redraw`).
- Geometry primitives: Vector (labeled), Angle, Brace; axis labels.
- **Checkpoint:** all math-specific features available.

### Phase 5 — Camera system ⬜
- Dedicated camera track on the timeline (keyframeable pan/zoom/focus).
- Codegen auto-switches base class to `MovingCameraScene`; `camera.frame.animate` moves (zoom = `frame_width / zoom_level`).
- Canvas viewport-rectangle overlay; drag to set pan target; camera reset.
- **Checkpoint:** camera animation integrated.

### Phase 6 — Export, multi-scene, packaging ⬜
- Multiple scenes per project: list panel, add/delete/reorder/duplicate.
- Scene transitions via ffmpeg `xfade`; full-project stitch (`ffmpeg concat`).
- Export formats: GIF, PNG sequence, single-frame still; transparent background (PNG seq).
- Resolution presets (480p/720p/1080p/4K) + custom FPS.
- "Eject to code" (one-way export of the generated `.py`).
- Read-only code/JSON view panel.
- Finalize `setup.ps1`; post-v1 packaging skeleton (PyInstaller + embedded static frontend).
- **Checkpoint:** v1 feature-complete.

---

## Key architecture decisions (carry across all phases)

- **ManimCE**, not ManimGL (stable, documented API).
- **JSON IR is the source of truth**; generated Python is a one-way build artifact (never parsed back). "Eject to code" is one-way.
- **Live preview is an approximation** (Konva shapes + KaTeX equations); Manim is the source of truth only for final output.
- **Every render is an async job** with two quality tiers (preview vs. final) streamed over WebSocket.
- **Camera moves require `MovingCameraScene`** — codegen auto-detects.
- **Scene stitching is ffmpeg**, not Manim.
- **Invoke Manim via `sys.executable -m manim`** (the venv isn't on PATH).

## Environment gotchas

- This machine intercepts HTTPS; Node/npm and pip fail cert verification unless using the Windows cert store. Use `NODE_OPTIONS=--use-system-ca` for npm (Node 22.15+); `setup.ps1` auto-detects this.
- Never run two `npm install` processes in the same directory concurrently.
- System deps (LaTeX/MiKTeX, ffmpeg) must be installed and on PATH; `setup.ps1` handles bootstrap.

---

_The full original planning document (schema details, codegen mapping table, ADR) lives at_
_`C:\Users\lboui\.claude\plans\i-want-to-create-gentle-moler.md`._
