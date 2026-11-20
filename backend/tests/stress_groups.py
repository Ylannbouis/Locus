"""Stress harness for group / fade animation codegen.

Builds IR scenes for adversarial group+fade scenarios, generates the Manim
script via the real codegen, executes it in-process frame-by-frame (stub file
writer, tiny resolution), records every object's actual visibility over time,
and asserts expected visibility windows, final state, and final-frame pixels.

Run with the backend venv python:
    backend> .venv\\Scripts\\python.exe tests\\stress_groups.py [scenario ...]
"""
from __future__ import annotations

import re
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on sys.path

from app.models.ir import (  # noqa: E402
    AnimationGroup as IRAnimationGroup,
    AnimationVerb,
    EasingType,
    Keyframe,
    ObjectType,
    Point2D,
    Scene as IRScene,
    SceneObject,
    StyleDef,
    Timeline,
)
from app.codegen.scene import _uses_camera, build_body  # noqa: E402
from app.codegen.template import render_script  # noqa: E402

import numpy as np  # noqa: E402
from manim import config  # noqa: E402
from manim.renderer.cairo_renderer import CairoRenderer  # noqa: E402

config.pixel_width = 64
config.pixel_height = 36
config.frame_rate = 10
config.disable_caching = True
config.write_to_movie = False
config.verbosity = "ERROR"
config.progress_bar = "none"

VIS_EPS = 0.02  # opacity below this counts as invisible


# ---------------------------------------------------------------------------
# Scene execution with per-frame probes
# ---------------------------------------------------------------------------

class _StubSection:
    skip_animations = False


class StubFileWriter:
    """No-op SceneFileWriter stand-in: frames are stepped but never written."""

    def __init__(self, renderer, scene_name):
        self.sections = [_StubSection()]

    def add_partial_movie_file(self, hash_animation):
        pass

    def begin_animation(self, allow_write=False):
        pass

    def end_animation(self, allow_write=False):
        pass

    def write_frame(self, frame, num_frames=1):
        pass

    def finish(self):
        pass


def _instrument(src: str) -> str:
    """Register every generated `m_*` variable on the scene so probes can see
    them: insert `self._locus_track.update({...})` after the last definition."""
    lines = src.split("\n")
    names: list[str] = []
    last_def = -1
    for i, ln in enumerate(lines):
        m = re.match(r"^        (m_[A-Za-z0-9_]+) = ", ln)
        if m:
            names.append(m.group(1))
            last_def = i
    if last_def < 0:
        return src
    uniq = list(dict.fromkeys(names))
    reg = "        self._locus_track.update({" + ", ".join(f"{n!r}: {n}" for n in uniq) + "})"
    lines.insert(last_def + 1, reg)
    return "\n".join(lines)


def _snapshot(scene) -> dict:
    """name -> (fill_opacity, stroke_opacity, in_scene, center_xy) for every
    tracked mobject, considering only leaf members with points."""
    fam: set[int] = set()
    for m in scene.mobjects:
        for sm in m.get_family():
            fam.add(id(sm))
    out = {}
    for name, mob in scene._locus_track.items():
        fill = stroke = 0.0
        in_scene = False
        for sm in mob.get_family():
            pts = getattr(sm, "points", None)
            if pts is None or len(pts) == 0:
                continue
            if id(sm) in fam:
                in_scene = True
                try:
                    fill = max(fill, float(sm.get_fill_opacity()))
                except Exception:
                    pass
                try:
                    stroke = max(stroke, float(sm.get_stroke_opacity()))
                except Exception:
                    pass
        try:
            center = tuple(np.round(mob.get_center()[:2], 3))
        except Exception:
            center = (0.0, 0.0)
        out[name] = (fill, stroke, in_scene, center)
    return out


def _visible(entry) -> bool:
    fill, stroke, in_scene, _ = entry
    return in_scene and max(fill, stroke) > VIS_EPS


def run_ir_scene(ir_scene: IRScene):
    """Generate the script for `ir_scene`, run it with probes.

    Returns (samples, final_state, final_frame, src): samples is a list of
    (time, snapshot) taken every rendered frame; final_state is a snapshot
    taken after render() returns (post animation clean-up — where removers
    fire); final_frame is the re-rendered end-state pixel array.
    """
    body = build_body(ir_scene)
    base = "MovingCameraScene" if _uses_camera(ir_scene) else "Scene"
    src = render_script(body=body, background_color="#000000", base_class=base)
    src = _instrument(src)

    ns: dict = {}
    exec(compile(src, "<generated_scene>", "exec"), ns)
    base_cls = ns["LocusScene"]

    samples: list[tuple[float, dict]] = []

    class Probe(base_cls):
        def setup(self):
            self._locus_track = {}

        def is_current_animation_frozen_frame(self):
            return False  # sample during pure waits too (no frozen-frame shortcut)

        def update_to_time(self, t):
            super().update_to_time(t)
            samples.append((self.renderer.time, _snapshot(self)))

    if base == "MovingCameraScene":
        from manim.camera.moving_camera import MovingCamera
        renderer = CairoRenderer(file_writer_class=StubFileWriter, camera_class=MovingCamera)
    else:
        renderer = CairoRenderer(file_writer_class=StubFileWriter)
    scene = Probe(renderer=renderer)
    scene.render()

    final_state = _snapshot(scene)
    renderer.static_image = None
    renderer.update_frame(scene)
    final_frame = renderer.get_frame()
    return samples, final_state, final_frame, src


# ---------------------------------------------------------------------------
# IR builders
# ---------------------------------------------------------------------------

def shape(oid: str, x: float = 0.0, y: float = 0.0, parent: str | None = None,
          fill_opacity: float = 0.5) -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.SHAPE, name=oid,
        position=Point2D(x=x, y=y), parent_id=parent,
        style=StyleDef(stroke_color="#FFFFFF", stroke_width=4.0, stroke_opacity=1.0,
                       fill_color="#FF4040", fill_opacity=fill_opacity),
        props={"subtype": "circle", "radius": 0.5},
    )


def group(gid: str) -> SceneObject:
    return SceneObject(id=gid, type=ObjectType.GROUP, name=gid, props={})


def kf(obj: str, verb: str, start: float, dur: float = 1.0,
       params: dict | None = None, group_id: str | None = None) -> Keyframe:
    return Keyframe(object_id=obj, verb=AnimationVerb(verb), start_time=start,
                    duration=dur, easing=EasingType.LINEAR,
                    params=params or {}, group_id=group_id)


def ir_scene(objs, kfs, groups=()) -> IRScene:
    return IRScene(id="s", name="stress", objects=list(objs),
                   timeline=Timeline(keyframes=list(kfs), groups=list(groups)))


MOVE_R2 = {"delta": {"x": 2.0, "y": 0.0}}  # shift right by 2


# ---------------------------------------------------------------------------
# Scenarios: fn() -> (IRScene, expectations)
#
# expectations = {
#   "windows": {name: [(t0, t1, visible), ...]},   checked on every sample in [t0, t1]
#   "final":   {name: visible},                    checked post-cleanup
#   "final_fill": {name: value},                   authored-opacity fidelity
#   "final_pos": {name: (x, y)},                   geometry still applied
#   "pixels": "dark" | "lit",                      final re-rendered frame
# }
# ---------------------------------------------------------------------------

SCENARIOS: dict = {}


def scenario(fn):
    SCENARIOS[fn.__name__] = fn
    return fn


@scenario
def group_fadeout_alone():
    """Pre-added group; the group fades out. Must stay gone at the end."""
    objs = [shape("a", -1), shape("b", 1), group("G")]
    objs[0].parent_id = objs[1].parent_id = "G"
    kfs = [kf("G", "fade_out", 1.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.85, True)], "b": [(0.1, 0.85, True)]},
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def write_children_then_group_fadeout():
    """Children written in, then the whole group fades out."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "write", 0.0), kf("b", "write", 0.3), kf("G", "fade_out", 2.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(1.2, 1.9, True)], "b": [(1.5, 1.9, True)]},
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def child_fadeout_then_group_move():
    """A child fades out, then the group moves: the faded child must NOT
    reappear when the group's transform plays (reported bug)."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 0.5), kf("G", "move", 2.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.4, True), (1.6, 2.95, False)],
                    "b": [(0.1, 2.95, True)]},
        "final": {"a": False, "b": True},
        "final_pos": {"b": (3.0, 0.0)},
    }


@scenario
def child_fadeout_then_group_scale_rotate():
    """A child fades out, then the group scales+rotates simultaneously."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 0.5),
           kf("G", "scale", 2.0, params={"factor": 1.5}),
           kf("G", "rotate", 2.0, params={"angle_degrees": 90.0})]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(1.6, 2.95, False)], "b": [(0.1, 2.95, True)]},
        "final": {"a": False, "b": True},
    }


@scenario
def fadeout_then_move_single():
    """Fade out, then move: the object must stay invisible while (invisibly)
    relocating — not fade back in (reported bug)."""
    objs = [shape("c", -1)]
    kfs = [kf("c", "fade_out", 0.5), kf("c", "move", 2.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(0.1, 0.4, True), (1.6, 2.95, False)]},
        "final": {"c": False},
        "final_pos": {"c": (1.0, 0.0)},
        "pixels": "dark",
    }


@scenario
def move_then_fadeout_single():
    objs = [shape("c", -1)]
    kfs = [kf("c", "move", 0.0, params=MOVE_R2), kf("c", "fade_out", 2.0)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(0.1, 1.9, True)]},
        "final": {"c": False},
        "final_pos": {"c": (1.0, 0.0)},
        "pixels": "dark",
    }


@scenario
def group_fadeout_then_group_fadein():
    """Fade the group out, later fade it back in. It must actually return and
    survive the end of the play."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("G", "fade_out", 1.0), kf("G", "fade_in", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.9, True), (2.1, 2.9, False), (4.05, 4.3, True)]},
        "final": {"a": True, "b": True},
        "final_fill": {"a": 0.5},
        "pixels": "lit",
    }


@scenario
def fadeout_then_fadein_child():
    """Fade one child out and back in while the sibling stays put."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 0.5), kf("a", "fade_in", 2.5)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(1.6, 2.4, False), (3.55, 3.8, True)],
                    "b": [(0.1, 3.4, True)]},
        "final": {"a": True, "b": True},
        "final_fill": {"a": 0.5},
    }


@scenario
def parallel_kfgroup_child_fadeouts():
    """Both children fade out via a parallel timeline animation-group."""
    g = IRAnimationGroup(id="kg", lag_ratio=0.0)
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 1.0, group_id="kg"),
           kf("b", "fade_out", 1.0, group_id="kg")]
    return ir_scene(objs, kfs, groups=[g]), {
        "windows": {"a": [(0.1, 0.9, True)], "b": [(0.1, 0.9, True)]},
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def staggered_kfgroup_child_fadeouts():
    """Both children fade out via a staggered (lag_ratio 0.5) group."""
    g = IRAnimationGroup(id="kg", lag_ratio=0.5)
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 1.0, group_id="kg"),
           kf("b", "fade_out", 1.0, group_id="kg")]
    return ir_scene(objs, kfs, groups=[g]), {
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def fused_fadein_with_move():
    """fade_in overlapping a move on the same object (fused into one chain):
    the object must end at its *authored* opacity, not opacity 1."""
    objs = [shape("c", -1), shape("d", 1)]
    kfs = [kf("c", "fade_in", 1.0), kf("c", "move", 1.0, params=MOVE_R2),
           kf("d", "move", 0.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(0.05, 0.9, False)]},
        "final": {"c": True, "d": True},
        "final_fill": {"c": 0.5},
        "final_pos": {"c": (1.0, 0.0)},
    }


@scenario
def group_fused_fadeout_with_move():
    """Group move overlapping a group fade_out (fused): ends invisible, moved."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("G", "move", 1.0, dur=2.0, params=MOVE_R2),
           kf("G", "fade_out", 1.5)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.9, True)]},
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def delayed_fadein_no_flash():
    """An object introduced by a delayed fade_in while another object animates
    from t=0: it must NOT be visible before its fade_in starts."""
    objs = [shape("c", -1), shape("d", 1)]
    kfs = [kf("d", "move", 0.0, dur=3.0, params=MOVE_R2), kf("c", "fade_in", 2.0)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(0.05, 1.9, False), (3.05, 3.3, True)],
                    "d": [(0.1, 3.3, True)]},
        "final": {"c": True, "d": True},
        "final_fill": {"c": 0.5},
    }


@scenario
def hidden_write_flash_then_group_fadeout():
    """Delayed Write on a child while the group later fades out (the child is
    exposed early by the group's animation → hide-until-creation applies)."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "write", 1.5), kf("G", "fade_out", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(1.05, 1.45, False), (2.6, 2.95, True)],
                    "b": [(1.05, 2.95, True)]},
        "final": {"a": False, "b": False},
        "pixels": "dark",
    }


@scenario
def intro_fusion_then_fadeout():
    """Write fused with an overlapping move (LocusIntro), then a fade_out."""
    objs = [shape("c", -1)]
    kfs = [kf("c", "write", 0.0), kf("c", "move", 0.5, dur=1.0, params=MOVE_R2),
           kf("c", "fade_out", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(1.7, 2.9, True)]},
        "final": {"c": False},
        "final_pos": {"c": (1.0, 0.0)},
        "pixels": "dark",
    }


@scenario
def group_fade_overlapping_child_move():
    """Group fades out WHILE a child moves (overlapping windows): the child
    must fade with the group, not stay visible because its transform keeps
    reasserting pre-fade state."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("G", "fade_out", 1.0), kf("a", "move", 1.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.9, True)], "b": [(0.1, 0.9, True)]},
        "final": {"a": False, "b": False},
        "final_pos": {"a": (1.0, 0.0)},
        "pixels": "dark",
    }


@scenario
def child_fade_overlapping_group_move():
    """A child fades out WHILE the whole group moves (overlapping windows):
    the fade must win on the child's style, the move on everyone's geometry."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_out", 1.0), kf("G", "move", 1.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"b": [(0.1, 1.9, True)]},
        "final": {"a": False, "b": True},
        "final_pos": {"a": (1.0, 0.0), "b": (3.0, 0.0)},
    }


@scenario
def child_fadein_overlapping_group_move():
    """A child is introduced by fade_in WHILE its group moves: it must slide
    with the group and end at its authored opacity."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("a", "fade_in", 1.0), kf("G", "move", 1.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.05, 0.9, False)], "b": [(0.1, 1.9, True)]},
        "final": {"a": True, "b": True},
        "final_fill": {"a": 0.5},
        "final_pos": {"a": (1.0, 0.0), "b": (3.0, 0.0)},
    }


@scenario
def nested_groups_fade_cycle():
    """Outer group (inner group + extra child) fades out; the inner group
    fades back in later. Only the inner group's children return."""
    objs = [shape("a", -1, parent="G1"), shape("b", 1, parent="G1"), group("G1"),
            shape("c", 0, -1.5, parent="G2"), group("G2")]
    objs[2].parent_id = "G2"  # G1 nested inside G2
    kfs = [kf("G2", "fade_out", 1.0), kf("G1", "fade_in", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 0.9, True), (2.1, 2.9, False)],
                    "c": [(0.1, 0.9, True), (2.1, 3.9, False)]},
        "final": {"a": True, "b": True, "c": False},
        "final_fill": {"a": 0.5},
    }


@scenario
def many_fades_chain():
    """fade_out → fade_in → fade_out → fade_in on one object; every leg must
    actually change visibility and the object must end at authored opacity."""
    objs = [shape("c", -1)]
    kfs = [kf("c", "fade_out", 0.5), kf("c", "fade_in", 2.0),
           kf("c", "fade_out", 3.5), kf("c", "fade_in", 5.0)]
    return ir_scene(objs, kfs), {
        "windows": {"c": [(0.1, 0.4, True), (1.6, 1.9, False), (3.05, 3.4, True),
                          (4.6, 4.9, False), (6.05, 6.3, True)]},
        "final": {"c": True},
        "final_fill": {"c": 0.5},
        "pixels": "lit",
    }


@scenario
def group_move_child_fade_group_move():
    """Group moves, a child fades out, the group moves again: the fade must
    survive both surrounding group transforms."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("G", "move", 0.0, params=MOVE_R2),
           kf("a", "fade_out", 2.0),
           kf("G", "move", 4.0, params=MOVE_R2)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 1.9, True), (3.1, 4.95, False)],
                    "b": [(0.1, 4.95, True)]},
        "final": {"a": False, "b": True},
        "final_pos": {"b": (5.0, 0.0)},
    }


@scenario
def seqmodel_child_fadeout_then_group_move():
    """Sequential (camera-tracking) model: child fades out in its own play,
    the group moves in a later play — the faded child must not come back.
    (This model *serializes* overlapping keyframes: the d-move play runs
    0-5, then the fade plays 5-6, then the group move 6-7.)"""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G"),
            shape("d", 0, 2)]
    kfs = [
        Keyframe(object_id="__camera__", verb=AnimationVerb.CAMERA_MOVE, start_time=0.0,
                 duration=5.0, easing=EasingType.LINEAR,
                 params={"focus_object_id": "d", "track": True}),
        kf("d", "move", 0.0, dur=5.0, params={"delta": {"x": 0.5, "y": 0.0}}),
        kf("a", "fade_out", 1.0),
        kf("G", "move", 3.0, params=MOVE_R2),
    ]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 4.9, True), (6.1, 7.4, False)],
                    "b": [(0.1, 7.4, True)]},
        "final": {"a": False, "b": True},
        "final_pos": {"b": (3.0, 0.0)},
    }


@scenario
def seqmodel_group_fadeout_then_fadein():
    """Sequential model: group fades out then back in across separate plays.
    (This model serializes overlapping keyframes: d-move plays 0-5, the
    fade_out 5-6, the fade_in 6-7.)"""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G"),
            shape("d", 0, 2)]
    kfs = [
        Keyframe(object_id="__camera__", verb=AnimationVerb.CAMERA_MOVE, start_time=0.0,
                 duration=5.0, easing=EasingType.LINEAR,
                 params={"focus_object_id": "d", "track": True}),
        kf("d", "move", 0.0, dur=5.0, params={"delta": {"x": 0.5, "y": 0.0}}),
        kf("G", "fade_out", 1.0),
        kf("G", "fade_in", 3.0),
    ]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 4.9, True), (5.96, 6.04, False)],
                    "b": [(0.1, 4.9, True), (5.96, 6.04, False)]},
        "final": {"a": True, "b": True},
        "final_fill": {"a": 0.5},
    }


@scenario
def move_then_create_hidden():
    """A Move before a Create doesn't put the object on screen: it stays hidden
    until the Create (the move happens unseen) and is drawn where the move
    left it — the editor preview's rule (first *presence* event decides)."""
    objs = [shape("a", 0)]
    kfs = [kf("a", "move", 1.0, params=MOVE_R2), kf("a", "create", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.0, 2.95, False), (3.5, 4.4, True)]},
        "final": {"a": True},
        "final_pos": {"a": (2.0, 0.0)},
    }


@scenario
def group_move_then_child_write():
    """An ancestor group's move before a child's Write: the child stays hidden
    until its Write, then shows where the group took it."""
    objs = [shape("a", -1, parent="G"), shape("b", 1, parent="G"), group("G")]
    kfs = [kf("G", "move", 0.5, params=MOVE_R2), kf("b", "write", 2.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.0, 3.4, True)], "b": [(0.0, 1.95, False), (2.6, 3.4, True)]},
        "final": {"a": True, "b": True},
        "final_pos": {"b": (3.0, 0.0)},
    }


@scenario
def move_then_grouped_create():
    """The Create that introduces the object is in a parallel keyframe group:
    still hidden before it, revealed by it."""
    objs = [shape("a", 0), shape("b", 0, 2)]
    g = IRAnimationGroup(id="kg", lag_ratio=0.0)
    kfs = [kf("a", "move", 0.5, params=MOVE_R2),
           kf("a", "create", 2.0, group_id="kg"), kf("b", "indicate", 2.0, group_id="kg")]
    return ir_scene(objs, kfs, groups=[g]), {
        "windows": {"a": [(0.0, 1.95, False), (2.6, 3.4, True)]},
        "final": {"a": True},
        "final_pos": {"a": (2.0, 0.0)},
    }


@scenario
def fadeout_before_create_starts_visible():
    """The exception: a fade_out *before* the Create means the object started on
    screen (its first presence event is the exit)."""
    objs = [shape("a", 0)]
    kfs = [kf("a", "move", 0.5, params=MOVE_R2), kf("a", "fade_out", 1.5), kf("a", "create", 3.0)]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.0, 1.4, True), (2.6, 2.95, False), (3.5, 4.4, True)]},
        "final": {"a": True},
    }


@scenario
def seqmodel_move_then_create_hidden():
    """Sequential (camera-tracking) model: the move gets its own earlier play,
    which adds the object to the scene — it must stay hidden until the Create's
    play reveals it. (Overlapping keyframes serialize: d-move 0-5, a-move 5-6,
    a-create 6-7.)"""
    objs = [shape("a", 0), shape("d", 0, 2)]
    kfs = [
        Keyframe(object_id="__camera__", verb=AnimationVerb.CAMERA_MOVE, start_time=0.0,
                 duration=5.0, easing=EasingType.LINEAR,
                 params={"focus_object_id": "d", "track": True}),
        kf("d", "move", 0.0, dur=5.0, params={"delta": {"x": 0.5, "y": 0.0}}),
        kf("a", "move", 1.0, params=MOVE_R2),
        kf("a", "create", 3.0),
    ]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.0, 5.95, False), (6.6, 7.4, True)]},
        "final": {"a": True},
        "final_pos": {"a": (2.0, 0.0)},
    }


@scenario
def seqmodel_fadeout_then_create():
    """Sequential model: a Create after the object's own fade_out draws it back
    in visibly (a creation draws with the current, zeroed opacity unless the
    object is revealed first). Serialized: d-move 0-5, fade_out 5-6, create 6-7."""
    objs = [shape("a", 0), shape("d", 0, 2)]
    kfs = [
        Keyframe(object_id="__camera__", verb=AnimationVerb.CAMERA_MOVE, start_time=0.0,
                 duration=5.0, easing=EasingType.LINEAR,
                 params={"focus_object_id": "d", "track": True}),
        kf("d", "move", 0.0, dur=5.0, params={"delta": {"x": 0.5, "y": 0.0}}),
        kf("a", "fade_out", 1.0),
        kf("a", "create", 3.0),
    ]
    return ir_scene(objs, kfs), {
        "windows": {"a": [(0.1, 4.9, True), (6.6, 7.4, True)]},
        "final": {"a": True},
    }


# ---------------------------------------------------------------------------
# Assertions + runner
# ---------------------------------------------------------------------------

def _var(name: str) -> str:
    return f"m_{name}"


def check(samples, final_state, final_frame, exp) -> list[str]:
    errs: list[str] = []
    for name, windows in exp.get("windows", {}).items():
        v = _var(name)
        for (t0, t1, want) in windows:
            pts = [(t, st[v]) for t, st in samples if t0 <= t <= t1 and v in st]
            bad = [(t, e) for t, e in pts if _visible(e) != want]
            if bad:
                t, e = bad[0]
                errs.append(f"{name} in [{t0},{t1}]: expected visible={want}, got "
                            f"{_visible(e)} at t={t:.2f} (fill={e[0]:.2f} stroke={e[1]:.2f} "
                            f"in_scene={e[2]}) [{len(bad)}/{len(pts)} samples bad]")
    for name, want in exp.get("final", {}).items():
        e = final_state.get(_var(name))
        if e is None:
            errs.append(f"{name}: not tracked in final state")
        elif _visible(e) != want:
            errs.append(f"{name} final: expected visible={want}, got {_visible(e)} "
                        f"(fill={e[0]:.2f} stroke={e[1]:.2f} in_scene={e[2]})")
    for name, want in exp.get("final_fill", {}).items():
        e = final_state.get(_var(name))
        if e is not None and abs(e[0] - want) > 0.05:
            errs.append(f"{name} final fill_opacity: expected {want}, got {e[0]:.2f}")
    for name, (wx, wy) in exp.get("final_pos", {}).items():
        e = final_state.get(_var(name))
        if e is not None:
            cx, cy = e[3]
            if abs(cx - wx) > 0.3 or abs(cy - wy) > 0.3:
                errs.append(f"{name} final pos: expected ({wx},{wy}), got ({cx},{cy})")
    if "pixels" in exp:
        bright = int(final_frame[..., :3].max())
        if exp["pixels"] == "dark" and bright > 40:
            errs.append(f"final frame should be dark, max RGB={bright}")
        if exp["pixels"] == "lit" and bright < 100:
            errs.append(f"final frame should show objects, max RGB={bright}")
    return errs


def main(argv: list[str]) -> int:
    names = argv or list(SCENARIOS)
    show_src = "--src" in names
    names = [n for n in names if not n.startswith("--")]
    if not names:
        names = list(SCENARIOS)
    failures = 0
    for name in names:
        fn = SCENARIOS.get(name)
        if fn is None:
            print(f"?? unknown scenario: {name}")
            failures += 1
            continue
        try:
            scn, exp = fn()
            samples, final_state, final_frame, src = run_ir_scene(scn)
            errs = check(samples, final_state, final_frame, exp)
        except Exception:
            print(f"ERROR {name}")
            traceback.print_exc()
            failures += 1
            continue
        if errs:
            failures += 1
            print(f"FAIL  {name}")
            for e in errs:
                print(f"      - {e}")
            if show_src:
                print("      --- generated script ---")
                for ln in src.split("\n"):
                    print("      " + ln)
        else:
            print(f"pass  {name}")
    print(f"\n{len(names) - failures}/{len(names)} scenarios passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
