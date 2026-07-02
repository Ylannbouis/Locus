# Codegen — IR `Scene` → Manim Python script

Transpiles a `Scene` (from `models/ir.py`) into a runnable Manim script via Jinja2. Pure string
generation: no Manim import here, the output is *text*. The generated `MasScene(Scene)` class is
run by the render worker.

## Files

| File | Role |
|------|------|
| `template.py` | The Jinja2 scaffold + `SCENE_CLASS_NAME = "MasScene"`. `render_script(body, background_color, base_class="Scene")` — `base_class` becomes `MovingCameraScene` when the scene uses the camera. Construct body is pre-indented (8 spaces) and injected; imports numpy fns (`sin`, `cos`, …) so plot expressions can use them bare. |
| `objects.py` | `emit_object(obj) -> (var, lines)`: Mobject construction + styling + placement, per object type/subtype. |
| `animations.py` | `emit_animation(verb, var, params, var_map) -> expr`: one **object** verb → the inner expression of a `self.play(...)`. `emit_transform_chain(var, items)` fuses simultaneous move/scale/rotate into one chained `.animate`. (Camera verbs are handled in `scene.py`, not here.) |
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
to un-hide at. Not needed in the sequential model (adds are per-play).

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
  (like move/scale/rotate) should also be added to `_XFORM_ANIM` + `emit_transform_chain` so it fuses
  when simultaneous; an introducer verb interacts with the hide-until-creation pass above.
- A verb that can't emit (e.g. a transform with a missing target, or a camera move with no
  resolvable pan/focus) returns `None`; the scene builder drops it. Preserve that contract.
