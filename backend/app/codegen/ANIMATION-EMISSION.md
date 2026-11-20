# Animation emission — timeline layout, fusion, fades, the hide pass

The deep half of `scene.py` / `animations.py` / the `template.py` helpers: how a timeline of keyframes
becomes `self.play` calls that actually compose. Read this before changing anything about how animations
are emitted. `CLAUDE.md` in this directory covers everything else (object emission, text, camera,
conventions) and states the stale-target rule these sections build on.

## Timeline → `self.play` calls (`build_body`)

1. Define + style every visible object (skip-guarded).
2. Apply relationships (`next_to`/`align_to`/`center_on`/`move_to_point`).
3. `self.add()` objects present from frame 0 — *not* introduced by a creation verb (`CREATION_VERBS`),
   *not* a Transform target (the transform pulls those in), and not a group child (the VGroup covers it).
4. Lay out the timeline. **Two emission models**, picked by `uses_tracking`:
   - **Timeline model (default):** every animation is a track in one
     `self.play(AnimationGroup(…, lag_ratio=0))`. Each carries its own `run_time`+`rate_func` (baked by
     `_bake`) and a `Succession(Wait(delay), anim)` offsets its start, so animations **overlap exactly as
     laid out** — different start *and* end times across objects. A `group_id` set becomes a nested
     `AnimationGroup(…, lag_ratio=…)` track; sweeps become tracks. The whole group is shifted so the
     first animation is at t=0 (a leading `self.wait` covers the offset).
   - **Sequential model (scene uses continuous camera tracking):** one `self.play()` per time slot with
     `self.wait()` gaps — the follow updater needs add/remove **statements** timed *between* plays, which
     one play can't express. Keyframes sharing a `group_id` *or* a `start_time` collapse into one parallel
     play; tracking emits **statement events** (`kind: "stmt"`).
5. Both route each animation through `_kf_anim` (camera → `_camera_anim`, object → `emit_animation`) via
   `_merge_units`, then `_object_tracks`. `_bake(expr, run_time, rate_func)` inserts timing so an
   animation can live inside an `AnimationGroup`/`Succession`: `.animate.m(…)` →
   `.animate(run_time=…, rate_func=…).m(…)`; an Animation-class call gets kwargs before the final `)`.
   Hold the final frame with a trailing `self.wait`.

**Fusion (`_merge_units`), because Manim can't run two animations on one mobject** — they fight over its
state each frame. Fusion is per play bucket (ungrouped tracks, or a parallel `lag_ratio == 0` group):

- Same-object **move/scale/rotate overlapping in time** → one `LocusApply` over the union window
  (`emit_transform_chain`). Non-overlapping transforms stay separate.
- An overlapping **fade** → folded into that transform's `LocusApply` as its `opacity`; a standalone fade
  alongside a transform is a second animation on the same mobject and they cancel. `_plan_fade_fusion`
  picks which (`fused_fade_ids`, threaded into `_merge_units`).
- An overlapping **drawing creation verb** (write/create/draw_border_then_fill) → one **`LocusIntro`**,
  the creation animation subclassed to apply the partial transform *after* each frame's interpolation.
  That composes because creation animations rebuild from their captured start state every frame; running
  introducer + `Transform` as two animations fights, and chaining them into a `Succession` pops the object
  in fully visible, moves it, then wipes and redraws it (the original bug). It runs over the union window
  with `intro_span`/`xform_span` locating each part; the intro's easing is its `rate_func`, the cluster's
  is `xform_rate`. Planned by `_plan_intro_fusion`, one intro per cluster; a cluster already fusing a
  *fade* keeps the fade and the intro stays standalone — an Animation-class intro can't join a LocusApply.
- **Cross-family overlaps need no fusion** (a fade on a *group* while a *child* transforms, or vice
  versa) — LocusApply/LocusFade split geometry from style per member, see below.
- **The editor mirrors group timing** (`normalizeGroups` in `frontend/src/store/projectStore.ts`): it
  rewrites every member's `start_time` to group start + Σ previous durations × lag, so the timeline and
  the canvas preview show when members really play. **Change both** if group timing changes here.
- A **staggered group** (`lag_ratio > 0`) emits with the *same timing* as Manim's
  `AnimationGroup(…, lag_ratio=…)` (member *i* starts at Σ previous run_times × lag) but as parallel
  `Succession(Wait(start), member)` tracks inside a `lag_ratio=0` group, so each member *begins* — and
  builds its target — at its actual start, not eagerly at the group's start.
- **One track per mobject (`_object_tracks`).** After `_merge_units`, a mobject's several units chain
  into **one** `Succession(seg, Wait(gap), seg, …)`: an object that fades in + moves, then later fades
  out + moves, must run its clusters in sequence. No targets are pre-built — each segment constructs its
  own at `begin()` (`Succession` begins segments lazily), so segments compose on the live mobject. The
  sequential model is naturally safe (a separate `self.play` per slot).
- **Every track is `(start, expr, end)`.** The `end` is bookkeeping only — it has no bearing on the
  emitted text — but it is how `build_body_timed` reports the scene's real length: the timeline model's
  play runs until its last track ends, and the sequential model's `current` already tracks its own
  position. Feeding the render bar the *timeline extent* instead would be wrong in both directions —
  keyframes that emit no animation (`_kf_anim` → `None`) shorten the play, and the sequential model
  lengthens it by serializing events that overlap. Give any new track kind an honest `end`.

## Fades & transforms — why not FadeIn/FadeOut/`.animate`

Beyond the stale-target problem above, one more Manim behaviour forced `LocusFade`. Regressions here
reintroduce **"group fades out, objects instantly reappear at the end"** and **"a later transform
resurrects a faded object"**:

- **Removers are unsafe with groups.** `FadeOut`'s clean-up calls `scene.remove(m)` *and then resets the
  mobject to full visibility* (`self.interpolate(0)`). On Cairo, `Scene.remove` does **not** extract the
  removed mobject's own family from *other* scene containers — and every play wraps its animated mobjects
  in helper `Group`s (each `Succession`/`AnimationGroup` has a `.group`), so any group child with its own
  keyframe stays reachable through one of those and pops back fully visible when the play ends. LocusFade
  never touches scene membership: it drives each family member's opacity toward `alpha` × its
  **authored** value and leaves the invisible mobject in place — which is also what lets a later fade_in
  bring it back.
- **Authored opacity:** LocusFade/LocusApply read per-member target opacities from `saved_state` when
  present, else the member at construction time. `build_body` emits `save_state()` for every object a
  fade touches (and every hidden object) — required in the sequential model, where a play's animations
  are constructed mid-scene, after an earlier fade_out already zeroed the live opacity. A partial fill
  (`fill_opacity: 0.5`) round-trips through fade-out/fade-in intact.
- **Cross-family overlap:** a *pure* fade interpolates **style only**, a *pure* transform **geometry
  only** (`interpolate_submobject`), so a fade on a group overlapping a transform on its child composes
  instead of the two clobbering the shared member. A fused fade+transform (or a shifted fade) owns its
  object and interpolates both.

**Hide-until-creation (`build_body` step 2b).** Objects that must start at `set_opacity(0)`:

- **Introduced by fade_in** (both models): the fade_in is the object's first keyframe (tie → creation
  verbs first). A LocusFade on an already-visible object is a no-op, and the play's wrapper `Group`
  exposes the mobject from t=0 (LocusFade is not a Manim introducer). Exceptions: an **ancestor group's
  earlier fade_out** implies the family started visible (`_ancestor_fadeout_before`, which also drops the
  object from `created_ids` so the pre-add works), and Transform/morph **targets** are never hidden (the
  transform interpolates toward them). No reveal wrapper needed — the fade_in *is* the reveal.
- **Introduced by a *delayed* drawing verb** (timeline model only) that is otherwise exposed at t=0: any
  non-drawing keyframe on the object **or any ancestor group** pulls the mobject into the play's wrapper
  `Group` when the play starts (`_exposed_early` walks the `parent_id` chain), flashing it before its
  creation plays. So the creation is preceded by `LocusFade(m, 1.0, run_time=0.001)` — an opacity-only
  reveal (geometry stays wherever earlier hidden transforms put it) the instant the introducer starts.
  `reveal_kf_id` records which keyframe reveals; on a start-time tie the creation verb sorts first. Not
  needed in the sequential model (adds are per-play).
  **The reveal is emitted inside `_object_tracks`**, as the first segment of the object's own track, for
  *both* a fused LocusIntro and a standalone introducer (the unit's `reveal` flag; `_merge_units` takes
  `reveal_kf_ids` to set it). Don't hoist reveals back into their own tracks: an object whose introducer
  does *not* fuse with an overlapping transform (i.e. `type_on`) would then get two parallel tracks on one
  mobject in one play — exactly what `_object_tracks` prevents.

Hidden objects need no special transform handling: a LocusApply target built at `begin()` carries the
current 0 opacity, so a pre-creation move keeps the object hidden.

