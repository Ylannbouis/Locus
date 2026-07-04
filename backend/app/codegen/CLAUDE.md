# Codegen — IR `Scene` → Manim Python script

Transpiles a `Scene` (from `models/ir.py`) into a runnable Manim script via Jinja2. Pure string
generation: no Manim import here, the output is *text*. The generated `MasScene(Scene)` class is
run by the render worker.

## Files

| File | Role |
|------|------|
| `template.py` | The Jinja2 scaffold + `SCENE_CLASS_NAME = "MasScene"`. `render_script(body, background_color, base_class="Scene")` — `base_class` becomes `MovingCameraScene` when the scene uses the camera. Construct body is pre-indented (8 spaces) and injected; imports numpy fns (`sin`, `cos`, …) so plot expressions can use them bare. Also holds the `MasIntro` helper (a creation animation that applies a partial move/scale/rotate after each frame), emitted into the script only when the body references it. |
| `objects.py` | `emit_object(obj) -> (var, lines)`: Mobject construction + styling + placement, per object type/subtype. |
| `animations.py` | `emit_animation(verb, var, params, var_map) -> expr`: one **object** verb → the inner expression of a `self.play(...)`. `emit_transform_chain(var, items)` fuses simultaneous move/scale/rotate into one chained `.animate`; `emit_intro_transform(...)` fuses a creation verb with such a cluster into a `MasIntro(...)` call. (Camera verbs are handled in `scene.py`, not here.) |
| `scene.py` | Orchestrator: `build_body` / `generate_scene_script` / `generate_morph_preview_script`. Ties objects + relationships + timeline + camera together. |

## Key conventions

- **Variable naming is deterministic and id-based.** `var_name(obj_id)` → `m_<sanitized_id>`;
  `tracker_name(obj_id)` → `t_<sanitized_id>`. This lets objects reference each other by id
  alone (an Angle references its two line objects, a Brace its target, a graph its axes) without
  passing live references around. `var_map: dict[obj_id -> var]` is threaded through codegen.
- **LaTeX/string safety:** always emit user strings with `repr()` (`{tex!r}`) so backslashes in
  LaTeX survive. Numeric/expression coercion goes through `_num`, `_expr`, `_range`, `_point`,
  `_np` helpers — use them rather than raw f-string interpolation of untrusted props.
- **Plot expressions are Python/numpy**, evaluated inside `lambda x: (...)`. `_range` clamps a
  non-positive step to 1.0 (a `<= 0` step makes Manim's tick generation hang/raise) and renders whole
  numbers without a trailing `.0` (`_fmt_num`) so Manim's `NumberLine` infers **0 decimal places** for
  integer tick steps (it reads the step's *string* form — `1.0` → one decimal).
- **Generic baked transforms:** `emit_object` applies a `rotation` prop (degrees, CCW) as
  `.rotate(rot * DEGREES)` after placement; scale is baked into the concrete size props by the frontend.
  Axes/number_line pass `number_font_size` through to their `font_size` / `axis_config`.

## Images (`image` object type)

- `emit_object(obj, assets_root)` — the optional `assets_root` (the project's assets dir,
  computed in `generate_scene_script` via `_assets_root`) is joined with `props.asset` and baked
  into `ImageMobject({path!r})` as an **absolute path** (the script runs from a per-job dir).
  Sizing uses `stretch_to_fit_width/height` (both dims stored, non-uniform stretch representable).
- **Skip guards**: an image with an empty `asset`, or whose file is missing on disk (checked only
  when `assets_root` is given), is dropped like other unresolvable objects.
- **`Group` vs `VGroup`**: `VGroup` rejects an `ImageMobject`; a group that (transitively)
  contains an image emits `Group(...)` instead (`image_group_ids` in `build_body`).
- **Verb normalization**: Write/Create/DrawBorderThenFill need VMobject points and raise on a
  raster image — `build_body` rewrites them to FadeIn (still a creation verb, so the
  hide-until-creation pass is unaffected). The frontend hides these verbs for image lanes too.

## Emit order (`scene._emit_order`) — matters

Objects are emitted in dependency order so references resolve:
`0` plain objects → `1` graphs (need their axes) → `2` geometry (may reference shapes/targets) →
`3` groups (need children defined first). Per-type **skip guards** drop objects whose
dependencies are missing/hidden:
- axes-bound graphs (`function_plot`/`parametric`/`implicit`, see `AXES_BOUND_GRAPHS`) skip if
  `axes_ref` isn't in `var_map`; `vector_field` is standalone (no axes).
- an `angle` skips unless both `line1_id`/`line2_id` exist; a `brace` skips unless `target_id` exists.

## Placement semantics (subtle — see `objects.py` comments)

- Point-based shapes (line/arrow/double_arrow/dashed_line/polygon) and `geometry.vector` keep
  points in **local space** and use `.shift(position)`.
- `graph.*` has **no independent position** — it follows its axes.
- Coordinate systems align their **data midpoint** to `position` via `c2p`/`number_to_point`
  (not `.move_to`, which would center Manim's full bbox including tips/numbers/labels and shift
  the axes off the intended spot).
- Everything else uses `.move_to(position)`.

## Timeline → `self.play` calls (`scene.build_body`)

1. Define + style every visible object (skip-guarded).
2. Apply relationships (`next_to`/`align_to`/`center_on`/`move_to_point`).
3. `self.add()` objects that are present from frame 0 — i.e. *not* introduced by a creation verb
   (`CREATION_VERBS`) and *not* a Transform target (those are pulled in by the transform), and
   not a group child (the group's VGroup represents them).
4. Lay out the timeline. **Two emission models** (`uses_tracking` picks):
   - **Timeline model (default):** every animation becomes a track in one
     `self.play(AnimationGroup(…, lag_ratio=0))`. Each animation carries its own `run_time`+`rate_func`
     (baked in by `_bake`), and a `Succession(Wait(delay), anim)` offsets its start — so animations
     **overlap exactly as laid out on the timeline** (different start *and* end times, across objects).
     A `group_id` set becomes a nested `AnimationGroup(…, lag_ratio=…)` track; **sweeps** become tracks.
     The whole group is shifted so the first animation is at t=0 (a leading `self.wait` covers the offset).
   - **Sequential model (when the scene uses continuous camera tracking):** one `self.play()` per time
     slot with `self.wait()` gaps — the camera-follow updater needs add/remove **statements** timed
     *between* plays, which a single play can't express. Here keyframes sharing a `group_id` *or* a
     `start_time` collapse into one parallel play; tracking emits **statement events** (`kind: "stmt"`).
   Both route each animation through `_kf_anim` (camera → `_camera_anim`, object → `emit_animation`), via
   `_merge_units`, which **fuses same-object move/scale/rotate that overlap in time** into one chained
   `.animate` over the union window (`emit_transform_chain`) — two separate `.animate`s on one mobject
   fight over its state. Applies to ungrouped tracks and parallel (`lag_ratio == 0`) groups; staggered
   groups and non-overlapping transforms stay separate.
   A **fade** (fade_in/fade_out) that overlaps a same-object transform is fused into that same chain as a
   trailing `.set_opacity(1.0/0.0)` — a standalone `FadeIn`/`FadeOut` alongside `m.animate…` is a second
   animation on the same mobject and they cancel (the `.animate` target holds opacity where the fade wants
   to change it; a hidden object's restore-target `Transform` also double-fades). `_plan_fade_fusion`
   picks the fade keyframes to fuse (`fused_fade_ids`, threaded into `_merge_units`) and the objects a
   fused **fade_in introduces** (`fade_in_prehide` — pre-hidden with `set_opacity(0)` in *both* models so
   the fused `.set_opacity(1)` actually reads); such a fade_in skips the `reveal_kf`/restore-target path
   since the explicit `.set_opacity` makes the plain `.animate` correct on its own. Fusion is per play
   bucket (ungrouped / parallel group), same as the transform merge.
   A **drawing creation verb** (write/create/draw_border_then_fill) that overlaps a same-object transform
   cluster likewise fuses — into one **`MasIntro`** (template helper): the creation animation subclassed to
   apply the partial move/scale/rotate *after* each frame's interpolation. That composes cleanly because
   creation animations rebuild the mobject from their captured start state every frame; running the
   introducer and a `Transform` as two animations on one mobject fights (or, chained into a `Succession`,
   pops the object in fully visible, moves it, then wipes and redraws it — the original bug). `MasIntro`
   runs over the union window with `intro_span`/`xform_span` fractions locating each part; the intro's
   easing is its `rate_func` (drives the drawing), the cluster's easing is `xform_rate`. Planned by
   `_plan_intro_fusion` (same bucket rules; one intro per cluster; a cluster already fusing a *fade* keeps
   the fade and the intro stays standalone — an Animation-class intro can't join an `.animate` chain).
   In `_object_tracks` a `MasIntro` unit is never rebuilt as a `Transform`, but its chain still advances
   the accumulating target base; if the object was hidden (see 2b) a `Restore(m, run_time=0.001)` is
   emitted immediately before it instead of the standalone reveal wrapping.
   **One track per mobject (`_object_tracks`).** Manim can't run two animations on one mobject in a
   single `self.play`: two `m.animate` share the mobject's `.target` (built eagerly at construction, so
   the later builder clobbers the earlier — the first animation renders as nothing), and two
   Animation-class anims fight each frame. So after `_merge_units`, each mobject's several units are
   chained into **one** `Succession(seg, Wait(gap), seg, …)` track (an object that fades in + moves, then
   later fades out + moves, must run its two clusters *in sequence*). A `.animate` cluster is rebuilt as an
   explicit `Transform(m, tN)` with **independent, accumulating** target copies — `t1 = m.copy()<chain1>`,
   `t2 = t1.copy()<chain2>`, … emitted as setup statements before the play — so the targets don't share
   `m.target` and each cluster composes onto the previous (relative `.shift`s accumulate). Single-unit
   objects keep their inline `.animate`. The sequential (camera-tracking) model is naturally safe here —
   it emits a separate `self.play` per time slot, so same-mobject clusters never share one play.
5. `_bake(expr, run_time, rate_func)` inserts timing into an animation expression so it can live inside
   an `AnimationGroup`/`Succession`: `.animate.m(…)` → `.animate(run_time=…, rate_func=…).m(…)`; an
   Animation-class call gets the kwargs inserted before the final `)`. Hold the final frame with a
   trailing `self.wait`.

**Hide-until-creation (`build_body` step 2b, timeline model only).** An object introduced by a
*delayed* creation verb (Write/Create/…) that is otherwise pre-added by Manim at t=0 pops into view
before its creation plays — a `Succession(Wait, <non-introducer>)` exposes the mobject in the play's
`AnimationGroup` (each group's `mobject` is the `Group` of its *non-introducer* children). This
happens when the object **or any ancestor group** is animated by a non-introducer (fade-out, move,
…) — a group's own animation pulls its whole `VGroup` (including a not-yet-created child) into the
play (`_exposed_early` walks the `parent_id` chain). Fix: `save_state()` +
`set_opacity(0)` those objects up front (after relationships), then wrap the creation track as
`Succession(Restore(m, run_time=0.001), <introducer>)` so opacity is restored the instant the
introducer draws it in (no flash, keeps the write/draw effect). `reveal_kf_id` records which keyframe
to un-hide at. On a start-time tie the creation verb sorts first (a write + move starting at the same
instant still introduce via the write); a reveal keyframe fused into a `MasIntro` stays in the normal
merge flow (the fused unit carries its own leading `Restore`). Not needed in the sequential model
(adds are per-play).

**Restore-target transforms (paired with the hide pass).** A move/scale/rotate uses `.animate`, whose
auto-generated target is a `.copy()` of the mobject *at play-construction time* — when a hidden object
still has `set_opacity(0)`. So a plain `m.animate.shift(v)` on a hidden object (or on a **group that
contains one**, since `m_G.animate` copies its whole family) bakes opacity 0 into the target and fades
the object out when the transform runs — the object *disappears*. Fix: those transforms emit an explicit
`Transform(m, m.copy().restore()<chain>)` (`emit_transform_chain(..., restore_target=True)`) so the
target is the object's *saved* (fully-visible) state with the same methods applied — behaviour-identical
to `.animate` except the opacity is correct. `restore_ids` (hidden objects + all their ancestor groups,
built next to `reveal_kf_id`) selects which transforms get this; a transformed ancestor **group** also
needs its own `save_state()` emitted *before* its children are hidden, so `m_G.copy().restore()` recovers
each child's real opacity. Threaded through `_merge_units` / `_kf_anim_r`. Empty in the sequential model.

## Camera (Phase 5)

Camera keyframes reuse the normal `Keyframe` with the sentinel `object_id == CAMERA_ID`
(`"__camera__"`) and verb `camera_move`; params are `pan {x,y}` (or `focus_object_id` to target an
object's center) + an absolute `zoom` (and `track: true` for continuous follow). **No IR schema
change** — it's all in the free-form `params` dict.

- `_uses_camera(scene)` → any camera keyframe or a non-default `camera_track`. Drives the
  `base_class` choice in `generate_scene_script` and the initial-framing emission in `build_body`.
- `_camera_anim(kf, var_map)` → a one-shot `self.camera.frame.animate.move_to(…).set(width=config.frame_width / zoom)`
  (focus → `<objvar>.get_center()`). Width is only emitted when `zoom` is present, so a pure pan
  keeps the current zoom. `_zoom()` clamps non-positive/garbage zoom to 1.0 (guards `/ 0`).
- **Continuous tracking** (`_is_track_kf`): emits a follow-updater over the keyframe's window as two
  statement events — `add_updater` at `start` (`order` 0, before same-time plays) and
  `remove_updater` at `start+duration` (`order` 2, after). **GOTCHA:** the start statement must run
  `self.add(self.camera.frame)` *before* `add_updater` — the frame's updater only fires during
  `self.play()` while the frame is in the scene's mobject list, otherwise the camera silently stays
  put. (One-shot focus moves are explicit animations and don't need this.)
- Initial framing (`camera_track.initial_pan/zoom`) is emitted as step 0 of `build_body`
  (`self.camera.frame.move_to/set`).

## Adding a new object type / verb / subtype

- New **object subtype**: add a branch in `objects._emit_construct` (and styling/placement if it
  differs), plus the frontend factory + inspector + canvas node. No IR schema change needed if it
  only adds props (props are a free-form dict).
- New **animation verb**: add to `AnimationVerb` (both `ir.py` and `ir.ts`), handle it in
  `emit_animation` (object verbs) or `_camera_anim`/`_kf_anim` (camera verbs), and add to
  `CREATION_VERBS` if it introduces the object to the scene. A new `.animate`-based transform verb
  (like move/scale/rotate) should also be added to `_XFORM_ANIM` + `emit_transform_chain` (and folded
  in `emit_intro_transform`/`MasIntro` if it can overlap a creation) so it fuses when simultaneous;
  a new *drawing* introducer verb belongs in `INTRO_VERBS` + `_SIMPLE` so it fuses with overlapping
  transforms, and interacts with the hide-until-creation pass above.
- A verb that can't emit (e.g. a transform with a missing target, or a camera move with no
  resolvable pan/focus) returns `None`; the scene builder drops it. Preserve that contract.
