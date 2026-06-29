"""Map animation verbs to Manim Animation expressions.

Each verb becomes the *inner* expression of a self.play(...) call; run_time and
rate_func are appended by the scene builder. Some verbs (move/scale/rotate) use
Manim's .animate syntax and act on an object that is already on screen; the rest
are Animation classes. Verbs that introduce an object are listed in
CREATION_VERBS so the scene builder knows not to pre-add those objects.
"""
from __future__ import annotations

from typing import Any

# Verbs that introduce a mobject into the scene. Objects whose first keyframe is
# one of these are animated in; all other objects are pre-added via self.add().
CREATION_VERBS = {"write", "create", "draw_border_then_fill", "fade_in"}

EASING_MAP = {
    "smooth": "smooth",
    "linear": "linear",
    "rush_from": "rush_from",
    "rush_into": "rush_into",
    "there_and_back": "there_and_back",
    "double_smooth": "double_smooth",
}

# verb -> Manim Animation class for the simple "act on one mobject" creations.
_SIMPLE = {
    "write": "Write",
    "create": "Create",
    "draw_border_then_fill": "DrawBorderThenFill",
}


def _num(v: Any, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _vec(p: Any) -> str | None:
    """A {x,y} dict or [x,y] list -> 'np.array([x, y, 0.0])'."""
    if isinstance(p, dict):
        return f"np.array([{_num(p.get('x'), 0.0)}, {_num(p.get('y'), 0.0)}, 0.0])"
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        return f"np.array([{_num(p[0], 0.0)}, {_num(p[1], 0.0)}, 0.0])"
    return None


def _args(parts: list[str]) -> str:
    return (", " + ", ".join(parts)) if parts else ""


def emit_animation(verb: str, var: str, params: dict[str, Any] | None = None,
                   var_map: dict[str, str] | None = None) -> str | None:
    """Return the Animation expression (without run_time/rate_func), or None if
    the verb can't be emitted (e.g. a transform whose target is missing)."""
    params = params or {}
    var_map = var_map or {}

    if verb in _SIMPLE:
        return f"{_SIMPLE[verb]}({var})"

    if verb in ("fade_in", "fade_out"):
        cls = "FadeIn" if verb == "fade_in" else "FadeOut"
        shift = _vec(params.get("shift"))
        return f"{cls}({var}, shift={shift})" if shift else f"{cls}({var})"

    if verb in ("transform", "replacement_transform", "morph_equation"):
        cls = {
            "transform": "Transform",
            "replacement_transform": "ReplacementTransform",
            "morph_equation": "TransformMatchingTex",
        }[verb]
        target = params.get("target_object_id") or params.get("target_tex_id")
        tvar = var_map.get(target) if target else None
        if not tvar:
            return None
        if verb == "morph_equation":
            key_map = params.get("key_map")
            pairs = {str(k): str(v) for k, v in key_map.items() if k and v} if isinstance(key_map, dict) else {}
            if pairs:
                items = ", ".join(f"{k!r}: {v!r}" for k, v in pairs.items())
                return f"{cls}({var}, {tvar}, key_map={{{items}}})"
        return f"{cls}({var}, {tvar})"

    if verb == "move":
        tp = params.get("target_position")
        dl = params.get("delta")
        if isinstance(tp, dict):
            return f"{var}.animate.move_to({_vec(tp)})"
        if isinstance(dl, dict):
            return f"{var}.animate.shift({_vec(dl)})"
        return None

    if verb == "scale":
        return f"{var}.animate.scale({_num(params.get('factor'), 1.5)})"

    if verb == "rotate":
        return f"{var}.animate.rotate({_num(params.get('angle_degrees'), 90.0)} * DEGREES)"

    if verb == "indicate":
        parts: list[str] = []
        if params.get("color"):
            parts.append(f"color={params['color']!r}")
        if params.get("scale_factor") is not None:
            parts.append(f"scale_factor={_num(params.get('scale_factor'), 1.2)}")
        return f"Indicate({var}{_args(parts)})"

    if verb == "circumscribe":
        parts = []
        if params.get("color"):
            parts.append(f"color={params['color']!r}")
        return f"Circumscribe({var}{_args(parts)})"

    if verb == "flash":
        parts = []
        if params.get("color"):
            parts.append(f"color={params['color']!r}")
        if params.get("flash_radius") is not None:
            parts.append(f"flash_radius={_num(params.get('flash_radius'), 0.5)}")
        if params.get("num_lines") is not None:
            parts.append(f"num_lines={int(_num(params.get('num_lines'), 12))}")
        return f"Flash({var}{_args(parts)})"

    return None


def easing_func(easing: str) -> str:
    return EASING_MAP.get(easing, "smooth")
