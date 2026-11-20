# Codegen — IR `Scene` → Manim Python script

Transpiles a `Scene` (from `models/ir.py`) into a runnable Manim script via Jinja2. Pure string
generation: **no Manim import here, the output is *text*.** The generated `LocusScene(Scene)` class is
run by the render worker.

| File | Role |
|------|------|
| `template.py` | Jinja2 scaffold + `SCENE_CLASS_NAME = "LocusScene"`. `render_script(…, time_range=(t0, t1))` (worker range renders only) adds the `_LocusRange` mixin — see "Range renders" below. `render_script(body, background_color, base_class="Scene", progress_total=None)` — `base_class` becomes `MovingCameraScene` when the scene uses the camera. Body is pre-indented (8 spaces) and injected; numpy fns (`sin`, `cos`, …) are imported so plot expressions can use them bare. Also holds the helper classes, emitted only when the body references them: `LocusApply`/`LocusFade`/`LocusIntro`, the data helpers (`LocusHistogram`/`LocusBars`/`LocusNumber`/`LocusCount`), plus `_LocusProgress` when `progress_total` is given. |
| `objects.py` | `emit_object(obj, assets_root=None) -> (var, lines)`: Mobject construction + styling + placement per type/subtype. |
| `animations.py` | `emit_animation(verb, var, params, var_map) -> expr`: one **object** verb → the inner expression of a `self.play(...)`. Plus `emit_transform_chain` (fuse simultaneous move/scale/rotate + an overlapping fade's opacity into one `LocusApply`) and `emit_intro_transform` (fuse a creation verb with such a cluster into `LocusIntro`). Camera verbs live in `scene.py`. |
| `scene.py` | Orchestrator: `build_body` / `generate_scene_script` / `generate_morph_preview_script`. Ties objects + relationships + timeline + camera together. `build_body_timed` is `build_body` plus the exact seconds the emitted statements render — the render bar's denominator, which is why `_object_tracks` and the timeline-model `tracks` carry an `end` alongside each expression. |

## The one Manim fact that shapes this whole package

**A target built before the play is a stale snapshot.** `.animate` (and any `Transform(m, m.copy())`)
copies the mobject at *construction* time, and a builder only becomes an Animation when the enclosing
`AnimationGroup`/`Succession` is constructed — after every builder in the play exists. Since the default
model plays the whole scene in **one** `self.play`, pre-built targets resurrect everything earlier
animations did, bake opacity 0 into transforms of hidden objects, and — because `m.animate` parks its
target in the mobject's single `m.target` slot — make N moves on one mobject all read the *last* target.

So everything emits the `template.py` helpers instead, which build their target at `begin()` from the
**live** state: `LocusApply` (all move/scale/rotate + all camera moves), `LocusFade` (all fades, a
LocusApply wrapper), `LocusIntro` (creation fused with a transform). Only **sweep trackers** still use
`.animate` — one per object, so no two builders share a `target` slot. The consequences are spelled out
in `ANIMATION-EMISSION.md` (fades) and under "Camera" below; both are locked in by `../../tests/`.

## Key conventions

- **Variable naming is deterministic and id-based.** `var_name(obj_id)` → `m_<sanitized_id>`;
  `tracker_name(obj_id)` → `t_<sanitized_id>`. This lets objects reference each other by id alone (an
  Angle its two lines, a Brace its target, a graph its axes) without passing live references around.
  `var_map: dict[obj_id -> var]` is threaded through codegen.
- **LaTeX/string safety:** always emit user strings with `repr()` (`{tex!r}`) so backslashes survive.
  Coerce numbers/expressions through the `_num`, `_expr`, `_range`, `_point`, `_np` helpers — never raw
  f-string interpolation of untrusted props.
- **Plot expressions are Python/numpy**, evaluated inside `lambda x: (...)`. `_range` clamps a
  non-positive step to 1.0 (a `<= 0` step makes Manim's tick generation hang/raise) and renders whole
  numbers without a trailing `.0` (`_fmt_num`). **Tick-label decimals are passed explicitly**
  (`_tick_decimals` → `decimal_number_config.num_decimal_places`, per axis via `x_axis_config` /
  `y_axis_config`): as many as the step has, so an axis reads "2.5, 3.0, 3.5". Manim's own inference
  reads `str(step)` and trips on Python's float repr (`str(1e-05)` has no "."). The canvas mirrors it
  (`tickDecimals` in `SceneNodes.tsx`).
- **Generic baked transforms:** `emit_object` applies a `rotation` prop (degrees, CCW) as
  `.rotate(rot * DEGREES)` after placement; scale is baked into concrete size props by the frontend.
  Axes/number_line pass `number_font_size` through to `font_size` / `axis_config`.
- **Matrix font size:** `Matrix` has no `font_size` kwarg, so a non-default one emits
  `.scale(font_size/48)` — glyphs, spacing and brackets grow together. The canvas mirrors the factor.
- **Rotation pivot:** a rotate keyframe may carry `about_point` (`{x,y}`, scene coords), emitted as
  `about_point=np.array(…)` on every rotate path (`_rotate_call`: the `.animate` branch and the fused
  `LocusApply` chain). It reaches `LocusIntro` as `rotate_about`, applied **after** the shift: a
  fixed-point pivot doesn't commute with a move, so the convention is move first, then orbit
  (`motion.ts` mirrors it). `emit_intro_transform` refuses a cluster whose rotations use *different*
  pivots (returns None → fallback paths).

### Text: LaTeX vs Pango, all mirrored in the frontend

The canvas must match; mirrors are `equationTex` / `texEscape` / `textKatex` / `textFont` in
`frontend/src/canvas/LatexOverlay.tsx`. **Change both places.**

- **Multi-line `latex_text` alignment:** MathTex defaults to `align*`, which *right-aligns* lines with no
  `&`. Multi-line content (has `\\`, no `&`) is wrapped in `\begin{array}{l|c|r}` per the `align` prop
  (default center); a user's own `&` wins (no wrap).
- **`text` objects** (prose) emit `Tex(...)` in LaTeX text mode: the string goes through `_tex_escape` —
  a **single-pass** char map, so a replacement's own braces (`\textbackslash{}`) aren't re-escaped — then
  optional `\textit`/`\textbf`. Styling/placement matches `latex_text`.
- **`text` line breaks:** the textarea stores real `\n`s but LaTeX collapses a raw newline to a space, so
  multi-line content emits `\begin{tabular}{l}…\\…\end{tabular}`, one row per line, each escaped/wrapped
  separately. `{l}` matches the left alignment Pango gives for free, and LaTeX's row strut keeps the
  leading even and lets a blank line stay a blank row (no `\strut` needed). **Single-line content keeps
  the bare `Tex('…')`** — wrapping would change its bbox and hence the vertical centering of every
  existing text object. The Pango path needs none of this.
- **`text` fonts — two mobjects, one object type.** A non-empty `font` prop switches emission from `Tex`
  to Pango-backed **`Text(raw, font=…, weight=…, slant=…)`**, the only mobject taking an arbitrary system
  font (LaTeX fonts are a preamble/`TexTemplate` affair, not a kwarg). There the string is **not**
  escaped (Pango draws it literally, so no LaTeX may appear) and bold/italic become `weight="BOLD"` /
  `slant="ITALIC"`. The paths have **different em scales** — a Pango em is `font_size/72` scene units vs
  the LaTeX calibration in `coords.ts` — so the preview picks its constant per path and previews a `font`
  object as styled HTML, not KaTeX. Only fonts `GET /api/fonts` reports are offered; an unknown name
  would silently fall back.
- **Pango text is always built at `PANGO_REF_FONT_SIZE` (48) and `.scale()`d** to the authored size —
  never pass a small size to `Text(font_size=…)`. Pango grid-fits glyph *advances* at its raster size,
  and below ~24pt that quantization is a large fraction of an advance; the errors don't cancel, so
  letters land too far apart or overlap (measurably negative gaps). `font_size=8` Chalkduster rendered
  "pending" as "pen d in g", and a zoomed camera magnifies it. At 48 the intra-word gap spread drops ~6×
  and no gap goes negative. The scale is exact, so **height is bit-identical** to a direct build (no
  centering shift); only the previously-compressed width changes. `font_size == 48` emits no `.scale()`.
- **`type_on` (typewriter reveal) — Pango text only.** Emits `AddTextLetterByLetter`: whole filled glyphs
  one at a time. It exists because Write/Create *stroke-trace* the outline first, and a textured font
  (Chalkduster — 213 subpaths for a 9-character word) traces as grey scribble for the whole animation.
  The underlying `ShowIncreasingSubsets` reveals one **submobject** per step, which means "one letter"
  only for a Pango `Text`; a `Tex` is one submobject and would pop in whole. So `build_body` **degrades
  `type_on` → `write`** for anything that isn't a `text` with a `font` (`_is_pango_text`) — the IR can
  carry a stale `type_on` after the user clears `font`. That pass runs *before* the image→FadeIn degrade,
  so an image inherits it. `type_on` is in `CREATION_VERBS` and `INTRO_VERBS` but deliberately **not in
  `_SIMPLE`**, which gates LocusIntro fusion: `AddTextLetterByLetter` swaps `mobject.submobjects` each
  frame instead of rebuilding from a captured start state, so LocusIntro's post-frame `m.shift(delta*t)`
  would accumulate every frame and fling the text off screen. `emit_intro_transform` returns None for it,
  `_plan_intro_fusion` never marks it fused, and `_object_tracks` chains an overlapping transform *after*
  the type-on instead of running both at once.

## Images (`image` object type)

- The optional `assets_root` (computed in `generate_scene_script` via `_assets_root`) is joined with
  `props.asset` and baked into `ImageMobject({path!r})` as an **absolute path** — the script runs from a
  per-job dir. Sizing uses `stretch_to_fit_width/height` (both dims stored, so non-uniform is
  representable).
- **Skip guards:** an empty `asset`, or a file missing on disk (checked only when `assets_root` is
  given), is dropped like other unresolvable objects.
- **`Group` vs `VGroup`:** `VGroup` rejects an `ImageMobject`, so a group that (transitively) contains an
  image emits `Group(...)` (`image_group_ids` in `build_body`).
- **Verb normalization:** Write/Create/DrawBorderThenFill need VMobject points and raise on a raster
  image — `build_body` rewrites them to FadeIn (still a creation verb, so the hide pass is unaffected).

## Data-driven objects (`graph.histogram`, `number`) and `update_data`

- **`graph` subtype `histogram`** → `LocusHistogram(axes, bin_start, bin_width, [values], gap=…)`, a
  `VGroup` of plain closed `VMobject` bars whose points are rewritten in place (zero height is fine,
  styling survives). Bar *i* covers its bin minus `gap/2` each side, from y=0 **clamped into the y range**
  up to `values[i]`. In `AXES_BOUND_GRAPHS` (skip-guarded like a plot); styled like a closed shape
  (fill + stroke), not like a curve. At least one bar is emitted so Create/Write have something to draw.
- **`number`** → `LocusNumber(value, places, font_size, label=…)`: always a `VGroup` whose **last** member
  is a `DecimalNumber` (`group_with_commas=False` — a comma descends below the baseline and would shift
  the bottom-aligned number). A label is typeset as `MathTex(label, "0")` and the number dropped onto the
  placeholder digit (`aligned_edge=DL`), so gap and baseline are TeX's own; the canvas mirrors it as
  KaTeX `label + ' ' + number` (`frontend/src/canvas/data.ts`). Never rotated: `set_value` rebuilds the
  glyphs upright.
- **`update_data`** → `LocusBars(m, [values])` / `LocusCount(m, value)` — the params' shape picks which.
  Both read their **start from the live mobject at `begin()`** (the stale-target rule again:
  `ChangeDecimalToValue` snapshots its start at construction), so a chain of updates composes. Bars
  pad/truncate to the bar count. `build_body` **drops** an update whose params don't fit its object
  (`values` on a number, `value` on a histogram, anything on other types) instead of emitting a call that
  raises mid-render.
- **`_locus_set_number` restyles every glyph** from the old first one after `set_value`: Manim only matches
  style pairwise with the *old* glyphs, so a value gaining digits showed the new ones fully opaque — even
  while the readout was faded out. `stress_data.py number_counts_while_hidden` locks that in.
- The histogram keeps **no Axes attribute** (`Mobject.copy` deep-copies attributes, so every `save_state`
  and Transform target would clone the whole Axes); its layout is a closure in `_locus_layout`, which
  deepcopy treats as atomic, measuring against the live Axes.
- **An empty bin draws nothing**: a bar whose height equals the base is collapsed to one repeated point
  (a stroked zero-height outline drew a line along the base — a stray "x-axis", visible before the axes
  were drawn in). Later updates grow it from there as usual.
- The sampling simulator (`frontend/src/sim/sampling.ts`) never reaches codegen: it writes ordinary
  `update_data` keyframes (tagged `params.sim_run`, ignored here) and `props.sim` (ignored too).

## Emit order (`_emit_order`) — matters

Dependency order so references resolve: `0` plain → `1` graphs (need axes) → `2` geometry (may reference
shapes/targets) → `3` groups (need children first). Per-type **skip guards** drop objects with
missing/hidden dependencies: axes-bound graphs (`AXES_BOUND_GRAPHS`) skip if `axes_ref` isn't in
`var_map` (`vector_field` is standalone); an `angle` needs both `line1_id`/`line2_id`; a `brace` needs
`target_id`.

## Placement semantics (see `objects.py` comments)

- Point-based shapes (line/arrow/double_arrow/dashed_line/polygon) and `geometry.vector` keep points in
  **local space** and use `.shift(position)`.
- `graph.*` has **no independent position** — it follows its axes, **including their animations**. In
  Manim a plot / histogram is a separate mobject built from the axes once, so moving the axes used to
  leave it behind (the editor always drew it with the axes). Now:
  - `build_body` **drops move/scale/rotate keyframes on axes-bound graphs** (`_OWN_MOTION_VERBS`) — the
    convention is "animate the axes"; honouring both would move a graph twice.
  - `_emit_follow` registers `_locus_follow(self, axes, [graphs])` (template `_LOCUS_FOLLOW_HELPER`), a
    **scene updater**, for each axes that can move (a move/scale/rotate/indicate/transform or shifted fade
    on it or an ancestor group, or a relationship placing it). Each frame it reads the axes' similarity
    transform since the last frame from points that **survive partial drawing** (each axis line's first
    point, the last tick's first point — Create keeps a submobject's first point fixed, so drawing the
    axes in isn't motion) and applies it to every follower — hidden ones too, so a graph created later
    appears in the right place. A histogram is re-laid out from its data instead. A follower that already
    moved the same way (in a group that moved with the axes) is skipped, or it would move twice. Only
    emitted when needed: a scene updater stops Manim freezing static waits.
  - Relationships run after the follow is registered, then call it once (`_follow_m_x(0)`).
- **Move / scale / rotate pivot on `_locus_pivot`** (template `_LOCUS_PIVOT_HELPER`): the bbox center,
  except a coordinate system, which pivots on its **data midpoint** (`_locus_mid`, set by `emit_object`) —
  the editor's `position`. A move's `target_position` emits `.shift(_locus_to(_m, p))`, scale/rotate pass
  `about_point=_locus_pivot(_m)`, and `LocusIntro` pivots the same way; a baked axes `rotation` turns about
  `position`. Manim's `move_to`/`scale`/`rotate` use the bbox center, which tips, tick numbers and labels
  make lopsided, so the axes landed off where the preview put them.
- **A finished `LocusApply` / `LocusIntro` doesn't re-apply itself at the end of the play.**
  `AnimationGroup.finish()` re-finishes every member and `Animation.finish()` re-interpolates to 1, so a
  transform that ended long before snapped its whole family back to its own target — undoing later
  animations on members (a group moved, then its axes scaled alone: the group's finish reset the axes'
  graphs). Both remember having reached alpha 1 and make the second `finish()` a no-op.
- Coordinate systems align their **data midpoint** to `position` via `c2p`/`number_to_point`, *not*
  `.move_to`, which would center Manim's full bbox (tips, numbers, labels) and shift the axes off spot.
- Everything else uses `.move_to(position)`.

## Timeline → `self.play` calls — see `ANIMATION-EMISSION.md`

How keyframes become plays is the subtlest part of this package and lives in a sibling file,
**`ANIMATION-EMISSION.md`** (same directory). **Read it before changing how animations are emitted.**
It covers `build_body`'s ordered steps; the **two emission models** (one big `AnimationGroup` by default,
one `self.play` per slot when the camera tracks); `_merge_units` **fusion** of simultaneous
transform / fade / creation verbs on one mobject; `_object_tracks` (**one track per mobject** — Manim
can't run two animations on one); why fades are `LocusFade` rather than FadeIn/FadeOut; and the
**hide-until-creation** pass. Its rules are what keep "group fades out, objects reappear at the end" and
"a later transform resurrects a faded object" fixed.

## Camera (Phase 5)

Camera keyframes reuse the normal `Keyframe` with the sentinel `object_id == CAMERA_ID` (`"__camera__"`)
and verb `camera_move`; params are `pan {x,y}` (or `focus_object_id` to target an object's center) + an
absolute `zoom` (and `track: true` for continuous follow). **No IR schema change** — all in `params`.

- `_uses_camera(scene)` → any camera keyframe or a non-default `camera_track`. Drives the `base_class`
  choice in `generate_scene_script` and the initial-framing emission in `build_body`.
- `_camera_anim(kf, var_map)` → a one-shot
  **`LocusApply(self.camera.frame, lambda _m: _m.move_to(…).set(width=config.frame_width / zoom))`**
  (focus → `<objvar>.get_center()`). Width is emitted only when `zoom` is present, so a pure pan keeps the
  current zoom. `_zoom()` clamps non-positive/garbage zoom to 1.0 (guards `/ 0`).
- **Never emit `.animate` here** — see the stale-target section: N camera moves in one play all read the
  same (last) `frame.target`, so every move animated to the last keyframe's framing and only that one
  appeared to work. Building at `begin()` from the live frame is also what makes a pan-only keyframe keep
  the previous zoom (the old target was a copy of the *pre-play* frame, so it silently restored the
  initial zoom) and a focus keyframe read the object's position when the move *starts*, matching the
  editor's ghost preview.
- **Continuous tracking** (`_is_track_kf`): a follow-updater over the keyframe's window as two statement
  events — `add_updater` at `start` (`order` 0, before same-time plays) and `remove_updater` at
  `start+duration` (`order` 2, after). **GOTCHA:** the start statement must run
  `self.add(self.camera.frame)` *before* `add_updater` — the frame's updater only fires during
  `self.play()` while the frame is in the scene's mobject list, otherwise the camera silently stays put.
  (One-shot focus moves are explicit animations and don't need this.)
- Initial framing (`camera_track.initial_pan/zoom`) is emitted as step 0 of `build_body`.

## Range renders (`_LocusRange`, worker only)

`generate_scene_script(…, time_range=(t0, t1))` outputs just those seconds of the timeline without
changing the body: the whole scene still *runs* (so the state at t0 is exact), but the mixin patches the
Cairo renderer in `setup()` so frames outside the window are never rasterized — only counted on
`renderer.time`, which is the clock everything keys off:

- `render` (one animation frame) draws + emits only inside `[t0, t1)`, else just advances the clock;
- `add_frame` (also called directly with `num_frames > 1` by frozen-frame **static waits**) emits only
  the slice of those frames inside the window;
- `play` drops the partial movie of a play that wrote **no** frames (sets it to `None`, which the file
  writer skips) — otherwise Manim would concat an empty segment. That case is real in the sequential
  (camera-tracking) model, where plays and `self.wait`s sit wholly outside the window.

Verified against full renders in both emission models (length exact; first/last frames match the full
render at t0/t1). The ejected `/script` never carries it.

## Adding a new object type / verb / subtype

- New **object subtype**: a branch in `objects._emit_construct` (plus styling/placement if it differs),
  and the frontend factory + inspector + canvas node. No IR schema change if it only adds props.
- New **animation verb**: add to `AnimationVerb` (**both** `ir.py` and `ir.ts`), handle it in
  `emit_animation` (object) or `_camera_anim`/`_kf_anim` (camera), and add to `CREATION_VERBS` if it
  introduces the object. A new *transform* verb also belongs in `_XFORM_ANIM` + `transform_chain_suffix`
  (and folded into `emit_intro_transform`/`LocusIntro` if it can overlap a creation) so it fuses when
  simultaneous and emits through `LocusApply`. A new *drawing introducer* belongs in `INTRO_VERBS` +
  `_SIMPLE` so it fuses with overlapping transforms, and interacts with the hide pass above.
- A verb that can't emit (a transform with a missing target, a camera move with no resolvable pan/focus)
  returns `None` and the scene builder drops it. **Preserve that contract.**
- **Run the regression harnesses** after touching fade/transform emission, the hide pass, the template
  helpers, or camera chaining — see `../../tests/CLAUDE.md`.
