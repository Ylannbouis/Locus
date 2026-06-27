"""Map animation verbs to Manim Animation expressions (MVP subset)."""
from __future__ import annotations

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

# verb -> Manim Animation class name
_VERB_CLASS = {
    "write": "Write",
    "create": "Create",
    "draw_border_then_fill": "DrawBorderThenFill",
    "fade_in": "FadeIn",
    "fade_out": "FadeOut",
}


def emit_animation(verb: str, var: str) -> str | None:
    """Return the Animation expression (without run_time/rate_func), e.g. 'Write(m_x)'.

    Returns None for verbs not supported in the MVP.
    """
    cls = _VERB_CLASS.get(verb)
    if cls is None:
        return None
    return f"{cls}({var})"


def easing_func(easing: str) -> str:
    return EASING_MAP.get(easing, "smooth")
