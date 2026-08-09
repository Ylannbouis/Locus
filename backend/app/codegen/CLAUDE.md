# Codegen — IR `Scene` → Manim Python script

Transpiles a `Scene` (from `models/ir.py`) into a runnable Manim script via Jinja2. Pure string
generation: no Manim import here, the output is *text*. The generated `MasScene(Scene)` class is
run by the render worker.

## Files

| File | Role |
|------|------|
| `template.py` | The Jinja2 scaffold + `SCENE_CLASS_NAME = "MasScene"`. `render_script(body, background_color, base_class="Scene")` — `base_class` becomes `MovingCameraScene` when the scene uses the camera. Construct body is pre-indented (8 spaces) and injected; imports numpy fns (`sin`, `cos`, …) so plot expressions can use them bare. Also holds the helper classes, each emitted into the script only when the body references it: `MasApply`/`MasFade` (all move/scale/rotate transforms and all fades — see "Fades & transforms" below) and `MasIntro` (a creation animation that applies a partial move/scale/rotate after each frame). |
| `objects.py` | `emit_object(obj) -> (var, lines)`: Mobject construction + styling + placement, per object type/subtype. |
| `animations.py` | `emit_animation(verb, var, params, var_map) -> expr`: one **object** verb → the inner expression of a `self.play(...)`. Fades emit `MasFade(var, alpha)`; `emit_transform_chain(var, items, opacity)` fuses simultaneous move/scale/rotate (and an overlapping fade's target opacity) into one `MasApply(var, lambda _m: _m.shift(…)…, opacity=…)`; `emit_intro_transform(...)` fuses a creation verb with such a cluster into a `MasIntro(...)` call. (Camera verbs are handled in `scene.py`, not here.) |
| `scene.py` | Orchestrator: `build_body` / `generate_scene_script` / `generate_morph_preview_script`. Ties objects + relationships + timeline + camera together. |

## Key conventions

- **Variable naming is deterministic and id-based.** `var_name(obj_id)` → `m_<sanitized_id>`;
  `tracker_name(obj_id)` → `t_<sanitized_id>`. This lets objects reference each other by id
  alone (an Angle references its two line objects, a Brace its target, a graph its axes) without
  passing live references around. `var_map: dict[obj_id -> var]` is threaded through codegen.
- **LaTeX/string safety:** always emit user strings with `repr()` (`{tex!r}`) so backslashes in
  LaTeX survive. Numeric/expression coercion goes through `_num`, `_expr`, `_range`, `_point`,
  `_np` helpers — use them rather than raw f-string interpolation of untrusted props.
- **Multi-line `latex_text` alignment:** MathTex defaults to LaTeX's `align*` environment, which
  *right-aligns* lines carrying no `&`. Multi-line MathTex content (has `\\`, no `&`) is wrapped in
  `\begin{array}{l|c|r}` per the `align` prop (default center); a user's own `&` wins (no wrap).
  The frontend KaTeX preview mirrors this exactly (`equationTex` in `canvas/LatexOverlay.tsx`).
- **`text` objects** (plain prose) emit `Tex(...)` in LaTeX text mode: the raw string goes through
  `_tex_escape` — a *single-pass* char map, so a replacement's own braces (`\textbackslash{}`)
  aren't re-escaped — then optional `\textit`/`\textbf` wrappers. Mirrored by `texEscape`/
  `textKatex` in the frontend overlay. Styling/placement is the same as `latex_text`
  (`set_color`, `.move_to`).
- **`text` line breaks:** the inspector's textarea stores real `\n`s, but LaTeX collapses a raw
  newline to a space — so multi-line content is emitted as `\begin{tabular}{l}…\\…\end{tabular}`
  (one row per line, each escaped/bold/italic-wrapped separately). `{l}` because that matches the
  left alignment Pango gives for free; LaTeX's built-in row strut keeps the leading even and lets
  a blank line stay a blank row, so no explicit `\strut` is needed. **Single-line content keeps
  the bare `Tex('…')` form** — wrapping it would change its bbox and hence the vertical centering
  of every existing text object. The Pango path needs none of this (`Text` breaks on `\n`).
- **`text` fonts — two mobjects, one object type.** A non-empty `font` prop switches emission from
  `Tex` to Manim's Pango-backed **`Text(raw, font=…, weight=…, slant=…)`**, the only mobject that
  takes an arbitrary system font (LaTeX fonts are a preamble/`TexTemplate` affair, not a kwarg).
  On that path the string is **not** escaped (Pango draws it literally, so no LaTeX may appear in
  it) and bold/italic become Pango `weight="BOLD"` / `slant="ITALIC"` instead of `\textbf`/
  `\textit`. The two paths also have **different em scales** — a Pango em is `font_size/72` scene
  units vs the LaTeX calibration in `coords.ts` — so the canvas preview picks its constant per
  path (`MANIM_TEXT_EM_UNITS_PER_PT` / `MANIM_EM_UNITS_PER_PT`) and previews a `font` object as
  plain styled HTML rather than KaTeX. The picker only offers fonts `GET /api/fonts` reports, i.e.
  what this machine's Pango can actually resolve; an unknown name would silently fall back.
- **Pango text is always built at `PANGO_REF_FONT_SIZE` (48) and `.scale()`d** to the authored
  `font_size` — never pass a small size straight to `Text(font_size=…)`. Pango hints and grid-fits
  glyph *advances* at whatever size it rasterizes, and below roughly 24pt that quantization is a
  large fraction of an advance. The errors don't cancel: adjacent letters land too far apart or
  overlap outright (measurably negative inter-glyph gaps), which reads as shattered word spacing —
  `font_size=8` Chalkduster rendered "pending" as "pen d in g", and a zoomed-in camera magnifies it.
  At 48 the intra-word gap spread drops ~6× and no gap goes negative. The scale is exact, so the
  mobject's **height is bit-identical** to the direct build and no vertical centering shifts; only
  the (previously compressed) width changes. `font_size == 48` emits no `.scale()` at all, so the
  common case is byte-for-byte what it was. Same `/48` convention as the Matrix path below.
- **`type_on` (typewriter reveal) — Pango text only.** Emits `AddTextLetterByLetter`: whole glyphs
  appear one at a time, each already filled. It exists because Write/Create *stroke-trace* the glyph
  outline before filling, and a textured font (Chalkduster & co. — 213 subpaths for one 9-character
  word) traces as grey scribble for the whole animation. `ShowIncreasingSubsets` reveals one
  **submobject** per step, which only means "one letter" for a Pango `Text`; a `Tex` is a single
  submobject and would pop in whole, so `build_body` **degrades `type_on` → `write`** for anything
  that isn't a `text` object with a `font` prop (`_is_pango_text`) — the IR can carry a stale
  `type_on` after the user clears `font`. That pass runs *before* the image→FadeIn degrade, so an
  image inherits it. `type_on` is in `CREATION_VERBS` and `INTRO_VERBS` but deliberately **not in
  `_SIMPLE`**, which is what gates MasIntro fusion: `AddTextLetterByLetter` swaps
  `mobject.submobjects` each frame instead of rebuilding from a captured start state, so MasIntro's
  post-frame `m.shift(delta * t)` would accumulate every frame and fling the text off screen.
  `emit_intro_transform` returns None for it, so `_plan_intro_fusion`'s dry-run never marks it
  fused. An overlapping move/scale/rotate therefore stays a separate unit — and `_object_tracks`
  chains it *after* the type-on in the object's single `Succession` instead of running both at once.
- **Matrix font size:** Manim's `Matrix` has no `font_size` kwarg, so a non-default `font_size`
  prop emits `.scale(font_size/48)` — glyphs, spacing and brackets grow together. The canvas
  preview scales its fixed pitch/bracket constants by the same factor.
- **Plot expressions are Python/numpy**, evaluated inside `lambda x: (...)`. `_range` clamps a
  non-positive step to 1.0 (a `<= 0` step makes Manim's tick generation hang/raise) and renders whole
  numbers without a trailing `.0` (`_fmt_num`) so Manim's `NumberLine` infers **0 decimal places** for
  integer tick steps (it reads the step's *string* form — `1.0` → one decimal).
- **Generic baked transforms:** `emit_object` applies a `rotation` prop (degrees, CCW) as
  `.rotate(rot * DEGREES)` after placement; scale is baked into the concrete size props by the frontend.
  Axes/number_line pass `number_font_size` through to their `font_size` / `axis_config`.
- **Rotation pivot:** a rotate keyframe may carry an `about_point` param (`{x,y}`, scene coords);
  it emits Manim's `about_point=np.array(…)` on every rotate path (`_rotate_call`: the `.animate`
  branch and the fused `MasApply` chain) and flows into `MasIntro` as `rotate_about` — applied
  *after* the shift there, because a fixed-point pivot doesn't commute with a move (the chain's
  convention is move first, then orbit the anchor; `motion.ts` in the frontend mirrors this by
  orbiting the object's center about the anchor). `emit_intro_transform` refuses to fold a cluster
  whose rotations use *different* pivots (returns None → normal fallback paths).

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
   `_merge_units`, which **fuses same-object move/scale/rotate that overlap in time** into one `MasApply`
   over the union window (`emit_transform_chain`) — two separate transforms on one mobject fight over its
   state. Applies to ungrouped tracks and parallel (`lag_ratio == 0`) groups; non-overlapping transforms
   stay separate. A **staggered group** (`lag_ratio > 0`) emits with the *same timing* as Manim's
   `AnimationGroup(…, lag_ratio=…)` (member *i* starts at Σ previous run_times × lag) but as parallel
   `Succession(Wait(start), member)` tracks inside a `lag_ratio=0` group, so each member *begins* — and
   builds its MasApply/MasFade target — at its actual start, not eagerly at the group's start.
   A **fade** (fade_in/fade_out) that overlaps a same-object transform is fused into that transform's
   `MasApply` as its `opacity` — a standalone fade alongside a transform is a second animation on the
   same mobject and they cancel. `_plan_fade_fusion` picks the fade keyframes to fuse (`fused_fade_ids`,
   threaded into `_merge_units`); fusion is per play bucket (ungrouped / parallel group), same as the
   transform merge. Cross-family overlaps (fade on a *group* while a *child* transforms, or vice versa)
   need no fusion: MasApply/MasFade split geometry from style per-member (see below).
   A **drawing creation verb** (write/create/draw_border_then_fill) that overlaps a same-object transform
   cluster likewise fuses — into one **`MasIntro`** (template helper): the creation animation subclassed to
   apply the partial move/scale/rotate *after* each frame's interpolation. That composes cleanly because
   creation animations rebuild the mobject from their captured start state every frame; running the
   introducer and a `Transform` as two animations on one mobject fights (or, chained into a `Succession`,
   pops the object in fully visible, moves it, then wipes and redraws it — the original bug). `MasIntro`
   runs over the union window with `intro_span`/`xform_span` fractions locating each part; the intro's
   easing is its `rate_func` (drives the drawing), the cluster's easing is `xform_rate`. Planned by
   `_plan_intro_fusion` (same bucket rules; one intro per cluster; a cluster already fusing a *fade* keeps
   the fade and the intro stays standalone — an Animation-class intro can't join a MasApply). If the
   object was hidden (see 2b) `_object_tracks` emits a `MasFade(m, 1.0, run_time=0.001)` immediately
   before the fused intro instead of the standalone reveal wrapping.
   **One track per mobject (`_object_tracks`).** Manim can't run two animations on one mobject in a
   single `self.play` — they fight each frame over its state. So after `_merge_units`, each mobject's
   several units are chained into **one** `Succession(seg, Wait(gap), seg, …)` track (an object that
   fades in + moves, then later fades out + moves, must run its two clusters *in sequence*). No target
   copies are pre-built: each segment's MasApply/MasFade constructs its target at its own `begin()`
   (`Succession` begins segments lazily), so segments compose on the live mobject. The sequential
   (camera-tracking) model is naturally safe here — it emits a separate `self.play` per time slot.
5. `_bake(expr, run_time, rate_func)` inserts timing into an animation expression so it can live inside
   an `AnimationGroup`/`Succession`: `.animate.m(…)` → `.animate(run_time=…, rate_func=…).m(…)` (only
   **sweep trackers** still use `.animate` — one per object, so no two builders share a `target`
   slot; see the camera section for why that matters); an Animation-class call gets the kwargs
   inserted before the final `)`. Hold the final frame with a trailing `self.wait`.

## Fades & transforms (MasFade / MasApply) — why not FadeIn/FadeOut/.animate

All object fades emit **`MasFade(m, alpha, shift=…)`** and all move/scale/rotate emit
**`MasApply(m, lambda _m: _m.shift(…)…, opacity=…)`** (template helpers; MasFade is a MasApply
wrapper). Two Manim behaviours forced this — regressions here reintroduce **"group fades out, objects
instantly reappear at the end"** and **"a later transform resurrects a faded object"**:

- **Removers are unsafe with groups.** `FadeOut`'s clean-up calls `scene.remove(m)` *and then resets
  the mobject to full visibility* (`self.interpolate(0)`). On Cairo, `Scene.remove` does **not**
  extract the removed mobject's own family from *other* scene containers — and every play wraps its
  animated mobjects in helper `Group`s (each `Succession`/`AnimationGroup` has a `.group`), so any
  group child with its own keyframe stays reachable through one of those and pops back fully visible
  when the play ends. MasFade never touches scene membership: it drives each family member's opacity
  toward `alpha` × its **authored** value and leaves the (invisible) mobject in place — which is also
  what lets a later fade_in bring it back.
- **Pre-built targets snapshot stale state.** `.animate` (and any `Transform(m, m.copy()…)` target
  built before the play) copies the mobject at construction time — the timeline model plays the whole
  scene in *one* `self.play`, so such a target resurrects everything an earlier fade did (and bakes
  opacity 0 into transforms of hidden objects). MasApply builds its target at `begin()` from the
  *current* state, so every unit composes with whatever already played.
- **Authored opacity**: MasFade/MasApply read per-member target opacities from `saved_state` when
  present, else the member at construction time. `build_body` emits `save_state()` for every object a
  fade touches (and every hidden object) as a setup statement — required in the sequential model,
  where a play's animations are constructed mid-scene (after an earlier fade_out already zeroed the
  live opacity). A partial fill (`fill_opacity: 0.5`) round-trips through fade-out/fade-in intact.
- **Cross-family overlap**: a *pure* fade interpolates **style only** and a *pure* transform
  interpolates **geometry only** (`interpolate_submobject`), so a fade on a group overlapping a
  transform on its child (or vice versa) composes instead of the two animations clobbering the shared
  member each frame. A fused fade+transform (or a shifted fade) owns its object and interpolates both.

**Hide-until-creation (`build_body` step 2b).** Objects that must start at `set_opacity(0)`:

- **Introduced by fade_in** (both models): the fade_in is the object's first keyframe (tie → creation
  verbs first) — a MasFade on an already-visible object is a no-op, and the play's wrapper `Group`
  exposes the mobject from t=0 (MasFade is not a Manim introducer). Exceptions: an **ancestor group's
  earlier fade_out** implies the family started visible (`_ancestor_fadeout_before`, also excludes the
  object from `created_ids` so the pre-add works), and Transform/morph **targets** are never hidden
  (the transform interpolates toward them). No reveal wrapper needed — the fade_in *is* the reveal.
- **Introduced by a *delayed* drawing verb** (Write/Create/…, timeline model only) that is otherwise
  exposed at t=0: any non-drawing keyframe on the object **or any ancestor group** pulls the mobject
  into the play's wrapper `Group` when the play starts (`_exposed_early` walks the `parent_id` chain),
  flashing it before its creation plays. The creation is preceded by
  `MasFade(m, 1.0, run_time=0.001)` — an opacity-only reveal (geometry stays wherever earlier hidden
  transforms put it) the instant the introducer starts. `reveal_kf_id` records which keyframe
  reveals; on a start-time tie the creation verb sorts first. Not needed in the sequential model
  (adds are per-play).
  **The reveal is emitted inside `_object_tracks`**, as the first segment of the object's own track,
  for *both* a fused MasIntro and a standalone introducer (the unit's `reveal` flag; `_merge_units`
  takes `reveal_kf_ids` to set it). Don't hoist reveals back out into their own tracks: an object
  whose introducer does *not* fuse with an overlapping transform (i.e. `type_on`, which never fuses)
  would then get two parallel tracks on one mobject in one play — the exact thing `_object_tracks`
  exists to prevent.

Hidden objects need no special transform handling: a MasApply target built at `begin()` simply carries
the current 0 opacity, so a pre-creation move keeps the object hidden (the old `.animate`
restore-target machinery is gone).

## Camera (Phase 5)

Camera keyframes reuse the normal `Keyframe` with the sentinel `object_id == CAMERA_ID`
(`"__camera__"`) and verb `camera_move`; params are `pan {x,y}` (or `focus_object_id` to target an
object's center) + an absolute `zoom` (and `track: true` for continuous follow). **No IR schema
change** — it's all in the free-form `params` dict.

- `_uses_camera(scene)` → any camera keyframe or a non-default `camera_track`. Drives the
  `base_class` choice in `generate_scene_script` and the initial-framing emission in `build_body`.
- `_camera_anim(kf, var_map)` → a one-shot **`MasApply(self.camera.frame, lambda _m: _m.move_to(…).set(width=config.frame_width / zoom))`**
  (focus → `<objvar>.get_center()`). Width is only emitted when `zoom` is present, so a pure pan
  keeps the current zoom. `_zoom()` clamps non-positive/garbage zoom to 1.0 (guards `/ 0`).
  **Never emit `.animate` here** — `m.animate` parks its target in the mobject's single `m.target`
  slot, and a builder only becomes an Animation when the enclosing `AnimationGroup`/`Succession` is
  constructed, i.e. *after* every builder in the play exists. So N camera moves in one play all read
  the same (last) `frame.target`: every move animated to the last keyframe's framing and only that
  one appeared to work. MasApply builds its target at `begin()` from the live frame, which is also
  what makes a pan-only keyframe keep the previous zoom (the old target was a copy of the *pre-play*
  frame, so it silently restored the initial zoom) and a focus keyframe read the object's position
  when the move starts — matching the editor's ghost preview (`effectivePosition` at the keyframe's
  time). Locked in by `backend/tests/stress_camera.py`.
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
  `CREATION_VERBS` if it introduces the object to the scene. A new transform verb (like
  move/scale/rotate) should also be added to `_XFORM_ANIM` + `transform_chain_suffix` (and folded
  in `emit_intro_transform`/`MasIntro` if it can overlap a creation) so it fuses when simultaneous
  and emits through `MasApply`; a new *drawing* introducer verb belongs in `INTRO_VERBS` + `_SIMPLE`
  so it fuses with overlapping transforms, and interacts with the hide-until-creation pass above.
- **Regression harness**: `backend/tests/stress_groups.py` (run with the venv python, no pytest
  needed) builds IR scenes for ~23 group/fade scenarios, executes the generated scripts in-process
  frame-by-frame, and asserts per-object visibility over time + final-frame pixels. Run it after any
  change to fade/transform emission, the hide pass, or the template helpers.
  `backend/tests/stress_camera.py` is its camera twin: it samples the real `self.camera.frame`
  (center + width) frame by frame across both emission models, and covers multiple moves in one
  play, pan-only/zoom-only keyframes, initial framing, focus, and tracking. Run it after any change
  to `_camera_anim`, `_bake`, or how camera units are chained.
- A verb that can't emit (e.g. a transform with a missing target, or a camera move with no
  resolvable pan/focus) returns `None`; the scene builder drops it. Preserve that contract.
