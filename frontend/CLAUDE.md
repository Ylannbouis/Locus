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
| `store/objectFactory.ts` | `newId()` + `uniqueName()` (auto-numbers a repeated default name → "Expression 2") + factories that build default `SceneObject`s per type. |
| `store/finalState.ts` | `computeFinalState(scene)` — bakes a scene's end-of-animation look (final position/size/rotation, drops faded-out objects, swaps transform sources→targets, final camera framing) into a static, timeline-less scene for "Duplicate final state". |
| `store/canvasStore.ts` | UI-only canvas prefs (snap-to-center), persisted to `localStorage`. |
| `api/client.ts` | Thin axios wrappers over the REST API + the WS URL helper. Calls same-origin `/api`, `/ws` (proxied). |
| `canvas/` | Konva stage, coordinate model, scene-node rendering, LaTeX overlay, plot/geometry sampling, `motion.ts` (timeline transform math), camera viewport overlay + ghost previews, draggable endpoint handles, center-snapping. |
| `inspector/` | Per-type property editors (right sidebar). |
| `outliner/` | Object tree: select, z-order, show/hide, delete, group/ungroup. |
| `timeline/` | Keyframe timeline UI (incl. dedicated camera + audio tracks) + per-keyframe / per-audio-clip inspectors + its own UI-only store. Overlapping items auto-stack into sub-rows (`packLanes`). `audioPlayback.ts` is the Web Audio preview engine (buffer cache, transport, playhead rAF); `Waveform.tsx` draws clip waveforms from cached per-block peaks. |
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

Shapes render in Konva (`canvas/SceneNodes.tsx`); equations, plain `text`, and matrices render as
KaTeX in an HTML overlay (`canvas/LatexOverlay.tsx`) so they're crisp and selectable. Plot/geometry
sampling (parametric curves, vector fields) is JS-side in `canvas/plotting.ts` for the live preview
only — the *real* curve is produced by Manim at render time.

Three KaTeX-preview rules mirror the codegen (`objects.py`) so the canvas matches the render —
**change them in both places**: a *multi-line equation* is wrapped in `\begin{array}{l|c|r}` per its
`align` prop (or `aligned` when the user writes `&`), because MathTex's `align*` default right-aligns
unmarked lines (`equationTex`); a *`text`* object is LaTeX-escaped (`texEscape` = the backend's
`_tex_escape`, single-pass so a replacement's own braces aren't re-escaped) and rendered as
`\text{…}` with `\textbf`/`\textit` wrappers (`textKatex`); a *matrix* scales its fixed pitch/bracket
constants by `font_size / 48`, mirroring the codegen's `.scale(font_size/48)`.

Coordinate systems draw their tick **numbers** on the canvas when `include_numbers` is set, sized
by a `number_font_size` prop; whole-number ticks render without a trailing `.0` (`fmtNum`). Shapes
and text also honor a generic baked-transform prop **`rotation`** (degrees, CCW) — applied via
Konva/CSS rotation, *negated* since screen rotation is CW while Manim degrees are CCW — so a
"Duplicate final state" scene (which bakes accumulated rotation into `rotation` and scale into the
size props) looks identical to the render. Keep these props in sync with the codegen (`objects.py`
applies `.rotate(rot * DEGREES)`).

## Direct manipulation & snapping (`canvas/SceneNodes.tsx`, `canvas/CanvasStage.tsx`)

- **Line-like shapes** (`line`/`dashed_line`/`arrow`/`double_arrow`) render inside a `<Group>` at
  their `position` so draggable **endpoint handles** share the translation (no lag when the whole
  shape moves). A single `arrow` exposes only its tip (`end_point`); the others expose both ends.
  While an endpoint is dragged, an `endpointDrag` live-override makes the shape follow; release
  commits `start_point`/`end_point` via `updateObject` (one undo entry). Handles keep a constant
  on-screen size (`radius / viewScale`) and are hidden on ghost/preview copies.
- **Snap to center:** dragging an object snaps onto the horizontal/vertical center lines within
  `SNAP_PX` (screen px) of the Manim origin. Konva drags use a shared `dragBoundFunc` (the origin
  sits at the stage's own `x`/`y` in absolute coords); the LaTeX overlay converts `SNAP_PX` to units.
  Toggle via the `.canvas-toolbar` checkbox → `canvasStore.snapToCenter` (persisted). Suppressed
  while several objects are selected.
- **Multi-select drag:** dragging one member of a multi-selection moves the whole set live via a
  shared `groupDrag = {anchorId, dx, dy}` — the dragged anchor is driven by Konva/overlay while every
  *other* selected object (Konva shape **and** overlay equation) renders offset by `(dx, dy)`. The
  anchor keeps its stored position so react-konva doesn't reset it mid-drag (only *changed* props are
  re-applied). Release commits once via `moveObjectsBy` and clears `groupDrag` — **in one
  `flushSync`** so the store move and the offset-clear land in the same render. Otherwise the
  store update (`useSyncExternalStore`) can re-render before the `groupDrag` clear, painting every
  follower at `moved-position + stale-delta` — a teleport in the drag direction.

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
- A **rotate** keyframe can pivot about a fixed scene point instead of the object's center: the
  `about_point` param (also editable in the `KeyframeInspector`). A *lone* selected rotate shows a
  draggable **⊕ pivot handle** — always the HTML `anchorHandle` in `LatexOverlay` (above the Konva
  stage, so it stays grabbable over equations and shapes alike). `motion.ts` orbits the center about
  the anchor (same math as the codegen's `about_point`), so ghosts/final-state stay accurate, and the
  ghost recomputes live while the handle drags (`anchorDrag`). Anchored previews draw violet radius
  lines + the swept arc (`arcPoints`); dropping the handle within `SNAP_PX` of the object's center
  snaps and **clears** `about_point` (back to center rotation).
- The **camera** viewport rectangle (cyan, `CAMERA_ID`-driven) shows the framing of a selected camera
  keyframe, or the scene's initial framing; drag it to set the pan, zoom/Reset live in a floating
  `.camera-hud`. It's suppressed while a move/scale/rotate keyframe is selected.

## Timeline keyframe editing (`timeline/Timeline.tsx`)

- **Group drag:** grabbing a keyframe that's already part of a multi-selection keeps the whole set
  (shift-click toggles membership, mirroring canvas multi-select), and dragging shifts every selected
  keyframe by the anchor's delta (`DragState.members`), clamped so the *earliest* member never crosses
  t=0 — the group's spacing is preserved, never compressed. Release commits once via `moveKeyframesBy`
  (one undo entry). Resize always applies to just the grabbed keyframe.
- **Snap targets** differ by drag kind: a single keyframe snaps against its own lane's edges
  (`edgeTargets`, same object / camera); a group drag snaps the anchor against every keyframe *not*
  being dragged (`edgeTargetsExcluding`), so members don't snap to each other. Same 🧲 toggle /
  Alt-bypass as audio clips (see below).

## Images

- Add Object → Media → 🖼 Image opens a file picker; the file is measured in-browser (aspect
  ratio), uploaded via `uploadImageAsset` (raw bytes, like audio), and `createImage` places a
  4-unit-wide object with `props: { asset, width, height, opacity }`.
- `SceneNodes.ImageNode` renders it as a Konva `Image` (decoded elements cached per URL in
  `imageElementCache`; a dashed placeholder rect with the same size/handlers shows while loading,
  so ghosts/selection/drag work before the decode lands).
- Write/Create/Draw+Fill can't run on a raster image: `timelineVerbsFor('image')` hides them in
  the verb pickers, `defaultVerb` returns `fade_in`, and the backend degrades any that slip
  through to FadeIn.

## Audio track (voiceover)

- `Scene.audio: AudioClip[]` — a clip windows into an uploaded source file via `offset` + `duration`
  (plus `start_time` on the timeline, `gain`/`fade_in`/`fade_out`/`muted`). **Splitting is
  non-destructive**: it makes two clips sharing one asset, so trims can be undone by dragging edges
  back out (left-edge trim shifts `start_time` *and* `offset` together; clamped so `offset ≥ 0` and
  `duration ≤ source_duration − offset`).
- Upload goes straight to `POST /api/projects/{id}/assets/audio` (raw bytes, filename in a query
  param) and then `addAudioClip` places a full-length clip at the playhead. Assets are *files on the
  backend*, referenced by filename — deleting a clip doesn't delete the asset.
- Playback (`audioPlayback.ts`) is editor-only preview: Web Audio schedules one BufferSource+Gain
  per clip (linear fades mirror ffmpeg's `afade`), an rAF loop drives `timelineStore.playhead`, and
  the ruler is a scrub bar (pointer-capture drag; resumes playback on release if it was playing).
  The canvas does not animate during playback — the backend ffmpeg mix is the render truth.
- The playhead line + toolbar readout are separate components subscribing to `playhead`, so 60fps
  updates don't re-render the whole timeline. Timeline selection is exclusive three ways: keyframes
  vs audio clip vs scene object (`clearKf()` clears both timeline kinds; the right sidebar shows
  `AudioClipInspector` / `KeyframeInspector` / `Inspector` accordingly).
- **Audio clipboard**: Ctrl+C on a selected clip (or right-click → Copy) fills
  `projectStore.audioClipboard`; Ctrl+V pastes into the *active* scene at the playhead (or
  right-click the audio lane → "Paste clip here"), so clips move across scenes. `copySelection`
  (objects) clears the audio clipboard — Ctrl+V always pastes whatever was copied last. The
  clipboard carries a `projectId` and refuses to paste into another project (assets are per-project
  files). Ctrl+D duplicates the selected clip.
- **Snapping** (`timelineStore.snapEnabled`, 🧲 toolbar toggle, persisted to `localStorage`, Alt
  bypasses): while dragging/trimming/resizing, the dragged edge snaps within `SNAP_PX` (8px) to the
  edges of *same-lane* items (same object's keyframes / other audio clips), t=0, and the playhead.
  Targets are captured once at drag start (`edgeTargets`) into the drag state.

## Scenes & export (Phase 6)

- A project has multiple `scenes`; `ScenePanel` does add/delete/duplicate/reorder/inline-rename via
  store actions (`addScene`/`removeScene`/`duplicateScene`/`duplicateSceneFinal`/`moveScene`/`renameScene`).
  `duplicateSceneFinal` snapshots the scene's end-of-animation state (via `computeFinalState`, relationships
  kept, timeline dropped) into a new scene. `selectedSceneId` is the active scene; always keep ≥1 scene.
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
