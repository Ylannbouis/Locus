"""Top-level codegen: turn a Scene IR into a runnable Manim script.

MVP: sequential timeline (no parallel groups, no camera). Keyframes are ordered
by start_time; gaps become self.wait(); each keyframe becomes one self.play().
"""
from __future__ import annotations

from app.models.ir import Project, Scene
from app.codegen.animations import CREATION_VERBS, easing_func, emit_animation
from app.codegen.objects import emit_object, var_name
from app.codegen.template import render_script

_INDENT = " " * 8


def _verb_str(kf) -> str:
    return kf.verb.value if hasattr(kf.verb, "value") else str(kf.verb)


def _easing_str(kf) -> str:
    return kf.easing.value if hasattr(kf.easing, "value") else str(kf.easing)


def _is_graph(obj) -> bool:
    return (obj.type.value if hasattr(obj.type, "value") else str(obj.type)) == "graph"


def build_body(scene: Scene) -> str:
    # Graphs reference a coordinate system (props.axes_ref) that must be defined
    # first, so emit all non-graph objects before graph objects (stable order).
    objects = sorted(scene.objects, key=_is_graph)
    keyframes = list(scene.timeline.keyframes)

    # Object ids that are introduced by a creation animation.
    created_ids = {kf.object_id for kf in keyframes if _verb_str(kf) in CREATION_VERBS}

    lines: list[str] = []
    var_map: dict[str, str] = {}

    # 1. Define + style every object (skip invisible ones).
    for obj in objects:
        if not obj.visible:
            continue
        # A graph references an axes that must already be defined; if its axes
        # was deleted or hidden, skip it rather than emit an undefined variable.
        if _is_graph(obj):
            axes_ref = (obj.props or {}).get("axes_ref")
            if not axes_ref or axes_ref not in var_map:
                continue
        var, obj_lines = emit_object(obj)
        var_map[obj.id] = var
        lines.append(f"# {obj.type.value if hasattr(obj.type, 'value') else obj.type}: {obj.name or obj.id}")
        lines.extend(obj_lines)
        lines.append("")

    # 2. Pre-add objects that are not animated in by a creation verb.
    pre_added = [obj for obj in objects if obj.id in var_map and obj.id not in created_ids]
    if pre_added:
        lines.append("# objects present from the first frame")
        for obj in pre_added:
            lines.append(f"self.add({var_map[obj.id]})")
        lines.append("")

    # 3. Timeline (sequential approximation).
    ordered = sorted(keyframes, key=lambda k: k.start_time)
    current = 0.0
    played_any = False
    for kf in ordered:
        var = var_map.get(kf.object_id)
        if var is None:
            continue
        anim = emit_animation(_verb_str(kf), var)
        if anim is None:
            continue
        gap = kf.start_time - current
        if gap > 1e-6:
            lines.append(f"self.wait({round(gap, 4)})")
            current += gap
        rate = easing_func(_easing_str(kf))
        run_time = max(0.01, float(kf.duration))
        lines.append(f"self.play({anim}, run_time={run_time}, rate_func={rate})")
        current += run_time
        played_any = True

    # 4. Hold the final frame so the export isn't truncated.
    lines.append("self.wait(0.5)" if played_any or pre_added else "self.wait(1.0)")

    return "\n".join(_INDENT + ln if ln else "" for ln in lines)


def generate_scene_script(project: Project, scene: Scene) -> str:
    bg = scene.background_color or project.settings.background_color or "#000000"
    body = build_body(scene)
    return render_script(body=body, background_color=bg)
