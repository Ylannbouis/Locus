"""Top-level codegen: turn a Scene IR into a runnable Manim script.

Timeline model:
  - Keyframes sharing a group_id play together in one self.play() (an
    AnimationGroup when the group's lag_ratio > 0, otherwise plain parallel).
  - Ungrouped keyframes each get their own self.play().
  - Events are ordered by start_time; gaps become self.wait().
Relationships (next_to / align_to / move_to_point / center_on) are applied after
all objects are constructed and before the timeline runs.
"""
from __future__ import annotations

from app.models.ir import Project, Scene
from app.codegen.animations import CREATION_VERBS, easing_func, emit_animation
from app.codegen.objects import (
    AXES_BOUND_GRAPHS, emit_object, tracker_name, var_name, _num, _sweep,
)
from app.codegen.template import render_script

_INDENT = " " * 8

# Relationship direction string -> Manim constant.
_DIR = {
    "UP": "UP", "DOWN": "DOWN", "LEFT": "LEFT", "RIGHT": "RIGHT",
    "UL": "UL", "UR": "UR", "DL": "DL", "DR": "DR",
}


def _enum(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _is_graph(obj) -> bool:
    return _enum(obj.type) == "graph"


def _is_group(obj) -> bool:
    return _enum(obj.type) == "group"


def _is_geometry(obj) -> bool:
    return _enum(obj.type) == "geometry"


def _emit_order(obj) -> int:
    # plain objects, then graphs (need axes), then geometry (may reference shapes/
    # targets), then groups (need their children defined first).
    if _is_group(obj):
        return 3
    if _is_geometry(obj):
        return 2
    if _is_graph(obj):
        return 1
    return 0


def _rel_line(rel, var_map: dict[str, str]) -> str | None:
    subj = var_map.get(rel.subject_id)
    if subj is None:
        return None
    rtype = _enum(rel.type)
    direction = _DIR.get((rel.direction or "UP").upper(), "UP")
    buff = round(float(rel.buff), 4)
    if rtype == "move_to_point":
        p = rel.target_point
        x = getattr(p, "x", 0.0) if p else 0.0
        y = getattr(p, "y", 0.0) if p else 0.0
        return f"{subj}.move_to(np.array([{x}, {y}, 0.0]))"
    anchor = var_map.get(rel.anchor_id)
    if anchor is None:
        return None
    if rtype == "next_to":
        return f"{subj}.next_to({anchor}, {direction}, buff={buff})"
    if rtype == "align_to":
        return f"{subj}.align_to({anchor}, {direction})"
    if rtype == "center_on":
        return f"{subj}.move_to({anchor}.get_center())"
    return None


def build_body(scene: Scene) -> str:
    # Emit in dependency order: plain objects, then graphs (need their axes),
    # then groups (need their children defined first).
    objects = sorted(scene.objects, key=_emit_order)
    keyframes = list(scene.timeline.keyframes)
    lag_by_group = {g.id: float(g.lag_ratio) for g in scene.timeline.groups}

    created_ids = {kf.object_id for kf in keyframes if _enum(kf.verb) in CREATION_VERBS}

    # Objects used only as a Transform/morph target are not added on their own;
    # the transform animation pulls them in, so exclude them from pre-add.
    _XFORM = {"transform", "replacement_transform", "morph_equation"}
    transform_targets = {
        tid for kf in keyframes if _enum(kf.verb) in _XFORM
        for tid in [(kf.params or {}).get("target_object_id") or (kf.params or {}).get("target_tex_id")]
        if tid
    }

    lines: list[str] = []
    var_map: dict[str, str] = {}

    # 1. Define + style every object (skip invisible ones).
    for obj in objects:
        if not obj.visible:
            continue
        if _is_graph(obj):
            # Only axes-bound graphs need a valid axes_ref; vector fields are
            # standalone. Skip a graph whose axes was deleted/hidden.
            if (obj.props or {}).get("subtype", "function_plot") in AXES_BOUND_GRAPHS:
                axes_ref = (obj.props or {}).get("axes_ref")
                if not axes_ref or axes_ref not in var_map:
                    continue
        if _is_geometry(obj):
            # An Angle needs both its lines; a Brace needs its target.
            p = obj.props or {}
            st = p.get("subtype", "vector")
            if st == "angle" and (p.get("line1_id") not in var_map or p.get("line2_id") not in var_map):
                continue
            if st == "brace" and p.get("target_id") not in var_map:
                continue
        if _is_group(obj):
            child_vars = [var_map[o.id] for o in objects
                          if o.parent_id == obj.id and o.id in var_map]
            if not child_vars:
                continue  # empty group -> nothing to emit
            var = var_name(obj.id)
            var_map[obj.id] = var
            lines.append(f"# group: {obj.name or obj.id}")
            lines.append(f"{var} = VGroup({', '.join(child_vars)})")
            if obj.z_index:
                lines.append(f"{var}.set_z_index({int(obj.z_index)})")
            lines.append("")
            continue
        var, obj_lines = emit_object(obj)
        var_map[obj.id] = var
        lines.append(f"# {_enum(obj.type)}: {obj.name or obj.id}")
        lines.extend(obj_lines)
        lines.append("")

    # 2. Relationships (relative positioning), after all objects exist.
    rel_lines = [ln for rel in scene.relationships if (ln := _rel_line(rel, var_map))]
    if rel_lines:
        lines.append("# relative positioning")
        lines.extend(rel_lines)
        lines.append("")

    # 3. Pre-add objects that are not animated in by a creation verb.
    # Children of a group are represented by their VGroup (added/created via the
    # group), so don't add them individually — unless the group itself has a child
    # with a creation verb (in which case the group must not be pre-added).
    groups_with_creation = {
        obj.id for obj in objects if _is_group(obj)
        and any(o.parent_id == obj.id and o.id in created_ids for o in objects)
    }
    pre_added = [obj for obj in objects if obj.id in var_map
                 and obj.id not in created_ids and obj.id not in transform_targets
                 and obj.parent_id is None
                 and not (_is_group(obj) and obj.id in groups_with_creation)]
    if pre_added:
        lines.append("# objects present from the first frame")
        for obj in pre_added:
            lines.append(f"self.add({var_map[obj.id]})")
        lines.append("")

    # Non-creation children of groups that were skipped above need to be visible
    # from the first frame even though their parent group is not pre-added.
    early_children = [
        obj for obj in objects
        if obj.parent_id in groups_with_creation and obj.id in var_map
        and obj.id not in created_ids and obj.id not in transform_targets
    ]
    if early_children:
        if not pre_added:
            lines.append("# objects present from the first frame")
        for obj in early_children:
            lines.append(f"self.add({var_map[obj.id]})")
        lines.append("")

    # 4. Build timeline events: grouped keyframes -> one play; singles -> one each.
    ordered = sorted(keyframes, key=lambda k: k.start_time)
    grouped: dict[str, list] = {}
    events: list[dict] = []  # {start, run_time, anims, easing, lag}
    for kf in ordered:
        if kf.group_id:
            grouped.setdefault(kf.group_id, []).append(kf)
        else:
            anim = emit_animation(_enum(kf.verb), var_map.get(kf.object_id, ""),
                                  kf.params, var_map) if var_map.get(kf.object_id) else None
            if anim is None:
                continue
            events.append({
                "start": kf.start_time,
                "run_time": max(0.01, float(kf.duration)),
                "anims": [anim],
                "easing": easing_func(_enum(kf.easing)),
                "lag": 0.0,
            })
    for gid, members in grouped.items():
        anims = []
        for kf in members:
            v = var_map.get(kf.object_id)
            if not v:
                continue
            a = emit_animation(_enum(kf.verb), v, kf.params, var_map)
            if a:
                anims.append(a)
        if not anims:
            continue
        first = members[0]
        events.append({
            "start": min(k.start_time for k in members),
            "run_time": max(0.01, max(float(k.duration) for k in members)),
            "anims": anims,
            "easing": easing_func(_enum(first.easing)),
            "lag": lag_by_group.get(gid, 0.0),
        })

    # 4b. Parameter sweeps: animate each swept plot's ValueTracker as its own
    # timeline event (the always_redraw curve follows automatically).
    for obj in objects:
        if obj.id not in var_map:
            continue
        sw = _sweep(obj)
        if not sw:
            continue
        events.append({
            "start": max(0.0, _num(sw.get("start_time"), 0.0)),
            "run_time": max(0.01, _num(sw.get("duration"), 3.0)),
            "anims": [f"{tracker_name(obj.id)}.animate.set_value({_num(sw.get('to'), 1.0)})"],
            "easing": easing_func(str(sw.get("easing", "linear"))),
            "lag": 0.0,
        })

    # 5. Emit waits + plays in time order.
    events.sort(key=lambda e: e["start"])
    current = 0.0
    played_any = False
    for ev in events:
        gap = ev["start"] - current
        if gap > 1e-6:
            lines.append(f"self.wait({round(gap, 4)})")
            current += gap
        if ev["lag"] > 1e-9 and len(ev["anims"]) > 1:
            inner = f"AnimationGroup({', '.join(ev['anims'])}, lag_ratio={round(ev['lag'], 4)})"
            lines.append(f"self.play({inner}, run_time={ev['run_time']}, rate_func={ev['easing']})")
        else:
            lines.append(f"self.play({', '.join(ev['anims'])}, run_time={ev['run_time']}, rate_func={ev['easing']})")
        current += ev["run_time"]
        played_any = True

    # 6. Hold the final frame so the export isn't truncated.
    lines.append("self.wait(0.5)" if played_any or pre_added else "self.wait(1.0)")

    return "\n".join(_INDENT + ln if ln else "" for ln in lines)


def generate_scene_script(project: Project, scene: Scene) -> str:
    bg = scene.background_color or project.settings.background_color or "#000000"
    body = build_body(scene)
    return render_script(body=body, background_color=bg)


def generate_morph_preview_script(project: Project, scene: Scene, keyframe_id: str) -> str:
    """A minimal scene that just plays one morph_equation keyframe (src → dst),
    for the 1-second 'Preview Morph' test render."""
    bg = scene.background_color or project.settings.background_color or "#000000"
    kf = next((k for k in scene.timeline.keyframes if k.id == keyframe_id), None)
    if kf is None:
        return render_script(body=_INDENT + "self.wait(0.2)", background_color=bg)

    by_id = {o.id: o for o in scene.objects}
    src = by_id.get(kf.object_id)
    target_id = (kf.params or {}).get("target_object_id") or (kf.params or {}).get("target_tex_id")
    dst = by_id.get(target_id) if target_id else None
    if src is None or dst is None:
        return render_script(body=_INDENT + "self.wait(0.2)", background_color=bg)

    lines: list[str] = []
    var_map: dict[str, str] = {}
    for obj in (src, dst):
        var, obj_lines = emit_object(obj)
        var_map[obj.id] = var
        lines.extend(obj_lines)
    # Center both so the preview is framed regardless of their scene position.
    lines.append(f"{var_map[src.id]}.move_to(ORIGIN)")
    lines.append(f"{var_map[dst.id]}.move_to(ORIGIN)")
    lines.append(f"self.add({var_map[src.id]})")
    lines.append("self.wait(0.3)")
    anim = emit_animation("morph_equation", var_map[src.id], kf.params, var_map)
    if anim:
        lines.append(f"self.play({anim}, run_time=1.0, rate_func={easing_func(_enum(kf.easing))})")
    lines.append("self.wait(0.6)")
    body = "\n".join(_INDENT + ln for ln in lines)
    return render_script(body=body, background_color=bg)
