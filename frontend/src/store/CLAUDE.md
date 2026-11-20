# Store — Zustand state (the IR lives here)

| File | Role |
|------|------|
| `projectStore.ts` | The `Project`, selection, undo/redo, autosave, clipboards, grouping, **every IR mutation**, plus the global keyboard shortcuts. |
| `renderStore.ts` | Render / morph-preview job state + the WebSocket progress subscription. |
| `objectFactory.ts` | `newId()`, `uniqueName()`, `copyName()`, per-type `SceneObject` factories, and `withDefaults`/`objectDefaultFor` which layer the project's Object Defaults over the factory output. |
| `objectDefaults.ts` | Registry behind Settings → Object Defaults: one entry per Add-panel button (key, label, category, factory, editable-field list). |
| `finalState.ts` | `computeFinalState(scene)` — bakes a scene's end-of-animation look into a static, timeline-less scene. |
| `canvasStore.ts` | UI-only canvas state: snap-to-center (persisted to `localStorage`), and the mutually exclusive `preview` (read-only playback view) / `record` (Record mode) flags (not persisted). |

`projectStore` mirrors the backend IR exactly and is the source of truth; the canvas, timeline and
inspector are all views onto it.

## Mutation rules

- **All mutations go through `_mutate`** (snapshot → immer `produce` → push to history → mark dirty →
  schedule autosave). Don't mutate `project` outside it, or you break undo/redo and autosave. History
  is capped at `HISTORY_LIMIT` (50); any mutation clears the redo future.
- **`_mutate`'s optional `coalesceKey`** is for edits that fire continuously from one gesture — an
  `<input type="color">` emits a change per pixel dragged, a text field one per keystroke. While the
  same key keeps arriving within `COALESCE_MS` (1.5s) the mutation *replaces* the last history entry
  instead of pushing a new one, so the gesture is one undo step rather than 100 that evict the whole
  stack. Any keyless mutation breaks the chain, and undo/redo reset it (the entry a gesture would have
  merged into is gone). **Pass it from anything driven by a drag or by typing.** `updateObject`,
  `updateKeyframe` and `updateAudioClip` take it as an optional last argument; the three inspectors
  key it by entity + field (`obj:<id>:props:<keys>`, `kf:<id>:start`, `au:<id>:gain`, …) so a burst
  on one field is one step but switching fields starts a new one. A new inspector field that omits
  it silently reintroduces the "typing one equation flushes the whole undo stack" bug.
- **Autosave** is debounced 2s and PUTs the whole project; failures are swallowed (it retries on the
  next change). Manual Save is also available. `save()` adopts the server's response **only if
  `project` is still the object it sent** — an edit made while the PUT was in flight would otherwise
  be reverted by the response (and then persisted by the next autosave).
- **Undo/redo repair the selection** (`_validSelection`): undoing "+ Scene" removes the active scene,
  so `selectedSceneId` falls back to the first scene (else the editor goes blank and every mutation
  no-ops), and selected object ids that no longer exist are dropped.
- **`_mutate` runs `normalizeGroups` after every recipe**: an animation group's members are re-timed to
  when the codegen plays them — the group starts at its earliest member and, with a stagger
  (`lag_ratio > 0`), member *i* starts Σ(previous durations) × lag later (start order, ties in list
  order = Python's stable sort). The codegen ignores members' own starts, so without this a dragged or
  resized member would show a time it never plays at. `updateAnimationGroup` edits `lag_ratio` (and keeps
  `type` = `parallel` / `sequential_lagged` in step); the timeline drags a group as a unit.
- **Auto-intro** (`settings.auto_intro`, editor-only): `addObject` also pushes an intro keyframe for
  any non-group object — Write for text/equations/matrices, Fade In for images, Create otherwise
  (`introVerbFor`) — starting at the end of the scene's last keyframe, 1s long. Only `addObject` does
  this (so the Add panel, including the Axes / angle lines it conjures); paste, duplicate and
  Duplicate final state don't.
- `setSceneTransition(id, tr | null)` sets a scene's `transition_out` (null = export default).
- `upsertKeyframes(kfs)` inserts-or-replaces by id in one mutation — Record mode's commit, so a
  multi-object drag is one undo step.
- Batch deletes are one mutation: Delete on several keyframes calls `removeKeyframes(ids)` (one undo
  entry), not `removeKeyframe` per id.
- Live drag previews (canvas `groupDrag`/`endpointDrag`, timeline drag state) deliberately live
  *outside* the store as component state, and commit **once** on release — one undo entry per gesture.

## Selection

- Selection is multi (`selectedObjectIds`). **Two stores, one selection concept:** selecting a scene
  object clears the timeline's keyframe/audio/break selection (`useTimelineStore.getState().clearKf()`)
  and vice-versa, because the right sidebar shows `Inspector` / `KeyframeInspector` /
  `AudioClipInspector` depending on what is selected.
- Group children are pulled in automatically for copy/duplicate (`withGroupChildren`);
  `cloneObjects` deep-clones with fresh ids and rewires intra-set `parent_id`.
- **Keyboard shortcuts** (registered once at module load): Ctrl+Z/Y undo/redo, Ctrl+C/V/D copy/paste/
  duplicate, Ctrl+G group, Delete/Backspace remove (which also deletes the selected keyframes / audio
  clip / break). They no-op while typing in an input.

## Naming

- `addObject` auto-numbers a repeated default name ("Expression" → "Expression 2") via `uniqueName`.
- `renameCopies` numbers copies with `copyName`: a name that's free is **kept as-is**, so pasting into
  another scene doesn't renumber; otherwise it numbers off the *base* name, making a copy of
  "Rectangle 2" into "Rectangle 3" rather than "Rectangle 2 2".
- **A `text` object's name follows its content** — first non-empty line, capped at 60 chars, numbered
  on collision — recomputed by `updateObject` on every edit. Typing in the Inspector's Name field sets
  `props.name_custom` and freezes it (the field un-greys, `.field__input--auto`); clearing the field
  drops the override and hands the name back to the content. Empty content falls back to "Text N"
  (`autoTextName`).

## Object Defaults (`objectDefaults.ts` + `withDefaults`)

Per-project defaults for what each Add-panel button starts from, stored in
`settings.object_defaults` keyed by Add-panel entry (`"rectangle"`, `"latex_text"`, …). Two rules make
it behave:

- **Overrides are sparse.** Only properties the user actually changed are stored, and `withDefaults`
  shallow-merges them over the factory output at creation time. An untouched property keeps tracking
  the built-in instead of freezing at today's value, "Reset to built-in" is just `delete` on the key,
  and the JSON stays small. **Never store a whole snapshot here.**
- **Only registry-listed fields are reachable**, so a default can't rewrite a `subtype`, point
  geometry or anything else structural. Widening what's editable means adding a field to
  `objectDefaults.ts`, not loosening the merge.

Adding an Add-panel button means adding an entry here too, or it silently opts out of Object Defaults.
Every creation path in `AddPanel` goes through its `mk(key, obj)` helper — including objects the user
didn't click for (the Axes `ensureAxes` conjures for a plot, the two Lines behind an Angle), which is
the difference between a default that mostly works and one that does. `createImage` is the one factory
that takes its default *as an argument*: an image's height is derived from its width and the file's
aspect ratio, so merging a width afterwards would stretch it. Defaults deliberately don't touch
objects already in a scene.

## `computeFinalState` (Duplicate final state)

Returns `{objects, cameraTrack}` — a scene's look after every animation, with no timeline, so each
object carries its end state in its own geometry. Objects faded out and never re-created are dropped
(`endsFadedOut`); a transform/morph **source** is dropped and its target kept (showing the target
statically reproduces the final frame); move/scale/rotate accumulate via `effectiveTransform` (the
same math as the canvas ghosts) and bake into concrete props — scale into `font_size` for text/matrix,
`radius`/`width`/`height`/`corner_radius`/axis lengths elsewhere; rotation into the generic `rotation`
prop (`bakeTransform`, exported — the canvas playback preview bakes every frame with it), **except point-based types** (polygon vertices, line endpoints, `geometry.vector` direction),
which rotate their own points and never carry the prop, mirroring
`canvas/CanvasStage.commitObjectRotation` and the codegen. Graphs and angle/brace need no bake — they
reproduce the final look through the objects they reference. The camera track collapses to the framing
after the last camera move.

`duplicateSceneFinal` wraps it and decides what else carries over: `relationships` and a scene
`background_color` override are copied, the timeline and `audio` are **dropped** (a static snapshot has
no narration).

## Clipboards

`clipboard` (objects) and `audioClipboard` (one audio clip) are separate, and the last copy wins:
`copySelection` clears the audio clipboard, so Ctrl+V always pastes whatever was copied last. The
audio clipboard carries a `projectId` and **refuses to paste into another project**, since assets are
per-project files on the backend. Audio paste lands in the *active* scene at the playhead, so clips
move across scenes.
