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
CREATION_VERBS = {"write", "create", "draw_border_then_fill", "type_on", "fade_in"}

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

# Creation verbs that draw the mobject in (fade_in is excluded: a fade fuses into
# an `.animate` chain as `.set_opacity`, these need the LocusIntro wrapper instead).
# `type_on` counts as a drawing introducer for the *hide-until-creation* pass —
# it must not flash before its turn — but it is deliberately absent from _SIMPLE,
# which is what gates LocusIntro fusion. AddTextLetterByLetter is a
# ShowIncreasingSubsets: it swaps `mobject.submobjects` per frame instead of
# rebuilding the mobject from a captured start state, so LocusIntro's post-frame
# `m.shift(delta * t)` would accumulate every frame and fling the text off screen.
# `emit_intro_transform` returns None for it, and `_plan_intro_fusion`'s dry-run
# therefore never marks it fused — it falls back to standalone emission.
INTRO_VERBS = set(_SIMPLE) | {"type_on"}


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


def _rotate_call(params: dict[str, Any]) -> str:
    """The argument list of a `.rotate(...)` for a rotate keyframe: the angle,
    plus Manim's `about_point` when the keyframe pivots about a fixed scene
    point instead of the object's center."""
    angle = f"{_num(params.get('angle_degrees'), 90.0)} * DEGREES"
    about = _vec(params.get("about_point"))
    return f"{angle}, about_point={about}" if about else angle


def emit_animation(verb: str, var: str, params: dict[str, Any] | None = None,
                   var_map: dict[str, str] | None = None) -> str | None:
    """Return the Animation expression (without run_time/rate_func), or None if
    the verb can't be emitted (e.g. a transform whose target is missing)."""
    params = params or {}
    var_map = var_map or {}

    if verb in _SIMPLE:
        return f"{_SIMPLE[verb]}({var})"

    if verb == "type_on":
        # Typewriter reveal for a Pango `Text`: whole glyphs appear one at a time,
        # each already filled. Write/Create stroke-trace the glyph outline first,
        # which turns a textured font (Chalkduster and friends — hundreds of
        # jagged subpaths per word) into grey scribble for the whole animation.
        # run_time/rate_func are baked in by the scene builder, overriding this
        # class's time_per_char-derived default. Only meaningful on the Pango
        # path — `scene.build_body` degrades it to a Write elsewhere, since a
        # `Tex` is one submobject and would just pop in whole.
        return f"AddTextLetterByLetter({var})"

    if verb in ("fade_in", "fade_out"):
        # LocusFade (template helper), not FadeIn/FadeOut: it fades in place to
        # the authored opacity without ever removing the mobject from the scene
        # (FadeOut's remover clean-up resets its mobject to full visibility and
        # leaves grouped children reachable through play-internal Groups — the
        # "group fades out, everything reappears at the end" bug). An object
        # introduced by fade_in is pre-hidden by the scene builder so the fade
        # has something to reveal.
        alpha = 1.0 if verb == "fade_in" else 0.0
        shift = _vec(params.get("shift"))
        if shift:
            return f"LocusFade({var}, {alpha}, shift={shift})"
        return f"LocusFade({var}, {alpha})"

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
        return f"{var}.animate.rotate({_rotate_call(params)})"

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


# move/scale/rotate are `.animate` transforms; two separate `.animate`
# animations on the same mobject in one play fight over its state. When they run
# simultaneously we chain them onto one `.animate` instead (Manim applies the
# whole chain as a single interpolation). Chain order is fixed move->scale->
# rotate; for center-pivoted transforms the final target is order-independent
# (shift moves the center; scale and rotate about that center commute). A rotate
# with a fixed `about_point` does NOT commute with a move — rotate being last
# makes the convention "move first, then orbit the anchored pivot", which the
# frontend ghost preview mirrors (`motion.ts` applies keyframes in start order).
_CHAIN_ORDER = {"move": 0, "scale": 1, "rotate": 2}


def transform_chain_suffix(items: list[tuple[str, dict]]) -> str | None:
    """The method-chain suffix for a set of simultaneous move/scale/rotate,
    e.g. `.shift(v).scale(2)`, or None if nothing emits."""
    parts: list[str] = []
    for verb, params in sorted(items, key=lambda it: _CHAIN_ORDER.get(it[0], 9)):
        params = params or {}
        if verb == "move":
            tp = params.get("target_position")
            dl = params.get("delta")
            if isinstance(tp, dict):
                parts.append(f".move_to({_vec(tp)})")
            elif isinstance(dl, dict):
                parts.append(f".shift({_vec(dl)})")
        elif verb == "scale":
            parts.append(f".scale({_num(params.get('factor'), 1.5)})")
        elif verb == "rotate":
            parts.append(f".rotate({_rotate_call(params)})")
    return "".join(parts) if parts else None


def emit_transform_chain(var: str, items: list[tuple[str, dict]],
                         opacity: float | None = None) -> str | None:
    """Chain simultaneous move/scale/rotate into one `LocusApply` (template
    helper). `items` is a list of (verb, params). Returns e.g.
    `LocusApply(m, lambda _m: _m.shift(v).scale(2))`, or None if nothing emits.

    LocusApply builds its Transform target at begin() time from the mobject's
    *current* state, so it composes with everything played earlier in the same
    self.play — unlike `.animate` or a pre-built `Transform(m, m.copy()...)`
    target, which snapshot pre-play state (and would e.g. bake a hidden
    object's 0 opacity into a move, or resurrect an object that faded out
    earlier in the play).

    When `opacity` is given, a fade (fade_in → 1.0 / fade_out → 0.0) runs *at
    the same time* as this transform on the same mobject. Two separate
    animations on one mobject fight over its state, so the fade folds into the
    same LocusApply: the target's family fades to `opacity` × the authored
    opacity (for a fade_in the object was pre-hidden at opacity 0, so the
    fused target actually reads as a fade-in while it moves)."""
    chain = transform_chain_suffix(items)
    if chain is None and opacity is None:
        return None
    parts = [var]
    if chain:
        parts.append(f"lambda _m: _m{chain}")
    if opacity is not None:
        parts.append(f"opacity={float(opacity)}")
    return f"LocusApply({', '.join(parts)})"


def emit_intro_transform(intro_verb: str, var: str, items: list[tuple[str, dict]],
                         intro_span: tuple[float, float],
                         xform_span: tuple[float, float],
                         xform_rate: str) -> str | None:
    """A creation verb (write/create/draw_border_then_fill) fused with the
    simultaneous move/scale/rotate `items` on the same object, as a `LocusIntro(...)`
    call (a template helper: the creation animation applying the partial transform
    after each frame). A creation animation and a Transform on one mobject in the
    same play otherwise fight over its state — or, run in sequence, pop the object
    in before it is drawn.

    The transform items are folded to net numeric arguments with the same final
    state as `transform_chain_suffix` (a `.move_to` supersedes earlier shifts;
    deltas add; scale factors multiply; rotations add — but only rotations that
    share one pivot fold, so a cluster mixing center- and point-pivoted rotates
    returns None). Spans are (start, end) fractions of the fused animation's
    run_time. Returns None if the verb isn't a drawing creation or no transform
    argument survives (the caller falls back to separate emission)."""
    cls = _SIMPLE.get(intro_verb)
    if cls is None:
        return None
    move_to: tuple[float, float] | None = None
    dx = dy = 0.0
    scale = 1.0
    rot = 0.0
    rot_about: tuple[float, float] | None = None
    seen_rotate = False
    for verb, params in sorted(items, key=lambda it: _CHAIN_ORDER.get(it[0], 9)):
        params = params or {}
        if verb == "move":
            tp = params.get("target_position")
            dl = params.get("delta")
            if isinstance(tp, dict):
                move_to = (_num(tp.get("x"), 0.0), _num(tp.get("y"), 0.0))
                dx = dy = 0.0
            elif isinstance(dl, dict):
                dx += _num(dl.get("x"), 0.0)
                dy += _num(dl.get("y"), 0.0)
        elif verb == "scale":
            scale *= _num(params.get("factor"), 1.5)
        elif verb == "rotate":
            ap = params.get("about_point")
            about = ((_num(ap.get("x"), 0.0), _num(ap.get("y"), 0.0))
                     if isinstance(ap, dict) else None)
            if seen_rotate and about != rot_about:
                return None  # different pivots don't fold into one rotation
            seen_rotate = True
            rot_about = about
            rot += _num(params.get("angle_degrees"), 90.0)
    parts: list[str] = []
    if move_to is not None:
        parts.append(f"move_to=np.array([{move_to[0]}, {move_to[1]}, 0.0])")
    if abs(dx) > 1e-12 or abs(dy) > 1e-12:
        parts.append(f"shift=np.array([{round(dx, 6)}, {round(dy, 6)}, 0.0])")
    if abs(scale - 1.0) > 1e-12:
        parts.append(f"scale={round(scale, 6)}")
    if abs(rot) > 1e-12:
        parts.append(f"rotate={round(rot, 6)} * DEGREES")
        if rot_about is not None:
            parts.append(f"rotate_about=np.array([{rot_about[0]}, {rot_about[1]}, 0.0])")
    if not parts:
        return None
    parts.append(f"intro_span=({intro_span[0]}, {intro_span[1]})")
    parts.append(f"xform_span=({xform_span[0]}, {xform_span[1]})")
    parts.append(f"xform_rate={xform_rate}")
    return f"LocusIntro({cls}, {var}, {', '.join(parts)})"


def easing_func(easing: str) -> str:
    return EASING_MAP.get(easing, "smooth")
