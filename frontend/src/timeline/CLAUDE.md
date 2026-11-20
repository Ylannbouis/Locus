# Timeline — keyframe / camera / audio lanes

| File | Role |
|------|------|
| `Timeline.tsx` | The whole grid: ruler, per-object lanes, camera + audio lanes, all drag/resize/snap logic, break flags. |
| `timelineStore.ts` | UI-only state: selections (`selectedKfIds` / `selectedAudioId` / `selectedBreakId`), `pxPerSec`, `playhead`, `playing`, `snapEnabled`. Also `timelineVerbsFor(obj)`. |
| `KeyframeInspector.tsx` | Right-sidebar editor for the selected keyframe(s) — verb params, timing, easing, `about_point`. |
| `AudioClipInspector.tsx` | Right-sidebar editor for the selected audio clip (gain, fades, mute, trim). |
| `audioPlayback.ts` | Web Audio preview engine: buffer cache, transport, playhead rAF loop. |
| `Waveform.tsx` | Draws clip waveforms from cached per-block peaks. |

Timeline selection is **exclusive three ways** — keyframes vs audio clip vs break — and `clearKf()`
clears all of them; selecting a scene object clears them too (see `store/CLAUDE.md`). The right
sidebar shows `KeyframeInspector` / `AudioClipInspector` / `Inspector` accordingly.

`timelineVerbsFor` takes the whole `SceneObject`, not just its type, so it can read props: **Type On**
is offered only for a `text` object with a `font` prop (Pango), and Write/Create/Draw+Fill are hidden
for `image` lanes (`defaultVerb` returns `fade_in` there).

## Layout — two coordinate origins, and it matters which one you're in

- Things drawn across the **whole grid** (`.tl__playhead`, `.tl__break`) are children of `.tl__grid`
  and must offset by `LABEL_W` **by hand**.
- Things drawn inside **one lane or the ruler** (`.tl__kf`, `.tl__tick`, `.tl__break-flag`) are placed
  at a bare `time * pxPerSec` and get the offset from their parent's position in the flex row. That
  only works while the parent is a containing block — hence `position: relative` on **both**
  `.tl__lane` and `.tl__ruler`. Drop it from the ruler and its ticks and break flags escape to
  `.tl__row--head` (sticky *is* positioned) and paint exactly one label column too far left, which is
  how the break flags once drifted off the amber lines they're supposed to sit on.

**The label column is pinned with `position: sticky`, and each lane is a flex row** (`.tl__row` =
label + lane) rather than a cell pair in one grid. A sticky box is clamped to its containing block,
which for a grid item is its grid area — so as a grid cell the 150px label could never slide right and
simply scrolled away once the timeline was wider than the viewport. Keep the row structure (and
`--tl-label-w`, which feeds the flex basis from `LABEL_W`) if you touch this layout.

Overlapping items in one lane auto-stack into **sub-rows** (`packLanes`), which is what lets two
simultaneous animations on one object be seen and edited — the codegen then *fuses* them (see
`backend/app/codegen/CLAUDE.md`).

## Keyframe editing

- **Group drag:** grabbing a keyframe that's already part of a multi-selection keeps the whole set
  (shift-click toggles membership, mirroring canvas multi-select), and dragging shifts every selected
  keyframe by the anchor's delta (`DragState.members`), clamped so the *earliest* member never crosses
  t=0 — the group's spacing is preserved, never compressed. Release commits once via `moveKeyframesBy`
  (one undo entry). **Resize always applies to just the grabbed keyframe.**
- **Lane order:** an object label (⠿ grip) is a drag handle — dragging it up/down moves that object's
  slot in `scene.objects` (`reorderObject`), which is the order lanes stack in *and* the order the
  codegen emits (so it also breaks `z_index` ties). Row geometry is measured once at drag start
  (`ObjDragState.rows`, from the `data-obj-row` labels) and the insertion point follows the pointer's Y
  against each row's midpoint; the drop shows as an inset line on the row it would go before.

## Snapping (`snapEnabled`, 🧲 toolbar toggle, persisted; **Alt** bypasses)

While dragging/trimming/resizing, the dragged edge snaps within `SNAP_PX` (8px) to the edges of
*same-lane* items, t=0, and the playhead. Targets are captured **once at drag start** into the drag
state — recomputing mid-drag would let items snap to their own moved edges. Which targets depends on
the drag kind:

- single keyframe → its own lane's edges (`edgeTargets`, same object / camera);
- group drag → every keyframe **not** being dragged (`edgeTargetsExcluding`), so members don't snap to
  each other;
- break drag → the ripple riders are excluded (their edges move *with* the break).

## Audio track (voiceover)

- `Scene.audio: AudioClip[]` — a clip windows into an uploaded source file via `offset` + `duration`
  (plus `start_time`, `gain`, `fade_in`, `fade_out`, `muted`). **Splitting is non-destructive**: it
  makes two clips sharing one asset, so trims can be undone by dragging edges back out. Left-edge trim
  shifts `start_time` **and** `offset` together, clamped so `offset ≥ 0` and
  `duration ≤ source_duration − offset`.
- Upload goes straight to `POST /api/projects/{id}/assets/audio` (raw bytes, filename in a query
  param), then `addAudioClip` places a full-length clip at the playhead. Assets are *files on the
  backend*, referenced by filename — **deleting a clip doesn't delete the asset.**
- `audioPlayback.ts` is editor-only preview: Web Audio schedules one BufferSource+Gain per clip
  (linear fades mirror ffmpeg's `afade`), an rAF loop drives `timelineStore.playhead`, and the ruler
  is a scrub bar (pointer-capture drag; resumes playback on release if it was playing). The same
  transport drives the **canvas playback preview**: ▶ and ruler scrubs set `canvasStore.preview`, and
  the canvas animates from `playhead` (see `canvas/CLAUDE.md`). Playback runs even with no audio
  clips — the rAF loop just advances the playhead to the end of the content. The backend render (and
  its ffmpeg mix) remains the truth.
- The playhead line and the toolbar readout are separate components subscribing to `playhead`, so
  60fps updates don't re-render the whole timeline. Keep it that way.

## Breaks (slideshow projects only)

`scene.breaks: SceneBreak[]` are mid-slide stops — playback pauses at that timestamp and waits for a
click. The **⏸ Break** button adds one at the playhead (as does double-clicking the ruler); each
renders as an amber dashed vertical spanning the whole grid (`.tl__break`, the playhead's twin) with a
draggable ⏸ flag in the sticky ruler (`.tl__break-flag`). Drag to move, right-click to delete,
Delete/Backspace removes the selected one. Store actions are `addBreak` / `moveBreak` / `removeBreak`;
`addBreak` refuses a duplicate within 0.01s and keeps the list sorted. Breaks never reach codegen —
they only ride along in the slide manifest for the players.

**Moving a break is a ripple edit** (`moveBreak`, so drag *and* "Move to playhead"): everything
starting at or after it — keyframes, camera included, audio clips, later breaks — shifts by the same
delta in one undo entry. A break is a segment boundary, so this re-times the segment before it and
leaves later ones intact; moving it alone would just squeeze the next segment. Riders are chosen by
**start time**, so an animation that *spans* the break stays put (it can't be split across a pause).
Two clamps are applied **identically** in the store and in `startBreakDrag`'s `lowerBound`, so the live
preview can't promise a move the commit would refuse: no rider may cross t=0, and a break may not pass
the break before it (which stays put, so crossing would silently reorder the segments). While
dragging, `withRipple` offsets every rider's block live.
