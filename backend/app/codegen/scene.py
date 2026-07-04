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
    emit_transform_chain, transform_chain_suffix,
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


def _kf_anim_r(kf, var_map: dict[str, str], restore_ids: set[str]) -> str | None:
    """Like `_kf_anim`, but a move/scale/rotate on a hidden-until-creation object
    (or a group containing one) uses a restore-based target so it isn't faded out
    by the 0-opacity baked into a plain `.animate` (see `emit_transform_chain`)."""
    verb = _enum(kf.verb)
    if verb in _XFORM_ANIM and kf.object_id in restore_ids and var_map.get(kf.object_id):
        return emit_transform_chain(var_map[kf.object_id], [(verb, kf.params or {})],
                                    restore_target=True)
    return _kf_anim(kf, var_map)


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
                      lag_by_group: dict[str, float]) -> tuple[set[str], set[str]]:
    """Decide which fade keyframes fuse into a simultaneous same-object transform.

    Returns `(fused_fade_ids, prehide_obj_ids)`:
      - `fused_fade_ids` — fade keyframes that overlap a transform on the same
        object (within the same play bucket) and so become a `.set_opacity` on
        that transform's chain instead of a standalone FadeIn/FadeOut.
      - `prehide_obj_ids` — objects introduced by a fused fade_in (it is their
        earliest creation verb); they must start at opacity 0 so the fused
        `.animate.set_opacity(1)` fades them in rather than snapping to visible.
        (An object with a fade_in is never pre-added, so if this is its first
        creation it isn't visible beforehand — a later fade_in on an already-
        created object stays a no-op fuse and is not pre-hidden.)

    Fades only fuse with transforms that end up merged into one `.animate`, i.e.
    inside the same bucket: ungrouped (`group_id is None`) or a parallel group
    (lag_ratio ~ 0). Staggered groups play sequentially and are left alone."""
    # Earliest creation-verb start per object (its actual introduction time).
    first_creation: dict[str, float] = {}
    for kf in keyframes:
        if _enum(kf.verb) in CREATION_VERBS:
            s = float(kf.start_time)
            first_creation[kf.object_id] = min(first_creation.get(kf.object_id, s), s)

    buckets: dict[object, list] = {}
    for kf in keyframes:
        buckets.setdefault(kf.group_id, []).append(kf)

    fused: set[str] = set()
    prehide: set[str] = set()
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
                    # A fused fade_in that is the object's earliest creation verb
                    # introduces it here → pre-hide so the fade actually reads.
                    if _enum(f.verb) == "fade_in" and fs <= first_creation.get(oid, fs) + 1e-6:
                        prehide.add(oid)
    return fused, prehide


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
                 restore_ids: set[str] | None = None,
                 fused_fade_ids: set[str] | None = None,
                 fused_intro_ids: set[str] | None = None) -> list[tuple]:
    """Turn a set of keyframes into units, chaining move/scale/rotate on the *same
    object* that **overlap in time** into a single `.animate` chain over the union
    window (they'd otherwise fight over the mobject's state). Non-overlapping
    transforms and every other verb stay one unit each. Order of first appearance
    is preserved.

    Each unit is `(obj_id, expr, run_time, rate_func, start, chain, restore, intro)`:
      - `obj_id` — its target mobject (camera keyframes → `CAMERA_ID`), so the
        caller can chain a mobject's several units into one sequential track (Manim
        can't run two animations on one mobject in the same play — `_object_tracks`).
      - `chain` — for a `.animate` transform cluster, the bare method suffix
        (`.shift(v).set_opacity(1.0)`), so `_object_tracks` can rebuild accumulating
        `Transform` targets; `None` for Animation-class units (FadeIn, Indicate, …).
      - `restore` — whether the first target must `.restore()` (hidden object).
      - `intro` — a fused creation+transform (`MasIntro(...)` expression): emitted
        as-is (never rebuilt as a `Transform`), but it still carries the cluster's
        `chain` so later clusters' accumulating targets compose onto it; when
        `restore` is set it needs a `Restore` immediately before it (the object
        was hidden with `set_opacity(0)` and the creation must draw it visible).

    `restore_ids` holds objects (and ancestor groups) hidden until their creation
    animation — their transforms build an explicit restore-based target instead of
    a plain `.animate` (see `emit_transform_chain`).

    `fused_fade_ids` (from `_plan_fade_fusion`) holds fade keyframes to fold into
    the overlapping same-object transform chain as `.set_opacity(…)`; and
    `fused_intro_ids` (from `_plan_intro_fusion`) creation keyframes to fuse with
    their overlapping transform cluster as one `MasIntro` — both are consumed here
    instead of emitting their own standalone unit. A fused keyframe whose cluster
    is not in this call's member set (the sequential model splits plays by start
    time) falls back to a standalone unit so it is never dropped."""
    restore_ids = restore_ids or set()
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
                                    None, False, False)))

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
        # cluster of >1 collapses to one chained .animate over the union window,
        # so overlapping move+scale+rotate combine even with slightly different
        # start times / durations.
        clusters = _time_clusters(xform_by_obj[obj_id])
        fades = fade_by_obj.get(obj_id, [])
        intros = intro_by_obj.get(obj_id, [])
        restore = obj_id in restore_ids
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
                                  u0, transform_chain_suffix(items), restore, True))
                    continue
            # Fold in any fused fade that overlaps this cluster: its final opacity
            # becomes a trailing `.set_opacity`, and it widens the union window.
            opacity: float | None = None
            if cl_fades:
                consumed.update(f.id for f in cl_fades)
                last = max(cl_fades, key=lambda f: float(f.start_time))
                opacity = 1.0 if _enum(last.verb) == "fade_in" else 0.0
                start = min(start, min(_kf_window(f)[0] for f in cl_fades))
                end = max(end, max(_kf_window(f)[1] for f in cl_fades))
            rt = max(0.01, end - start)
            chain = transform_chain_suffix(items, opacity)
            expr = emit_transform_chain(var_map[obj_id], items,
                                        restore_target=restore, opacity=opacity)
            if expr is not None:
                units.append((obj_id, expr, rt, rf, start, chain,
                              restore and opacity is None, False))
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
                                  None, False, False))
    return units


def _object_tracks(units, var_map: dict[str, str]) -> tuple[list[tuple[float, str]], list[str]]:
    """Combine `_merge_units` units into `(tracks, setup_lines)`, giving each
    mobject exactly **one** track so we never run two animations on one mobject as
    separate parallel tracks in a single `self.play` — Manim clobbers those (two
    `.animate` share the mobject's `.target`; two Animation-class anims fight each
    frame). An object that e.g. fades in + moves, then later fades out + moves, must
    run its clusters in sequence.

    A mobject's several units become one `Succession(seg, Wait(gap), seg, …)`.
    `.animate` transform clusters are rebuilt as explicit `Transform(m, tN)` with
    **independent, accumulating** target copies (`t1 = m.copy()<chain1>`,
    `t2 = t1.copy()<chain2>`, …) — emitted as `setup_lines` before the play — so
    the targets don't share `m.target` and each cluster composes onto the previous.
    Objects with a single unit keep their original inline expression."""
    by_obj: dict[str, list] = {}
    order: list[str] = []
    for u in units:
        oid = u[0]
        if oid not in by_obj:
            order.append(oid)
        by_obj.setdefault(oid, []).append(u)

    tracks: list[tuple[float, str]] = []
    setup: list[str] = []
    for oid in order:
        us = sorted(by_obj[oid], key=lambda u: u[4])
        var = var_map.get(oid)
        if len(us) == 1:
            _, expr, rt, rf, start, _, restore, intro = us[0]
            baked = _bake(expr, rt, rf)
            if intro and restore and var is not None:
                # Hidden-until-creation object whose introducer is a fused
                # MasIntro: restore its saved (visible) state the instant before
                # the creation draws it in (mirrors the reveal_kf path).
                baked = f"Succession(Restore({var}, run_time=0.001), {baked})"
            tracks.append((start, baked))
            continue
        segs: list[str] = []
        prev_end: float | None = None
        base: str | None = None   # last accumulated target var (None → copy from `var`)
        step = 0
        for (_, expr, rt, rf, start, chain, restore, intro) in us:
            if prev_end is not None and start - prev_end > 1e-6:
                segs.append(f"Wait({round(start - prev_end, 4)})")
            if intro:
                # Fused creation+transform (MasIntro): plays as-is on the live
                # mobject, but its transform still advances the target base so
                # later clusters compose onto where it left the object.
                if restore and var is not None:
                    segs.append(f"Restore({var}, run_time=0.001)")
                segs.append(_bake(expr, rt, rf))
                if chain is not None and var is not None:
                    step += 1
                    tvar = f"{var}_s{step}"
                    src = f"{base}.copy()" if base is not None else f"{var}.copy(){'.restore()' if restore else ''}"
                    setup.append(f"{tvar} = {src}{chain}")
                    base = tvar
            elif chain is not None and var is not None:
                step += 1
                tvar = f"{var}_s{step}"
                src = f"{base}.copy()" if base is not None else f"{var}.copy(){'.restore()' if restore else ''}"
                setup.append(f"{tvar} = {src}{chain}")
                segs.append(f"Transform({var}, {tvar}, run_time={round(rt, 4)}, rate_func={rf})")
                base = tvar
            else:
                # Animation-class unit (FadeIn/FadeOut/Indicate/morph/…): runs in
                # sequence on the live mobject; it doesn't advance the target base.
                segs.append(_bake(expr, rt, rf))
            prev_end = start + rt
        tracks.append((us[0][4], f"Succession({', '.join(segs)})"))
    return tracks, setup


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

    # 2b. An object introduced by a *delayed* creation verb (Write/Create/…) that
    # also has a later non-introducer animation (fade-out, move, …) gets silently
    # pre-added by Manim at t=0 — so it pops into view before its creation plays.
    # Hide such objects until their creation animation draws them in (the timeline
    # model runs everything in one self.play, so we restore opacity the instant the
    # introducer begins — see the Restore(...) wrapping below).
    ordered = sorted(keyframes, key=lambda k: k.start_time)
    uses_tracking = any(_is_track_kf(kf, var_map) for kf in keyframes)

    # A fade (in/out) overlapping a transform on the same object is fused into
    # that transform's `.animate` chain — two animations on one mobject would
    # otherwise fight. `fade_in_prehide` objects first appear via such a fused
    # fade_in, so they must start at opacity 0 (below) for the fade to read.
    fused_fade_ids, fade_in_prehide = _plan_fade_fusion(keyframes, var_map, lag_by_group)
    # Likewise a write/create/draw_border_then_fill overlapping a transform on the
    # same object fuses into one MasIntro (creation + partial transform per frame).
    fused_intro_ids = _plan_intro_fusion(keyframes, var_map, lag_by_group, fused_fade_ids)

    reveal_kf_id: dict[str, str] = {}  # obj_id -> the creation keyframe to un-hide at
    # Objects (and ancestor groups) whose move/scale/rotate must build a restore-
    # based target because they were hidden with set_opacity(0) — see below.
    restore_ids: set[str] = set()
    if not uses_tracking:
        kfs_by_obj: dict[str, list] = {}
        for kf in keyframes:
            kfs_by_obj.setdefault(kf.object_id, []).append(kf)
        obj_by_id = {o.id: o for o in objects}

        def _has_non_introducer(oid: str) -> bool:
            return any(_enum(k.verb) not in CREATION_VERBS for k in kfs_by_obj.get(oid, []))

        # Manim pre-adds an object at the play's start if it — *or any ancestor
        # group* — is animated by a non-introducer (fade-out/move/…): a group's
        # own animation pulls the whole VGroup (including a not-yet-created child)
        # into the play. Such an object flashes before its creation unless hidden.
        def _exposed_early(oid: str) -> bool:
            if _has_non_introducer(oid):
                return True
            cur = obj_by_id.get(oid)
            seen: set[str] = set()
            while cur is not None and cur.parent_id and cur.parent_id not in seen:
                seen.add(cur.parent_id)
                if _has_non_introducer(cur.parent_id):
                    return True
                cur = obj_by_id.get(cur.parent_id)
            return False

        hide_vars: list[str] = []
        for oid, oks in kfs_by_obj.items():
            if oid not in var_map:
                continue
            # On a start-time tie, the creation verb counts as first: a write and
            # a move starting at the same instant introduce the object via the
            # write (fused into a MasIntro), so it must still hide until then.
            oks = sorted(oks, key=lambda k: (float(k.start_time),
                                             0 if _enum(k.verb) in CREATION_VERBS else 1))
            first = oks[0]
            if first.group_id or _enum(first.verb) not in CREATION_VERBS:
                continue                                   # not intro'd by a lone creation verb
            if first.id in fused_fade_ids:
                continue                                   # fused fade_in → revealed by its own transform
            if float(first.start_time) <= 1e-3:
                continue                                   # created at t=0 → no early window
            if not _exposed_early(oid):
                continue                                   # never pre-added → Manim won't flash it
            reveal_kf_id[oid] = first.id
            hide_vars.append(var_map[oid])

        # A move/scale/rotate on a hidden object — or on a group that *contains*
        # one — must not use a plain `.animate` (its auto-generated target copies
        # the current 0-opacity and fades the object out). Mark each hidden object
        # and all of its ancestor groups; their transforms build a restore-based
        # target instead. A transformed ancestor group also needs a saved (still
        # visible) state to restore from, captured before its children are hidden.
        restore_ids.update(reveal_kf_id)
        for h in list(reveal_kf_id):
            cur = obj_by_id.get(h)
            while cur is not None and cur.parent_id and cur.parent_id not in restore_ids:
                restore_ids.add(cur.parent_id)
                cur = obj_by_id.get(cur.parent_id)
        xformed = {kf.object_id for kf in keyframes if _enum(kf.verb) in _XFORM_ANIM}
        group_savestate = [var_map[gid] for gid in restore_ids
                           if gid not in reveal_kf_id and gid in var_map and gid in xformed]

        # Objects that first appear via a fused fade_in also start invisible (the
        # fused `.animate.set_opacity(1)` fades them in while they move/scale/rotate).
        for oid in fade_in_prehide:
            v = var_map.get(oid)
            if v and v not in hide_vars:
                hide_vars.append(v)

        if hide_vars or group_savestate:
            lines.append("# keep these hidden until their creation animation plays")
            # Save the transformed groups first, while their children are still
            # visible, so a restore-based target recovers the correct opacity.
            for v in group_savestate:
                lines.append(f"{v}.save_state()")
            for v in hide_vars:
                lines.append(f"{v}.save_state()")
                lines.append(f"{v}.set_opacity(0)")
            lines.append("")
    elif fade_in_prehide:
        # Sequential (camera-tracking) model has no hide pass, but an object that
        # first appears via a fused fade_in still must start at opacity 0.
        pre = [var_map[o] for o in fade_in_prehide if o in var_map]
        if pre:
            lines.append("# start hidden until a fused fade_in reveals them")
            for v in pre:
                lines.append(f"{v}.set_opacity(0)")
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
            anims = [u[1] for u in _merge_units(members, var_map, restore_ids,
                                                fused_fade_ids, fused_intro_ids)]
            if not anims:
                continue
            events.append({"start": start, "run_time": max(0.01, max(float(k.duration) for k in members)),
                           "anims": anims, "easing": easing_func(_enum(members[0].easing)), "lag": 0.0})
        for gid, members in grouped.items():
            lag = lag_by_group.get(gid, 0.0)
            if lag <= 1e-9:
                anims = [u[1] for u in _merge_units(members, var_map, restore_ids,
                                                    fused_fade_ids, fused_intro_ids)]
            else:
                anims = [a for kf in members if (a := _kf_anim_r(kf, var_map, restore_ids)) is not None]
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
        # normal flow — the fused unit carries its own Restore (see
        # `_object_tracks`) — instead of the standalone Succession(Restore, …).
        reveal_kf_ids = set(reveal_kf_id.values()) - fused_intro_ids
        reveal_kfs: list = []
        for kf in ordered:
            if kf.group_id:
                grouped.setdefault(kf.group_id, []).append(kf)
            elif kf.id in reveal_kf_ids:
                reveal_kfs.append(kf)
            else:
                ungrouped.append(kf)
        # Setup statements for accumulating transform targets (emitted before the
        # play); see `_object_tracks`.
        setup_lines: list[str] = []
        # Ungrouped: simultaneous move/scale/rotate on one object collapse to a
        # single chained .animate track; a mobject's several (non-overlapping)
        # clusters chain into one sequential track (Manim can't run two animations
        # on one mobject as parallel tracks — see `_object_tracks`).
        utracks, usetup = _object_tracks(
            _merge_units(ungrouped, var_map, restore_ids, fused_fade_ids, fused_intro_ids), var_map)
        tracks.extend(utracks)
        setup_lines.extend(usetup)
        # A hidden-until-creation object: restore its opacity the instant before
        # its introducer draws it in (it was set invisible + save_state'd above).
        for kf in reveal_kfs:
            a = _kf_anim(kf, var_map)
            if a is None:
                continue
            baked = _bake(a, max(0.01, float(kf.duration)), easing_func(_enum(kf.easing)))
            tracks.append((float(kf.start_time),
                           f"Succession(Restore({var_map[kf.object_id]}, run_time=0.001), {baked})"))
        for gid, members in grouped.items():
            lag = round(lag_by_group.get(gid, 0.0), 4)
            if lag <= 1e-9:
                # Parallel group: members play together, so merge same-object
                # transforms and chain each mobject's units sequentially. (A
                # staggered group is sequential — don't merge.)
                gtracks, gsetup = _object_tracks(
                    _merge_units(members, var_map, restore_ids, fused_fade_ids, fused_intro_ids), var_map)
                setup_lines.extend(gsetup)
                exprs = [e for _, e in gtracks]
            else:
                exprs = [_bake(a, max(0.01, float(kf.duration)), easing_func(_enum(kf.easing)))
                         for kf in members if (a := _kf_anim_r(kf, var_map, restore_ids)) is not None]
            if not exprs:
                continue
            inner = exprs[0] if len(exprs) == 1 else f"AnimationGroup({', '.join(exprs)}, lag_ratio={lag})"
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
            if setup_lines:
                lines.append("# accumulating transform targets (independent copies "
                             "so each object's clusters don't share .animate's target)")
                lines.extend(setup_lines)
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
