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
| `canvas/` | Konva stage, coordinate model, scene-node rendering, LaTeX overlay, plot/geometry sampling, `motion.ts` (timeline transform math), camera viewport overlay + move/scale/rotate ghost previews. |
| `inspector/` | Per-type property editors (right sidebar). |
| `outliner/` | Object tree: select, z-order, show/hide, delete, group/ungroup. |
| `timeline/` | Keyframe timeline UI (incl. a dedicated camera track) + per-keyframe inspector + its own UI-only store. |
| `components/` | `DepGate` (blocks until deps OK), `ProjectHome`, `EditorShell` (layout), `AddPanel`, `ScenePanel` (multi-scene list), `RenderPanel` (export options), `CodeView` (eject-to-code / JSON modal). |

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

## Timeline previews & camera overlay (`canvas/CanvasStage.tsx`, `canvas/motion.ts`)

These are **editor-only** aids — they reflect the timeline but never touch the render (the backend
codegen is the source of truth for the actual animation).

- `motion.ts` `effectiveTransform(scene, objId, time)` accumulates every move/scale/rotate keyframe
  *before* `time` (in `start_time` order, mirroring Manim's sequential play) into `{pos, scale,
  rotationDeg}`. `transformAfter(scene, kf)` returns `{before, after}` for one keyframe. So previews
  **stack** prior transforms. `effectivePosition` (=`.pos`) feeds the camera-focus overlay.
- Selecting **move/scale/rotate** keyframes shows a faded **ghost** at each one's resulting transform
  (`previewItems` — one per selected transform keyframe, so shift-selecting several shows several;
  `Ghost.key` keeps React keys unique when an object has multiple). Holding **Space** with one object
  selected previews *all* its transform keyframes. Konva shapes render inside a `<Group>` pivoted about
  the object's center; equations/matrices via the `LatexOverlay` `ghosts` prop (CSS `rotate(${-deg})` —
  CSS/Konva rotation is CW on screen while Manim degrees are CCW in math space, so **negate**). Moves
  also draw a direction arrow; a *lone* selected move is draggable (Konva circle for shapes; an HTML
  handle for LaTeX/matrix) → `updateKeyframe` commits the new `target_position`/`delta`. (Multi-select
  + Backspace deletes all selected keyframes via the projectStore keydown handler.)
- The **camera** viewport rectangle (cyan, `CAMERA_ID`-driven) shows the framing of a selected camera
  keyframe, or the scene's initial framing; drag it to set the pan, zoom/Reset live in a floating
  `.camera-hud`. It's suppressed while a move/scale/rotate keyframe is selected.

## Scenes & export (Phase 6)

- A project has multiple `scenes`; `ScenePanel` does add/delete/duplicate/reorder/inline-rename via
  store actions (`addScene`/`removeScene`/`duplicateScene`/`moveScene`/`renameScene`). `selectedSceneId`
  is the active scene; always keep ≥1 scene.
- `RenderPanel` builds a `RenderOptions` (format mp4/gif/png/still, resolution preset, fps, transparent,
  crossfade) and calls `renderStore.triggerRender(projectId, sceneId|null, opts)` — **`sceneId === null`
  renders & stitches all scenes** (mp4 only; the panel disables "all scenes" for other formats). Quality
  is derived from resolution (480p → `preview`, else `final`). Download extension/preview adapts to the
  job's `format` (mp4 → `<video>`, gif/still → `<img>`, png → zip download).
- `CodeView` shows the ejected Manim Python (`getSceneScript`, saved first so the backend sees the
  latest IR) and the project JSON, read-only — the JSON is the source of truth, code export is one-way.

## When changing the IR

Edit **both** `types/ir.ts` and `backend/app/models/ir.py`, then update the relevant
factory (`objectFactory.ts`), inspector editor, and canvas node. New props need no backend
schema change (props is a free-form dict end-to-end) but still need a TS type + UI to be editable.
