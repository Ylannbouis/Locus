# Codegen — IR `Scene` → Manim Python script

Transpiles a `Scene` (from `models/ir.py`) into a runnable Manim script via Jinja2. Pure string
generation: no Manim import here, the output is *text*. The generated `MasScene(Scene)` class is
run by the render worker.

## Files

| File | Role |
|------|------|
| `template.py` | The Jinja2 scaffold + `SCENE_CLASS_NAME = "MasScene"`. The construct body is pre-indented (8 spaces) and injected. Imports numpy fns (`sin`, `cos`, …) so plot expressions can use them bare. |
| `objects.py` | `emit_object(obj) -> (var, lines)`: Mobject construction + styling + placement, per object type/subtype. |
| `animations.py` | `emit_animation(verb, var, params, var_map) -> expr`: one verb → the inner expression of a `self.play(...)`. |
| `scene.py` | Orchestrator: `build_body` / `generate_scene_script` / `generate_morph_preview_script`. Ties objects + relationships + timeline together. |

## Key conventions

- **Variable naming is deterministic and id-based.** `var_name(obj_id)` → `m_<sanitized_id>`;
  `tracker_name(obj_id)` → `t_<sanitized_id>`. This lets objects reference each other by id
  alone (an Angle references its two line objects, a Brace its target, a graph its axes) without
  passing live references around. `var_map: dict[obj_id -> var]` is threaded through codegen.
- **LaTeX/string safety:** always emit user strings with `repr()` (`{tex!r}`) so backslashes in
  LaTeX survive. Numeric/expression coercion goes through `_num`, `_expr`, `_range`, `_point`,
  `_np` helpers — use them rather than raw f-string interpolation of untrusted props.
- **Plot expressions are Python/numpy**, evaluated inside `lambda x: (...)`. `_range` clamps a
  non-positive step to 1.0 (a `<= 0` step makes Manim's tick generation hang/raise).

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
4. Build timeline events: keyframes sharing a `group_id` collapse into one `self.play`
   (`AnimationGroup(lag_ratio=…)` when lag > 0, else plain parallel); ungrouped keyframes each get
   their own play. Parameter **sweeps** emit their own event animating the object's `ValueTracker`.
5. Sort events by `start_time`; emit `self.wait(gap)` between them. Hold the final frame with a
   trailing `self.wait`.

## Adding a new object type / verb / subtype

- New **object subtype**: add a branch in `objects._emit_construct` (and styling/placement if it
  differs), plus the frontend factory + inspector + canvas node. No IR schema change needed if it
  only adds props (props are a free-form dict).
- New **animation verb**: add to `AnimationVerb` (both `ir.py` and `ir.ts`), handle it in
  `emit_animation`, and add to `CREATION_VERBS` if it introduces the object to the scene.
- A verb that can't emit (e.g. a transform with a missing target) returns `None`; the scene
  builder drops it. Preserve that contract.
