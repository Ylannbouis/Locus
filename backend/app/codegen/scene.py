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
from pathlib import Path

from app.models.ir import AnimationVerb, Project, Scene
from app.codegen.animations import (
    CREATION_VERBS, INTRO_VERBS, easing_func, emit_animation, emit_intro_transform,
    emit_transform_chain,
)
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


def _is_image(obj) -> bool:
    return _enum(obj.type) == "image"


# Vector-drawing verbs that can't run on a raster ImageMobject (Write/Create/…
# need VMobject points and raise in Manim) — they degrade to a FadeIn.
_VECTOR_ONLY_VERBS = {"write", "create", "draw_border_then_fill"}


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
    """A camera_move keyframe -> a `MasApply(self.camera.frame, …)` expression.

    params: pan {x,y} (or focus_object_id to track an object's center) and an
    absolute zoom level (frame width = config.frame_width / zoom).

    **Never `.animate` here.** `m.animate` parks its target in the mobject's
    single `m.target` slot, and a builder only becomes an Animation when the
    enclosing AnimationGroup/Succession is constructed — which happens *after*
    every builder in the play has been built. Several camera moves in one play
    would therefore all read the same (last) `frame.target` and animate to the
    last keyframe's framing, so only that one appeared to do anything. MasApply
    builds its target at `begin()` from the live frame instead, which also means
    a pan-only keyframe keeps whatever zoom the previous one left (and a focus
    keyframe reads the object's position *when the move starts*, matching the
    editor's ghost preview) — same reasoning as object transforms, see
    `template.MasApply`.
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
    return "MasApply(self.camera.frame, lambda _m: _m." + ".".join(parts) + ")"


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


def _bake(expr: str, run_time: float, rate_func: str) -> str:
    """Bake run_time + rate_func into an animation expression so it can carry its
    own timing inside an AnimationGroup / Succession (the overlapping timeline)."""
    rt = round(float(run_time), 4)
    if ".animate." in expr:
        # m.animate.method(...) -> m.animate(run_time=…, rate_func=…).method(...)
        return expr.replace(".animate.", f".animate(run_time={rt}, rate_func={rate_func}).", 1)
    # Animation-class call: insert the kwargs before the final ')'.
    return f"{expr[:-1]}, run_time={rt}, rate_func={rate_func})"


# `.animate` transform verbs — multiple of these on the same object at the same
# time must be chained into one `.animate` (they'd otherwise fight over state).
_XFORM_ANIM = {"move", "scale", "rotate"}
# Fade verbs — a fade that overlaps a transform on the *same* object is likewise
# fused into that transform's `.animate` chain (as `.set_opacity`), because two
# animations on one mobject in the same play fight over its state.
_FADE_ANIM = {"fade_in", "fade_out"}


def _kf_window(kf) -> tuple[float, float]:
    s = float(kf.start_time)
    return s, s + max(0.01, float(kf.duration))


def _time_clusters(kfs) -> list[dict]:
    """Group keyframes into clusters that overlap in time (transitively). Each
    cluster is `{start, end, kfs}`. Input order-independent (sorted internally)."""
    clusters: list[dict] = []
    for kf in sorted(kfs, key=lambda k: (float(k.start_time), float(k.duration))):
        s, e = _kf_window(kf)
        if clusters and s < clusters[-1]["end"] - 1e-6:
            clusters[-1]["kfs"].append(kf)
            clusters[-1]["end"] = max(clusters[-1]["end"], e)
        else:
            clusters.append({"start": s, "end": e, "kfs": [kf]})
    return clusters


def _plan_fade_fusion(keyframes, var_map: dict[str, str],
                      lag_by_group: dict[str, float]) -> set[str]:
    """Decide which fade keyframes fuse into a simultaneous same-object
    transform: fades that overlap a move/scale/rotate on the same object
    (within the same play bucket) become the `opacity` of that transform's
    `MasApply` instead of a standalone MasFade — two separate animations on
    one mobject in the same play fight over its state.

    Fades only fuse with transforms that end up merged into one MasApply, i.e.
    inside the same bucket: ungrouped (`group_id is None`) or a parallel group
    (lag_ratio ~ 0). Staggered groups play sequentially and are left alone."""
    buckets: dict[object, list] = {}
    for kf in keyframes:
        buckets.setdefault(kf.group_id, []).append(kf)

    fused: set[str] = set()
    for gid, members in buckets.items():
        if gid is not None and lag_by_group.get(gid, 0.0) > 1e-9:
            continue  # staggered group: members stay separate, no fusion
        xform_by_obj: dict[str, list] = {}
        fade_by_obj: dict[str, list] = {}
        for kf in members:
            verb = _enum(kf.verb)
            if verb in _XFORM_ANIM and var_map.get(kf.object_id):
                xform_by_obj.setdefault(kf.object_id, []).append(kf)
            elif verb in _FADE_ANIM and var_map.get(kf.object_id):
                fade_by_obj.setdefault(kf.object_id, []).append(kf)
        for oid, xfs in xform_by_obj.items():
            clusters = _time_clusters(xfs)
            for f in fade_by_obj.get(oid, []):
                fs, fe = _kf_window(f)
                if any(fs < c["end"] - 1e-6 and fe > c["start"] + 1e-6 for c in clusters):
                    fused.add(f.id)
    return fused


def _plan_intro_fusion(keyframes, var_map: dict[str, str],
                       lag_by_group: dict[str, float],
                       fused_fade_ids: set[str]) -> set[str]:
    """Decide which drawing-creation keyframes (write/create/draw_border_then_fill)
    fuse with a simultaneous same-object move/scale/rotate into one `MasIntro`
    animation (the creation applying the partial transform after each frame).

    A creation animation and a Transform on one mobject in the same play fight
    over its state; chained into a Succession instead, the transform pops the
    object in fully visible before the creation draws it. Same bucket rules as
    `_plan_fade_fusion`: ungrouped or parallel groups only. A cluster that already
    fuses a fade keeps the fade (an Animation-class intro can't join an `.animate`
    chain), so its intro stays standalone. One intro per cluster (the earliest)."""
    buckets: dict[object, list] = {}
    for kf in keyframes:
        buckets.setdefault(kf.group_id, []).append(kf)
    fused: set[str] = set()
    for gid, members in buckets.items():
        if gid is not None and lag_by_group.get(gid, 0.0) > 1e-9:
            continue  # staggered group: members stay separate, no fusion
        xform_by_obj: dict[str, list] = {}
        intro_by_obj: dict[str, list] = {}
        fade_by_obj: dict[str, list] = {}
        for kf in members:
            verb = _enum(kf.verb)
            if not var_map.get(kf.object_id):
                continue
            if verb in _XFORM_ANIM:
                xform_by_obj.setdefault(kf.object_id, []).append(kf)
            elif verb in INTRO_VERBS:
                intro_by_obj.setdefault(kf.object_id, []).append(kf)
            elif verb in _FADE_ANIM and kf.id in fused_fade_ids:
                fade_by_obj.setdefault(kf.object_id, []).append(kf)
        for oid, xfs in xform_by_obj.items():
            intros = intro_by_obj.get(oid)
            if not intros:
                continue
            fades = fade_by_obj.get(oid, [])
            for c in _time_clusters(xfs):
                s, e = c["start"], c["end"]
                if any(_kf_window(f)[0] < e - 1e-6 and _kf_window(f)[1] > s + 1e-6
                       for f in fades):
                    continue
                over = [k for k in intros
                        if _kf_window(k)[0] < e - 1e-6 and _kf_window(k)[1] > s + 1e-6]
                if not over:
                    continue
                ikf = min(over, key=lambda k: float(k.start_time))
                items = [(_enum(k.verb), k.params or {}) for k in c["kfs"]]
                # Dry-run: only mark the intro fused if the cluster actually
                # yields transform arguments (malformed params → fall back to the
                # normal reveal/standalone paths, which must then own this kf).
                if emit_intro_transform(_enum(ikf.verb), "_m", items,
                                        (0.0, 1.0), (0.0, 1.0), "smooth") is not None:
                    fused.add(ikf.id)
    return fused


def _merge_units(members, var_map: dict[str, str],
                 hidden_ids: set[str] | None = None,
                 fused_fade_ids: set[str] | None = None,
                 fused_intro_ids: set[str] | None = None) -> list[tuple]:
    """Turn a set of keyframes into units, chaining move/scale/rotate on the *same
    object* that **overlap in time** into a single `MasApply` over the union
    window (two animations on one mobject in one play fight over its state).
    Non-overlapping transforms and every other verb stay one unit each. Order of
    first appearance is preserved.

    Each unit is `(obj_id, expr, run_time, rate_func, start, reveal, intro)`:
      - `obj_id` — its target mobject (camera keyframes → `CAMERA_ID`), so the
        caller can chain a mobject's several units into one sequential track (Manim
        can't run two animations on one mobject in the same play — `_object_tracks`).
      - `intro` — a fused creation+transform (`MasIntro(...)` expression).
      - `reveal` — the object is hidden until its creation animation and this
        fused intro *is* that creation: `_object_tracks` restores the authored
        opacity (`MasFade(…, 1.0)`) immediately before it so the creation draws
        the object visible.

    `hidden_ids` holds objects hidden (set_opacity(0)) until a drawing creation
    verb reveals them. `fused_fade_ids` (from `_plan_fade_fusion`) holds fade
    keyframes to fold into the overlapping same-object transform as the
    MasApply's `opacity`; `fused_intro_ids` (from `_plan_intro_fusion`) creation
    keyframes to fuse with their overlapping transform cluster as one `MasIntro`
    — both are consumed here instead of emitting their own standalone unit. A
    fused keyframe whose cluster is not in this call's member set (the
    sequential model splits plays by start time) falls back to a standalone
    unit so it is never dropped."""
    hidden_ids = hidden_ids or set()
    fused_fade_ids = fused_fade_ids or set()
    fused_intro_ids = fused_intro_ids or set()
    xform_by_obj: dict[str, list] = {}
    fade_by_obj: dict[str, list] = {}
    intro_by_obj: dict[str, list] = {}
    order: list[tuple[str, object]] = []
    for kf in members:
        verb = _enum(kf.verb)
        if verb in _XFORM_ANIM and var_map.get(kf.object_id):
            if kf.object_id not in xform_by_obj:
                order.append(("x", kf.object_id))
            xform_by_obj.setdefault(kf.object_id, []).append(kf)
        elif verb in _FADE_ANIM and kf.id in fused_fade_ids and var_map.get(kf.object_id):
            # Consumed by the object's transform cluster below (not its own unit).
            fade_by_obj.setdefault(kf.object_id, []).append(kf)
        elif verb in INTRO_VERBS and kf.id in fused_intro_ids and var_map.get(kf.object_id):
            # Fuses with the object's transform cluster below (MasIntro).
            intro_by_obj.setdefault(kf.object_id, []).append(kf)
        else:
            a = _kf_anim(kf, var_map)
            if a is not None:
                order.append(("e", (kf.object_id, a, max(0.01, float(kf.duration)),
                                    easing_func(_enum(kf.easing)), float(kf.start_time),
                                    False, False)))

    units: list[tuple] = []
    seen: set[str] = set()
    consumed: set[str] = set()  # fused fade/intro kfs actually folded into a cluster
    for kind, val in order:
        if kind == "e":
            units.append(val)  # type: ignore[arg-type]
            continue
        obj_id = val  # type: ignore[assignment]
        if obj_id in seen:
            continue
        seen.add(obj_id)
        # Cluster this object's transforms by time overlap (transitively); each
        # cluster of >1 collapses to one chained MasApply over the union window,
        # so overlapping move+scale+rotate combine even with slightly different
        # start times / durations.
        clusters = _time_clusters(xform_by_obj[obj_id])
        fades = fade_by_obj.get(obj_id, [])
        intros = intro_by_obj.get(obj_id, [])
        for cl in clusters:
            ckfs = cl["kfs"]
            start, end = cl["start"], cl["end"]
            rf = easing_func(_enum(ckfs[0].easing))
            items = [(_enum(k.verb), k.params or {}) for k in ckfs]
            cl_fades = [f for f in fades
                        if _kf_window(f)[0] < end - 1e-6 and _kf_window(f)[1] > start + 1e-6]
            cl_intros = [k for k in intros
                         if _kf_window(k)[0] < end - 1e-6 and _kf_window(k)[1] > start + 1e-6]
            if cl_intros and not cl_fades:
                # A creation verb overlapping this cluster: fuse into one MasIntro
                # (the creation drawing the object while the partial transform is
                # applied each frame) over the union window. The intro's easing
                # drives the drawing; the cluster's easing drives the transform.
                ikf = min(cl_intros, key=lambda k: float(k.start_time))
                iws, iwe = _kf_window(ikf)
                u0, u1 = min(start, iws), max(end, iwe)
                rt = max(0.01, u1 - u0)
                ispan = (round((iws - u0) / rt, 4), round((iwe - u0) / rt, 4))
                xspan = (round((start - u0) / rt, 4), round((end - u0) / rt, 4))
                expr = emit_intro_transform(_enum(ikf.verb), var_map[obj_id], items,
                                            ispan, xspan, rf)
                if expr is not None:
                    consumed.add(ikf.id)
                    units.append((obj_id, expr, rt, easing_func(_enum(ikf.easing)),
                                  u0, obj_id in hidden_ids, True))
                    continue
            # Fold in any fused fade that overlaps this cluster: its final opacity
            # becomes the MasApply's `opacity`, and it widens the union window.
            opacity: float | None = None
            if cl_fades:
                consumed.update(f.id for f in cl_fades)
                last = max(cl_fades, key=lambda f: float(f.start_time))
                opacity = 1.0 if _enum(last.verb) == "fade_in" else 0.0
                start = min(start, min(_kf_window(f)[0] for f in cl_fades))
                end = max(end, max(_kf_window(f)[1] for f in cl_fades))
            rt = max(0.01, end - start)
            expr = emit_transform_chain(var_map[obj_id], items, opacity=opacity)
            if expr is not None:
                units.append((obj_id, expr, rt, rf, start, False, False))
    # Safety net: a fade/intro marked fused whose transform cluster isn't in this
    # call's member set (sequential-model plays split by start time) still emits
    # standalone rather than being dropped.
    for by_obj in (fade_by_obj, intro_by_obj):
        for kfs in by_obj.values():
            for kf in kfs:
                if kf.id in consumed:
                    continue
                a = _kf_anim(kf, var_map)
                if a is not None:
                    units.append((kf.object_id, a, max(0.01, float(kf.duration)),
                                  easing_func(_enum(kf.easing)), float(kf.start_time),
                                  False, False))
    return units


def _object_tracks(units, var_map: dict[str, str]) -> list[tuple[float, str]]:
    """Combine `_merge_units` units into per-mobject tracks, giving each mobject
    exactly **one** track so we never run two animations on one mobject as
    separate parallel tracks in a single `self.play` — Manim clobbers those (two
    Transforms fight each frame over the mobject's state). An object that e.g.
    fades in + moves, then later fades out + moves, must run its clusters in
    sequence: a mobject's several units become one
    `Succession(seg, Wait(gap), seg, …)`.

    Segments need no pre-built target copies: every MasApply/MasFade builds its
    target at its own begin() time (Succession begins segments lazily), so each
    segment composes with whatever state the previous ones left on the live
    mobject — including fades, whose opacity would otherwise be clobbered by a
    pre-play target snapshot."""
    by_obj: dict[str, list] = {}
    order: list[str] = []
    for u in units:
        oid = u[0]
        if oid not in by_obj:
            order.append(oid)
        by_obj.setdefault(oid, []).append(u)

    tracks: list[tuple[float, str]] = []
    for oid in order:
        us = sorted(by_obj[oid], key=lambda u: u[4])
        var = var_map.get(oid)
        segs: list[str] = []
        prev_end: float | None = None
        for (_, expr, rt, rf, start, reveal, intro) in us:
            if prev_end is not None and start - prev_end > 1e-6:
                segs.append(f"Wait({round(start - prev_end, 4)})")
            if intro and reveal and var is not None:
                # Hidden-until-creation object whose introducer is a fused
                # MasIntro: restore the authored opacity the instant before the
                # creation draws it in (opacity only — geometry stays put).
                segs.append(f"MasFade({var}, 1.0, run_time=0.001)")
            segs.append(_bake(expr, rt, rf))
            prev_end = start + rt
        tracks.append((us[0][4],
                       segs[0] if len(segs) == 1 else f"Succession({', '.join(segs)})"))
    return tracks


def build_body(scene: Scene, assets_root: str | None = None) -> str:
    # Emit in dependency order: plain objects, then graphs (need their axes),
    # then groups (need their children defined first).
    objects = sorted(scene.objects, key=_emit_order)
    keyframes = list(scene.timeline.keyframes)
    lag_by_group = {g.id: float(g.lag_ratio) for g in scene.timeline.groups}

    # A Write/Create/DrawBorderThenFill on a raster image would raise in Manim
    # (they need VMobject points) — normalize to FadeIn. fade_in is also a
    # creation verb, so the hide-until-creation pass below is unaffected.
    image_ids = {o.id for o in scene.objects if _is_image(o)}
    if image_ids:
        keyframes = [
            kf.model_copy(update={"verb": AnimationVerb.FADE_IN})
            if kf.object_id in image_ids and _enum(kf.verb) in _VECTOR_ONLY_VERBS
            else kf
            for kf in keyframes
        ]

    # Groups that (transitively) contain an image — these must emit as `Group`,
    # not `VGroup` (which rejects non-vector mobjects).
    image_group_ids: set[str] = set()
    if image_ids:
        by_id = {o.id: o for o in scene.objects}
        for oid in image_ids:
            cur = by_id.get(oid)
            while cur is not None and cur.parent_id and cur.parent_id not in image_group_ids:
                image_group_ids.add(cur.parent_id)
                cur = by_id.get(cur.parent_id)

    # Objects *introduced* by a creation verb: the creation (write/create/
    # draw_border_then_fill/fade_in) is the object's first keyframe (tie →
    # creation verbs first). These are animated in, so they are not pre-added.
    # An object whose earliest keyframe is something else — e.g. a fade_out
    # that a later fade_in undoes — was authored as initially visible and must
    # be pre-added like any other object. Likewise a fade_in does not introduce
    # an object when an *ancestor group* fades out before it (fading the family
    # out implies it started visible — e.g. outer group fades out, inner group
    # fades back in).
    kfs_by_obj: dict[str, list] = {}
    for kf in keyframes:
        kfs_by_obj.setdefault(kf.object_id, []).append(kf)
    obj_by_id = {o.id: o for o in objects}

    def _first_kf(oks):
        return min(oks, key=lambda k: (float(k.start_time),
                                       0 if _enum(k.verb) in CREATION_VERBS else 1))

    def _ancestor_fadeout_before(oid: str, t: float) -> bool:
        cur = obj_by_id.get(oid)
        seen: set[str] = set()
        while cur is not None and cur.parent_id and cur.parent_id not in seen:
            seen.add(cur.parent_id)
            for k in kfs_by_obj.get(cur.parent_id, []):
                if _enum(k.verb) == "fade_out" and float(k.start_time) < t - 1e-9:
                    return True
            cur = obj_by_id.get(cur.parent_id)
        return False

    created_ids: set[str] = set()
    for oid, oks in kfs_by_obj.items():
        first = _first_kf(oks)
        verb = _enum(first.verb)
        if verb not in CREATION_VERBS:
            continue
        if verb == "fade_in" and _ancestor_fadeout_before(oid, float(first.start_time)):
            continue
        created_ids.add(oid)

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
        if _is_image(obj):
            # No asset yet (or the file was deleted) → nothing to render; skip
            # rather than emit an ImageMobject that crashes the whole run.
            asset = str((obj.props or {}).get("asset") or "")
            if not asset:
                continue
            if assets_root and not (Path(assets_root) / asset).is_file():
                continue
        if _is_group(obj):
            child_vars = [var_map[o.id] for o in objects
                          if o.parent_id == obj.id and o.id in var_map]
            if not child_vars:
                continue  # empty group -> nothing to emit
            var = var_name(obj.id)
            var_map[obj.id] = var
            # VGroup only accepts VMobjects — a group with a raster image child
            # (direct or via a nested group) must be a generic Group instead.
            ctor = "Group" if obj.id in image_group_ids else "VGroup"
            lines.append(f"# group: {obj.name or obj.id}")
            lines.append(f"{var} = {ctor}({', '.join(child_vars)})")
            if obj.z_index:
                lines.append(f"{var}.set_z_index({int(obj.z_index)})")
            lines.append("")
            continue
        var, obj_lines = emit_object(obj, assets_root)
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

    # 2b. Hide-until-creation. Two kinds of objects must start at opacity 0:
    #   - Objects introduced by a **fade_in** (their earliest creation verb), in
    #     *both* emission models: fades emit `MasFade`, which drives opacity
    #     toward the authored value — on an already-visible mobject a fade_in
    #     would be a no-op, and the play's wrapper Group exposes the mobject
    #     from t=0 anyway (MasFade is not a Manim introducer).
    #   - Objects introduced by a *delayed* drawing verb (Write/Create/…) that
    #     are otherwise exposed at t=0 — Manim adds the play's wrapper Group
    #     (all non-introducer animations' mobjects) when the play starts, so an
    #     object that also has a fade/move/… (or whose ancestor group has one)
    #     pops into view before its creation plays. Timeline model only; the
    #     sequential model adds objects per-play.
    # Hidden objects `save_state()` first: MasFade reads the authored opacity
    # from `saved_state`, and the reveal (`MasFade(m, 1.0, run_time=0.001)`
    # right before the introducer) restores opacity without touching geometry.
    ordered = sorted(keyframes, key=lambda k: k.start_time)
    uses_tracking = any(_is_track_kf(kf, var_map) for kf in keyframes)

    # A fade (in/out) overlapping a transform on the same object is fused into
    # that transform's MasApply as its `opacity` — two animations on one mobject
    # would otherwise fight.
    fused_fade_ids = _plan_fade_fusion(keyframes, var_map, lag_by_group)
    # Likewise a write/create/draw_border_then_fill overlapping a transform on the
    # same object fuses into one MasIntro (creation + partial transform per frame).
    fused_intro_ids = _plan_intro_fusion(keyframes, var_map, lag_by_group, fused_fade_ids)

    # Objects introduced by a fade_in (per `created_ids` above): pre-hidden so
    # the MasFade has something to reveal. Transform/morph targets are skipped:
    # the transform interpolates *toward* them, and hiding would bake opacity 0
    # into that target.
    fade_intro_ids = [oid for oid, oks in kfs_by_obj.items()
                      if oid in created_ids and oid in var_map
                      and oid not in transform_targets
                      and _enum(_first_kf(oks).verb) == "fade_in"]

    reveal_kf_id: dict[str, str] = {}  # obj_id -> the creation keyframe to un-hide at
    if not uses_tracking:
        def _has_exposing_kf(oid: str) -> bool:
            # Every verb except the drawing introducers (Write/Create/…) emits a
            # non-introducer Manim animation (MasFade/MasApply/Indicate/…) whose
            # mobject joins the play's wrapper Group at t=0.
            return any(_enum(k.verb) not in INTRO_VERBS for k in kfs_by_obj.get(oid, []))

        # An object is exposed early if it — *or any ancestor group* — has an
        # exposing animation: a group's own animation pulls the whole VGroup
        # (including a not-yet-created child) into the play.
        def _exposed_early(oid: str) -> bool:
            if _has_exposing_kf(oid):
                return True
            cur = obj_by_id.get(oid)
            seen: set[str] = set()
            while cur is not None and cur.parent_id and cur.parent_id not in seen:
                seen.add(cur.parent_id)
                if _has_exposing_kf(cur.parent_id):
                    return True
                cur = obj_by_id.get(cur.parent_id)
            return False

        for oid, oks in kfs_by_obj.items():
            if oid not in var_map or oid in fade_intro_ids:
                continue
            # On a start-time tie, the creation verb counts as first: a write and
            # a move starting at the same instant introduce the object via the
            # write (fused into a MasIntro), so it must still hide until then.
            oks = sorted(oks, key=lambda k: (float(k.start_time),
                                             0 if _enum(k.verb) in CREATION_VERBS else 1))
            first = oks[0]
            if first.group_id or _enum(first.verb) not in INTRO_VERBS:
                continue                                   # not intro'd by a lone drawing verb
            if float(first.start_time) <= 1e-3:
                continue                                   # created at t=0 → no early window
            if not _exposed_early(oid):
                continue                                   # never pre-added → Manim won't flash it
            reveal_kf_id[oid] = first.id

    hide_ids = fade_intro_ids + [oid for oid in reveal_kf_id if oid not in fade_intro_ids]

    # Snapshot the authored look of every object a fade touches (plus the
    # hidden ones): MasFade / MasApply(opacity=…) restore opacity from
    # `saved_state`. The snapshot must be a scene-setup statement — in the
    # sequential model each play's animations are constructed mid-scene, after
    # an earlier fade_out may already have zeroed the live opacity.
    fade_obj_ids = {kf.object_id for kf in keyframes if _enum(kf.verb) in _FADE_ANIM}
    save_ids = [o.id for o in objects
                if o.id in var_map and (o.id in fade_obj_ids or o.id in hide_ids)]
    if save_ids:
        lines.append("# snapshot the authored look (fades restore opacity from saved_state)")
        for oid in save_ids:
            lines.append(f"{var_map[oid]}.save_state()")
        lines.append("")
    if hide_ids:
        lines.append("# start hidden until the creation animation reveals them")
        for oid in hide_ids:
            lines.append(f"{var_map[oid]}.set_opacity(0)")
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

    # 4. Lay out the timeline. Two emission models (`ordered` / `uses_tracking`
    #    were computed above for the hide pass).
    played_any = False

    if uses_tracking:
        # --- Sequential model -------------------------------------------------
        # Continuous camera tracking needs add/remove-updater *statements* timed
        # between plays, which a single self.play can't express — so emit a play
        # per time slot with self.wait() gaps. Keyframes sharing a group_id (or a
        # start time) collapse into one parallel play.
        grouped: dict[str, list] = {}
        ungrouped_by_start: dict[float, list] = {}
        events: list[dict] = []  # {start, run_time, anims, easing, lag} | stmt
        for kf in ordered:
            if _is_track_kf(kf, var_map):
                continue
            if kf.group_id:
                grouped.setdefault(kf.group_id, []).append(kf)
            else:
                ungrouped_by_start.setdefault(round(float(kf.start_time), 4), []).append(kf)

        for start, members in ungrouped_by_start.items():
            # Same object_id + same start → chain move/scale/rotate together.
            anims = [u[1] for u in _merge_units(members, var_map, set(reveal_kf_id),
                                                fused_fade_ids, fused_intro_ids)]
            if not anims:
                continue
            events.append({"start": start, "run_time": max(0.01, max(float(k.duration) for k in members)),
                           "anims": anims, "easing": easing_func(_enum(members[0].easing)), "lag": 0.0})
        for gid, members in grouped.items():
            lag = lag_by_group.get(gid, 0.0)
            if lag <= 1e-9:
                anims = [u[1] for u in _merge_units(members, var_map, set(reveal_kf_id),
                                                    fused_fade_ids, fused_intro_ids)]
            else:
                anims = [a for kf in members if (a := _kf_anim(kf, var_map)) is not None]
            if not anims:
                continue
            events.append({"start": min(k.start_time for k in members),
                           "run_time": max(0.01, max(float(k.duration) for k in members)),
                           "anims": anims, "easing": easing_func(_enum(members[0].easing)),
                           "lag": lag})
        for obj in objects:  # parameter sweeps
            if obj.id not in var_map:
                continue
            sw = _sweep(obj)
            if not sw:
                continue
            events.append({"start": max(0.0, _num(sw.get("start_time"), 0.0)),
                           "run_time": max(0.01, _num(sw.get("duration"), 3.0)),
                           "anims": [f"{tracker_name(obj.id)}.animate.set_value({_num(sw.get('to'), 1.0)})"],
                           "easing": easing_func(str(sw.get("easing", "linear"))), "lag": 0.0})
        for kf in ordered:  # camera-follow updater statements
            if not _is_track_kf(kf, var_map):
                continue
            p = kf.params or {}
            foc = var_map[p["focus_object_id"]]
            fn = f"_camfollow_{re.sub(r'[^0-9a-zA-Z_]', '_', kf.id)}"
            start_lines = [f"{fn} = lambda f: f.move_to({foc}.get_center())"]
            if p.get("zoom") is not None:
                start_lines.append(f"self.camera.frame.set(width=config.frame_width / {_zoom(p.get('zoom'))})")
            start_lines.append("self.add(self.camera.frame)")
            start_lines.append(f"self.camera.frame.add_updater({fn})")
            start = max(0.0, float(kf.start_time))
            dur = max(0.01, float(kf.duration))
            events.append({"start": start, "kind": "stmt", "order": 0, "run_time": 0.0, "lines": start_lines})
            events.append({"start": start + dur, "kind": "stmt", "order": 2, "run_time": 0.0,
                           "lines": [f"self.camera.frame.remove_updater({fn})"]})

        events.sort(key=lambda e: (e["start"], e.get("order", 1)))
        current = 0.0
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
    else:
        # --- Timeline model ---------------------------------------------------
        # Every animation becomes a track inside one AnimationGroup; each carries
        # its own run_time + easing and a Succession(Wait(delay), …) offsets its
        # start, so animations overlap exactly as laid out — different start/end
        # times included.
        tracks: list[tuple[float, str]] = []
        grouped: dict[str, list] = {}
        ungrouped: list = []
        # A reveal keyframe that fuses with a transform (MasIntro) stays in the
        # normal flow — the fused unit carries its own reveal (see
        # `_object_tracks`) — instead of the standalone Succession(MasFade, …).
        reveal_kf_ids = set(reveal_kf_id.values()) - fused_intro_ids
        reveal_kfs: list = []
        for kf in ordered:
            if kf.group_id:
                grouped.setdefault(kf.group_id, []).append(kf)
            elif kf.id in reveal_kf_ids:
                reveal_kfs.append(kf)
            else:
                ungrouped.append(kf)
        # Ungrouped: simultaneous move/scale/rotate on one object collapse to a
        # single MasApply track; a mobject's several (non-overlapping) clusters
        # chain into one sequential track (Manim can't run two animations on one
        # mobject as parallel tracks — see `_object_tracks`).
        tracks.extend(_object_tracks(
            _merge_units(ungrouped, var_map, set(reveal_kf_id),
                         fused_fade_ids, fused_intro_ids), var_map))
        # A hidden-until-creation object: restore its authored opacity the
        # instant before its introducer draws it in (it was set invisible +
        # save_state'd above; MasFade leaves geometry untouched).
        for kf in reveal_kfs:
            a = _kf_anim(kf, var_map)
            if a is None:
                continue
            baked = _bake(a, max(0.01, float(kf.duration)), easing_func(_enum(kf.easing)))
            tracks.append((float(kf.start_time),
                           f"Succession(MasFade({var_map[kf.object_id]}, 1.0, run_time=0.001), {baked})"))
        for gid, members in grouped.items():
            lag = round(lag_by_group.get(gid, 0.0), 4)
            if lag <= 1e-9:
                # Parallel group: members play together, so merge same-object
                # transforms and chain each mobject's units sequentially. (A
                # staggered group is sequential — don't merge.)
                gtracks = _object_tracks(
                    _merge_units(members, var_map, set(reveal_kf_id),
                                 fused_fade_ids, fused_intro_ids), var_map)
                exprs = [e for _, e in gtracks]
            else:
                # Staggered group. Same timing as AnimationGroup(..., lag_ratio):
                # member i starts at Σ(prev run_times) × lag — but emitted as
                # parallel Succession(Wait(start), …) tracks so each member
                # *begins* (and builds its MasApply/MasFade target) at its actual
                # start instead of eagerly at the group's start, composing with
                # earlier members' effects on shared objects.
                exprs = []
                offset = 0.0
                for kf in members:
                    a = _kf_anim(kf, var_map)
                    if a is None:
                        continue
                    dur = max(0.01, float(kf.duration))
                    baked = _bake(a, dur, easing_func(_enum(kf.easing)))
                    exprs.append(f"Succession(Wait({round(offset, 4)}), {baked})"
                                 if offset > 1e-6 else baked)
                    offset += dur * lag
            if not exprs:
                continue
            inner = exprs[0] if len(exprs) == 1 else f"AnimationGroup({', '.join(exprs)}, lag_ratio=0.0)"
            tracks.append((min(float(k.start_time) for k in members), inner))
        for obj in objects:  # parameter sweeps
            if obj.id not in var_map:
                continue
            sw = _sweep(obj)
            if not sw:
                continue
            expr = f"{tracker_name(obj.id)}.animate.set_value({_num(sw.get('to'), 1.0)})"
            tracks.append((max(0.0, _num(sw.get("start_time"), 0.0)),
                           _bake(expr, max(0.01, _num(sw.get("duration"), 3.0)),
                                 easing_func(str(sw.get("easing", "linear"))))))

        if tracks:
            tracks.sort(key=lambda t: t[0])
            t0 = tracks[0][0]
            if t0 > 1e-6:
                lines.append(f"self.wait({round(t0, 4)})")
            parts = []
            for start, expr in tracks:
                delay = round(start - t0, 4)
                parts.append(f"Succession(Wait({delay}), {expr})" if delay > 1e-6 else expr)
            if len(parts) == 1:
                lines.append(f"self.play({parts[0]})")
            else:
                lines.append(f"self.play(AnimationGroup({', '.join(parts)}, lag_ratio=0.0))")
            played_any = True

    # 6. Hold the final frame so the export isn't truncated.
    lines.append("self.wait(0.5)" if played_any or pre_added else "self.wait(1.0)")

    return "\n".join(_INDENT + ln if ln else "" for ln in lines)


def _assets_root(project: Project) -> str:
    """Absolute path of the project's assets dir, baked into ImageMobject paths
    (the generated script runs from a per-job dir, so relative paths won't do)."""
    from app.storage.projects import assets_dir  # local import: keep codegen usable without storage
    return str(assets_dir(project.id))


def generate_scene_script(project: Project, scene: Scene) -> str:
    bg = scene.background_color or project.settings.background_color or "#000000"
    body = build_body(scene, assets_root=_assets_root(project))
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
        var, obj_lines = emit_object(obj, _assets_root(project))
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
