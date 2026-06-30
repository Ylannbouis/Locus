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

import re

from app.models.ir import Project, Scene
from app.codegen.animations import CREATION_VERBS, easing_func, emit_animation
from app.codegen.objects import (
    AXES_BOUND_GRAPHS, emit_object, tracker_name, var_name, _num, _point, _sweep,
)
from app.codegen.template import render_script

_INDENT = " " * 8

# Sentinel object id for keyframes that drive the camera (mirrors the frontend).
CAMERA_ID = "__camera__"

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


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------

def _is_camera_kf(kf) -> bool:
    return _enum(kf.verb) == "camera_move" or kf.object_id == CAMERA_ID


def _zoom(v) -> float:
    """A positive zoom factor (frame width = config.frame_width / zoom). Guards
    against a 0 / negative / malformed value that would yield an invalid width."""
    z = _num(v, 1.0)
    return z if z > 1e-6 else 1.0


def _uses_camera(scene: Scene) -> bool:
    """The scene needs MovingCameraScene if any keyframe drives the camera or the
    initial camera framing (pan/zoom) is non-default."""
    if any(_is_camera_kf(kf) for kf in scene.timeline.keyframes):
        return True
    ct = scene.camera_track
    if ct is None:
        return False
    px, py = _point(ct.initial_pan)
    return abs(px) > 1e-9 or abs(py) > 1e-9 or abs(_num(ct.initial_zoom, 1.0) - 1.0) > 1e-9


def _camera_anim(kf, var_map: dict[str, str]) -> str | None:
    """A camera_move keyframe -> a `self.camera.frame.animate…` expression.

    params: pan {x,y} (or focus_object_id to track an object's center) and an
    absolute zoom level (frame width = config.frame_width / zoom).
    """
    p = kf.params or {}
    parts: list[str] = []
    focus = p.get("focus_object_id")
    if focus and var_map.get(focus):
        parts.append(f"move_to({var_map[focus]}.get_center())")
    elif p.get("pan") is not None or p.get("target") is not None:
        x, y = _point(p.get("pan") if p.get("pan") is not None else p.get("target"))
        parts.append(f"move_to(np.array([{x}, {y}, 0.0]))")
    if p.get("zoom") is not None:
        parts.append(f"set(width=config.frame_width / {_zoom(p.get('zoom'))})")
    if not parts:
        return None
    return "self.camera.frame.animate." + ".".join(parts)


def _is_track_kf(kf, var_map: dict[str, str]) -> bool:
    """A camera keyframe that continuously follows an object (rather than a one-
    shot move): needs `track` set and a focus object that actually exists."""
    if not _is_camera_kf(kf):
        return False
    p = kf.params or {}
    foc = p.get("focus_object_id")
    return bool(p.get("track")) and bool(foc) and foc in var_map


def _kf_anim(kf, var_map: dict[str, str]) -> str | None:
    """Animation expression for any keyframe, routing camera keyframes specially."""
    if _is_camera_kf(kf):
        return _camera_anim(kf, var_map)
    v = var_map.get(kf.object_id)
    if not v:
        return None
    return emit_animation(_enum(kf.verb), v, kf.params, var_map)


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

    # 0. Initial camera framing (only meaningful under MovingCameraScene).
    if _uses_camera(scene):
        ct = scene.camera_track
        px, py = _point(ct.initial_pan) if ct else (0.0, 0.0)
        iz = _zoom(ct.initial_zoom) if ct else 1.0
        cam_init: list[str] = []
        if abs(px) > 1e-9 or abs(py) > 1e-9:
            cam_init.append(f"self.camera.frame.move_to(np.array([{px}, {py}, 0.0]))")
        if abs(iz - 1.0) > 1e-9:
            cam_init.append(f"self.camera.frame.set(width=config.frame_width / {iz})")
        if cam_init:
            lines.append("# initial camera framing")
            lines.extend(cam_init)
            lines.append("")

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
        if _is_track_kf(kf, var_map):
            continue  # emitted as camera-follow updater statements (4c) below
        if kf.group_id:
            grouped.setdefault(kf.group_id, []).append(kf)
        else:
            anim = _kf_anim(kf, var_map)
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
            a = _kf_anim(kf, var_map)
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

    # 4c. Continuous camera tracking: attach a follow-updater over the keyframe's
    # window so the camera stays centered on the object while it animates. The
    # add runs before any play at the same time (order 0) and the remove after
    # (order 2), so a move that overlaps the window is followed start to finish.
    for kf in ordered:
        if not _is_track_kf(kf, var_map):
            continue
        p = kf.params or {}
        foc = var_map[p["focus_object_id"]]
        fn = f"_camfollow_{re.sub(r'[^0-9a-zA-Z_]', '_', kf.id)}"
        start_lines = [f"{fn} = lambda f: f.move_to({foc}.get_center())"]
        if p.get("zoom") is not None:
            start_lines.append(f"self.camera.frame.set(width=config.frame_width / {_zoom(p.get('zoom'))})")
        # The frame's updater only runs during self.play() while the frame is in
        # the scene's mobject list, so add it before attaching the follow updater.
        start_lines.append("self.add(self.camera.frame)")
        start_lines.append(f"self.camera.frame.add_updater({fn})")
        start = max(0.0, float(kf.start_time))
        dur = max(0.01, float(kf.duration))
        events.append({"start": start, "kind": "stmt", "order": 0, "run_time": 0.0, "lines": start_lines})
        events.append({"start": start + dur, "kind": "stmt", "order": 2, "run_time": 0.0,
                       "lines": [f"self.camera.frame.remove_updater({fn})"]})

    # 5. Emit waits + plays (and tracking statements) in time order.
    events.sort(key=lambda e: (e["start"], e.get("order", 1)))
    current = 0.0
    played_any = False
    for ev in events:
        gap = ev["start"] - current
        if gap > 1e-6:
            lines.append(f"self.wait({round(gap, 4)})")
            current += gap
        if ev.get("kind") == "stmt":
            lines.extend(ev["lines"])
            continue
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
    base = "MovingCameraScene" if _uses_camera(scene) else "Scene"
    return render_script(body=body, background_color=bg, base_class=base)


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
