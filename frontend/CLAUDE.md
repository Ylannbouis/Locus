# Frontend — Vite + React + TypeScript editor

The visual editor. Holds the `Project` IR in Zustand stores, renders the scene on a Konva canvas
(shapes) with a KaTeX HTML overlay (equations), and talks to the backend over the Vite proxy.

Stack: React 19 + react-konva + zustand + immer + katex + axios. Dev server on **5173**
(`strictPort` — fails loudly rather than drifting to 5174). Scripts: `npm run dev` / `build`
(`tsc -b && vite build`) / `lint`.

## Layout (`src/`)

| Path | What |
|------|------|
| `types/ir.ts` | **TS mirror of `backend/app/models/ir.py`.** Keep in sync by hand — no codegen between them. |
| `store/projectStore.ts` | Main Zustand store: the `Project`, selection, undo/redo, autosave, clipboard, grouping, all IR mutations. Plus global keyboard shortcuts. |
| `store/renderStore.ts` | Render/morph-preview job state + WebSocket progress subscription. |
| `store/objectFactory.ts` | `newId()` + factories that build default `SceneObject`s per type. |
| `api/client.ts` | Thin axios wrappers over the REST API + the WS URL helper. Calls same-origin `/api`, `/ws` (proxied). |
| `canvas/` | Konva stage, coordinate model, scene-node rendering, LaTeX overlay, plot/geometry sampling. |
| `inspector/` | Per-type property editors (right sidebar). |
| `outliner/` | Object tree: select, z-order, show/hide, delete, group/ungroup. |
| `timeline/` | Keyframe timeline UI + per-keyframe inspector + its own UI-only store. |
| `components/` | `DepGate` (blocks until deps OK), `ProjectHome`, `EditorShell` (layout), `AddPanel`, `RenderPanel`. |

`App.tsx`: `DepGate` → (`EditorShell` if a project is loaded, else `ProjectHome`).

## State model

`projectStore` is the source of truth and mirrors the backend IR exactly. Rules:

- **All mutations go through `_mutate`** (snapshot → immer `produce` → push to history → mark
  dirty → schedule autosave). Don't mutate `project` outside it, or you break undo/redo and
  autosave. History is capped at 50 entries (`HISTORY_LIMIT`); any mutation clears the redo future.
- **Autosave** is debounced 2s and PUTs the whole project; failures are swallowed (it retries on
  the next change). Manual Save is also available.
- **Two stores, one selection concept:** selecting a scene *object* clears the timeline keyframe
  selection and vice-versa (`useTimelineStore.getState().clearKf()`), because the right sidebar
  shows the `Inspector` or the `KeyframeInspector` depending on what's selected.
- Selection is multi (`selectedObjectIds`). Group children are pulled in automatically for
  copy/duplicate (`withGroupChildren`); `cloneObjects` deep-clones with fresh ids and rewires
  intra-set `parent_id`.
- Keyboard shortcuts (registered once at module load): Ctrl+Z/Y undo/redo, Ctrl+C/V/D copy/
  paste/duplicate, Ctrl+G group, Delete/Backspace remove. They no-op while typing in an input.

## Canvas ↔ Manim coordinates (`canvas/coords.ts`)

The Konva stage and the KaTeX overlay share **one view transform** (scale + offset) so shapes
and equations stay aligned. `PX_PER_UNIT = 80`. Manim space is units, y-up, origin center; world
space is pixels, y-down. The frame guide is Manim's 16:9 camera frame (`FRAME_WIDTH/HEIGHT`).
Equation sizing and matrix spacing use empirically-calibrated constants (`MANIM_EM_UNITS_PER_PT`,
`MATRIX_*`) so the canvas preview matches Manim's actual layout width — adjust these only against
a measured Manim render, not by eye.

Shapes render in Konva (`canvas/SceneNodes.tsx`); equations and matrices render as KaTeX in an
HTML overlay (`canvas/LatexOverlay.tsx`) so they're crisp and selectable. Plot/geometry sampling
(parametric curves, vector fields) is JS-side in `canvas/plotting.ts` for the live preview only —
the *real* curve is produced by Manim at render time.

## When changing the IR

Edit **both** `types/ir.ts` and `backend/app/models/ir.py`, then update the relevant
factory (`objectFactory.ts`), inspector editor, and canvas node. New props need no backend
schema change (props is a free-form dict end-to-end) but still need a TS type + UI to be editable.
