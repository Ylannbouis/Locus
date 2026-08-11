# Canvas — Konva stage + KaTeX overlay

The live preview of a scene. Two rendering layers share **one view transform** (scale + offset) so
shapes and equations stay aligned:

| File | Role |
|------|------|
| `CanvasStage.tsx` | Stage host: view (pan/zoom), selection, ghost previews, camera overlay + HUD, rotation commits. |
| `SceneNodes.tsx` | Konva nodes for shapes / coordinate systems / graphs / images, endpoint + rotate handles. |
| `LatexOverlay.tsx` | HTML layer: KaTeX for equations/matrices, styled HTML for Pango `text`, plus the HTML handles (rotate, move, ⊕ pivot). |
| `coords.ts` | Coordinate model + the empirically calibrated size constants. |
| `motion.ts` | Timeline transform math for previews (editor-only). |
| `plotting.ts` | JS sampling of parametric curves / vector fields (preview only). |
| `geometry.ts` | Axes geometry, brace/vector label anchors, segment intersection. |

These are **editor-only aids**. The backend codegen is the source of truth for the real animation;
JS-side plot sampling only approximates what Manim will draw.

## Coordinates (`coords.ts`)

`PX_PER_UNIT = 80`. Manim space is units, y-up, origin center; world space is pixels, y-down. The
frame guide is Manim's 16:9 camera frame (`FRAME_WIDTH`/`FRAME_HEIGHT`). Equation sizing and matrix
spacing use calibrated constants (`MANIM_EM_UNITS_PER_PT`, `MANIM_TEXT_EM_UNITS_PER_PT`,
`MATRIX_H_PITCH`/`MATRIX_V_PITCH`/`MATRIX_BRACKET_BUFF`) so the preview matches Manim's actual
layout width — **adjust these only against a measured Manim render, not by eye.**

## Mirror rules (change here *and* in `backend/app/codegen/objects.py`)

The preview matches the render only because these are duplicated deliberately:

- **Multi-line equation** → wrapped in `\begin{array}{l|c|r}` per its `align` prop (or `aligned`
  when the user writes `&`), because MathTex's `align*` default right-aligns unmarked lines
  (`equationTex`).
- **`text` object** → LaTeX-escaped (`texEscape` = the backend's `_tex_escape`, **single-pass** so a
  replacement's own braces aren't re-escaped) and rendered as `\text{…}` with `\textbf`/`\textit`
  wrappers (`textKatex`).
- **Matrix** → fixed pitch/bracket constants scaled by `font_size / 48`, mirroring the codegen's
  `.scale(font_size/48)`.
- **Multi-line `text`** (the textarea stores real newlines) → the codegen's `tabular{l}` becomes
  KaTeX's math-mode twin, `\begin{array}{l}` of `\text{…}` rows. One difference: an empty line needs
  `\phantom{X}` or KaTeX collapses the row where LaTeX's row strut holds it open. Single-line content
  stays a bare `\text{…}`, matching the codegen. `objectBounds` measures the widest line and scales
  height by row count (`text` breaks on `\n`, `latex_text` on `\\`).
- **Baked `rotation`** (degrees, CCW) → applied via Konva/CSS rotation, **negated**, since screen
  rotation is CW while Manim degrees are CCW. Codegen emits `.rotate(rot * DEGREES)`.
- **Tick numbers** → drawn when `include_numbers` is set, sized by `number_font_size`; whole-number
  ticks render without a trailing `.0` (`fmtNum`), matching the codegen's `_fmt_num`.

**Pango fonts leave KaTeX entirely.** A `text` object with a `font` prop is previewed as plain styled
HTML in that system font, because the codegen emits Pango `Text(font=…)` there. `textFont` gates both
the renderer and the em constant — `MANIM_TEXT_EM_UNITS_PER_PT` = 1/72 units per point for Pango vs
`MANIM_EM_UNITS_PER_PT` for LaTeX; `line-height: 1.3` mirrors Manim's line spacing. Since the browser
and Pango lay out the *same* font file, matching the em is enough to match glyph advances.

## Direct manipulation & snapping

- **View navigation:** two-finger/wheel scroll **pans**, pinch (delivered as `ctrl`+wheel) **zooms**,
  shift+scroll pans horizontally, and a discrete mouse wheel **zooms** with no modifier. Device kind
  is inferred from the delta shape (pixel-mode, fractional, or any `deltaX` ⇒ trackpad) and the
  verdict is **sticky** in a ref, so a fast two-finger flick can't be mistaken for a wheel notch
  mid-gesture. **Drag-to-pan** is middle-button or **Alt+left**, captured on the container div
  (`pointerdown` *and* `mousedown`, both in the capture phase) so it works over objects — Konva drags
  on mousedown, the overlay on pointerdown, so swallowing only one leaks the gesture through.
  **Never `preventDefault()` the pointerdown**: that suppresses the compatibility mouse events the
  drag is driven by, so no mouseup arrives and the pan sticks to the cursor. The toolbar's **Fit**
  button re-runs the mount-time fit (the way home from a pan into empty space).
- **Endpoint handles:** line-like shapes (`line`/`dashed_line`/`arrow`/`double_arrow`) render inside a
  `<Group>` at their `position` so handles share the translation (no lag when the whole shape moves).
  A single `arrow` exposes only its tip (`end_point`); the others expose both ends. While dragging, an
  `endpointDrag` live-override makes the shape follow; release commits `start_point`/`end_point` via
  `updateObject` (one undo entry). Handles keep a constant on-screen size (`radius / viewScale`) and
  are hidden on ghost/preview copies.
- **Rotate handles** (lone selection only): Konva-rendered rotatable objects (rectangle/ellipse/
  polygon, coordinate systems, `geometry.vector`) get a rotate-only `Transformer` (`Rotatable` —
  border + rotate anchor, no resize); LaTeX/text/matrix get an equivalent HTML handle in
  `LatexOverlay`, a child of the rotating wrapper so it orbits like Konva's anchor (live angle via
  `rotDrag`). Both snap to quarter turns within 4°. Release commits once
  (`CanvasStage.commitObjectRotation`): center-based types store the `rotation` prop **plus the node
  position** (the Transformer pivots on the bbox center); **point-based types bake into their points
  instead** (polygon vertices, vector `direction`) and never carry the prop — mirroring
  `store/finalState.ts` and the codegen. Lines/arrows have no rotate handle (endpoints already set
  orientation); circles (no-op), graphs (follow axes) and angle/brace (anchored) are excluded.
- **Click-through selection:** clicking the same spot again selects the next object *below* the one
  the click landed on, wrapping at the bottom — the way to reach something covered without moving
  anything. `pickCycle` does its own hit test with `objectBounds` (**not** Konva's hit graph), so
  overlay equations and Konva shapes form one stack, ordered topmost-first by `z_index` then scene
  order. The walk continues only while clicks stay within `CYCLE_PX` and the selection is still what
  the last click made it; anything else restarts at the top. Both layers route through
  `handleSelect`, whose `kind` separates a **press** (only ensures something is selected so it can be
  dragged — and must not reset a parked walk, `cycleHolds`) from a **click** (which walks). A drag
  always ends with the dragged object selected, since the following click lands away from the parked
  spot and restarts the walk.
- **Snap to center:** dragging snaps onto the horizontal/vertical center lines within `SNAP_PX`
  (screen px) of the Manim origin. Konva drags use a shared `dragBoundFunc` (the origin sits at the
  stage's own `x`/`y` in absolute coords); the overlay converts `SNAP_PX` to units. Toggled via the
  `.canvas-toolbar` checkbox → `store/canvasStore.snapToCenter` (persisted). Suppressed while several
  objects are selected.
- **Multi-select drag:** dragging one member moves the whole set live via a shared
  `groupDrag = {anchorId, dx, dy}` — the anchor is driven by Konva/overlay while every *other*
  selected object (shape **and** overlay equation) renders offset by `(dx, dy)`. The anchor keeps its
  stored position so react-konva doesn't reset it mid-drag (only *changed* props are re-applied).
  Release commits once via `moveObjectsBy` and clears `groupDrag` — **in one `flushSync`** so the move
  and the offset-clear land in the same render. Otherwise the store update
  (`useSyncExternalStore`) can re-render before the clear, painting every follower at
  `moved-position + stale-delta`: a teleport in the drag direction.

## Timeline previews & camera overlay (`motion.ts`, `CanvasStage.tsx`)

- `effectiveTransform(scene, objId, time)` accumulates every move/scale/rotate keyframe *before*
  `time` (in `start_time` order, mirroring Manim's sequential play) into `{pos, scale, rotationDeg}`.
  `transformAfter(scene, kf)` returns `{before, after}` for one keyframe, so previews **stack** prior
  transforms. `effectivePosition` (= `.pos`) feeds the camera-focus overlay.
- Selecting **move/scale/rotate** keyframes (`PREVIEW_VERBS`) shows a faded **ghost** at each one's
  resulting transform (`previewItems` — one per selected keyframe, so shift-selecting several shows
  several; `Ghost.key` keeps React keys unique). Holding **Space** with one object selected previews
  *all* its transform keyframes. Konva shapes render inside a `<Group>` pivoted about the object's
  center; equations/matrices via the overlay's `ghosts` prop (CSS `rotate(${-deg})` — negate, as
  above). Moves also draw a direction arrow; a *lone* selected move is draggable (Konva circle for
  shapes, HTML handle for LaTeX/matrix) → `updateKeyframe` commits the new `target_position`/`delta`.
- A **rotate** keyframe may pivot about a fixed scene point via its `about_point` param. A lone
  selected rotate shows a draggable **⊕ pivot handle** — always the HTML `anchorHandle` in
  `LatexOverlay` (above the Konva stage, so it stays grabbable over equations and shapes alike).
  `motion.ts` orbits the center about the anchor with the same math as the codegen's `about_point`, so
  ghosts and final-state stay accurate, and the ghost recomputes live while dragging (`anchorDrag`).
  Anchored previews draw violet radius lines + the swept arc (`arcPoints`); dropping the handle within
  `SNAP_PX` of the object's center snaps and **clears** `about_point` (back to center rotation).
- The **camera** viewport rectangle (cyan, `CAMERA_ID`-driven) shows the framing of a selected camera
  keyframe, or the scene's initial framing; drag it to set the pan, zoom/Reset live in a floating
  `.camera-hud`. Suppressed while a move/scale/rotate keyframe is selected.

## Images

`SceneNodes.ImageNode` renders an `image` object as a Konva `Image`, with decoded elements cached per
URL in `imageElementCache`. While a decode is in flight it draws a dashed placeholder rect with the
**same size and handlers**, so ghosts, selection and dragging all work before the image lands.
