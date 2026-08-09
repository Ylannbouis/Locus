"""Regression harness for camera keyframe codegen.

Builds IR scenes with several camera moves, runs the generated script in-process
frame by frame (same stub renderer as `stress_groups.py`) and samples the real
`self.camera.frame` — its center and width — over time. That is the only honest
way to catch the class of bug this exists for:

    `m.animate` parks its target in the mobject's single `m.target` slot, and a
    builder only becomes an Animation when the enclosing AnimationGroup /
    Succession is constructed — after every builder in the play has been built.
    So N camera moves in one play all animated to the *last* keyframe's framing
    and only that one appeared to do anything. Camera moves emit `LocusApply` now
    (target built at begin() from the live frame), like object transforms.

Run with the backend venv python:
    backend> .venv/bin/python tests/stress_camera.py
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on sys.path

from app.models.ir import (  # noqa: E402
    AnimationVerb, EasingType, Keyframe, ObjectType, Point2D,
    Scene as IRScene, SceneObject, StyleDef, Timeline,
)
from app.codegen.scene import CAMERA_ID, _uses_camera, build_body  # noqa: E402
from app.codegen.template import render_script  # noqa: E402

import numpy as np  # noqa: E402
from manim import config  # noqa: E402
from manim.camera.moving_camera import MovingCamera  # noqa: E402
from manim.renderer.cairo_renderer import CairoRenderer  # noqa: E402

from stress_groups import StubFileWriter  # noqa: E402

config.pixel_width = 64
config.pixel_height = 36
config.frame_rate = 10
config.disable_caching = True
config.write_to_movie = False
config.verbosity = "ERROR"
config.progress_bar = "none"

TOL = 0.12  # frame center / width tolerance (the sampler lands on frame boundaries)


# ---------------------------------------------------------------------------
# Scene execution, sampling the camera frame
# ---------------------------------------------------------------------------

def run_camera_scene(ir_scene: IRScene):
    """Returns (samples, src); samples is [(time, center_xy, width)] per frame."""
    body = build_body(ir_scene)
    base = "MovingCameraScene" if _uses_camera(ir_scene) else "Scene"
    src = render_script(body=body, background_color="#000000", base_class=base)

    ns: dict = {}
    exec(compile(src, "<generated_scene>", "exec"), ns)
    base_cls = ns["LocusScene"]

    samples: list[tuple[float, tuple[float, float], float]] = []

    class Probe(base_cls):
        def is_current_animation_frozen_frame(self):
            return False  # sample during pure waits too

        def update_to_time(self, t):
            super().update_to_time(t)
            f = self.camera.frame
            samples.append((round(self.renderer.time, 4),
                            tuple(np.round(f.get_center()[:2], 3)),
                            round(float(f.width), 3)))

    renderer = CairoRenderer(file_writer_class=StubFileWriter, camera_class=MovingCamera)
    Probe(renderer=renderer).render()
    return samples, src


def at(samples, t):
    """The sample nearest time `t`."""
    return min(samples, key=lambda s: abs(s[0] - t))


# ---------------------------------------------------------------------------
# IR builders
# ---------------------------------------------------------------------------

def shape(oid: str, x: float = 0.0, y: float = 0.0) -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.SHAPE, name=oid, position=Point2D(x=x, y=y),
        style=StyleDef(stroke_color="#FFFFFF", stroke_width=4.0, fill_color="#FF4040",
                       fill_opacity=0.5),
        props={"subtype": "circle", "radius": 0.5},
    )


def cam_kf(start: float, dur: float = 1.0, **params) -> Keyframe:
    return Keyframe(object_id=CAMERA_ID, verb=AnimationVerb.CAMERA_MOVE, start_time=start,
                    duration=dur, easing=EasingType.LINEAR, params=params)


def obj_kf(oid: str, verb: str, start: float, dur: float = 1.0, params=None) -> Keyframe:
    return Keyframe(object_id=oid, verb=AnimationVerb(verb), start_time=start, duration=dur,
                    easing=EasingType.LINEAR, params=params or {})


def ir(objs, kfs) -> IRScene:
    return IRScene(id="s", name="cam", objects=list(objs), timeline=Timeline(keyframes=list(kfs)))


# ---------------------------------------------------------------------------
# Scenarios: each returns (scene, checker)
# ---------------------------------------------------------------------------

def sc_three_moves():
    """The reported bug: three camera moves, each must actually happen."""
    scene = ir([shape("a")], [
        obj_kf("a", "create", 0.0),
        cam_kf(1.0, 1.0, pan={"x": -3.0, "y": 0.0}, zoom=1.5),
        cam_kf(3.0, 1.0, pan={"x": 3.0, "y": 2.0}, zoom=1.0),
        cam_kf(5.0, 1.0, pan={"x": 0.0, "y": -2.0}, zoom=2.0),
    ])

    def check(samples):
        errs = []
        for t, want_c, want_w in [
            (2.0, (-3.0, 0.0), config.frame_width / 1.5),
            (4.0, (3.0, 2.0), config.frame_width / 1.0),
            (6.0, (0.0, -2.0), config.frame_width / 2.0),
        ]:
            st, c, w = at(samples, t)
            if abs(c[0] - want_c[0]) > TOL or abs(c[1] - want_c[1]) > TOL:
                errs.append(f"t={t}: center {c} != {want_c}")
            if abs(w - want_w) > TOL:
                errs.append(f"t={t}: width {w} != {round(want_w, 3)}")
        # And the moves must be distinguishable — the old bug made every move
        # land on the last keyframe's framing.
        centers = {at(samples, t)[1] for t in (2.0, 4.0, 6.0)}
        if len(centers) < 3:
            errs.append(f"camera framings collapsed onto each other: {centers}")
        return errs
    return scene, check


def sc_pan_keeps_zoom():
    """A pan-only keyframe after a zoom must keep that zoom, not restore the
    pre-play framing (the `.animate` target was a copy of the *original* frame)."""
    scene = ir([shape("a")], [
        obj_kf("a", "create", 0.0),
        cam_kf(1.0, 1.0, pan={"x": 0.0, "y": 0.0}, zoom=2.0),
        cam_kf(3.0, 1.0, pan={"x": 2.0, "y": 1.0}),  # no zoom key
    ])

    def check(samples):
        _, c, w = at(samples, 4.0)
        errs = []
        if abs(w - config.frame_width / 2.0) > TOL:
            errs.append(f"pan-only keyframe reset the zoom: width {w}")
        if abs(c[0] - 2.0) > TOL or abs(c[1] - 1.0) > TOL:
            errs.append(f"pan-only keyframe center {c} != (2.0, 1.0)")
        return errs
    return scene, check


def sc_zoom_keeps_pan():
    """A zoom-only keyframe must zoom about where the camera already is."""
    scene = ir([shape("a")], [
        obj_kf("a", "create", 0.0),
        cam_kf(1.0, 1.0, pan={"x": -2.0, "y": -1.0}),
        cam_kf(3.0, 1.0, zoom=2.0),  # no pan key
    ])

    def check(samples):
        _, c, w = at(samples, 4.0)
        errs = []
        if abs(c[0] + 2.0) > TOL or abs(c[1] + 1.0) > TOL:
            errs.append(f"zoom-only keyframe moved the camera: center {c}")
        if abs(w - config.frame_width / 2.0) > TOL:
            errs.append(f"zoom-only keyframe width {w}")
        return errs
    return scene, check


def sc_initial_framing_then_moves():
    """Two moves on top of a non-default initial framing."""
    scene = ir([shape("a")], [
        obj_kf("a", "create", 0.0),
        cam_kf(1.0, 1.0, pan={"x": 4.0, "y": 0.0}, zoom=1.2),
        cam_kf(3.0, 1.0, pan={"x": -4.0, "y": 0.0}, zoom=1.2),
    ])
    scene.camera_track.initial_pan = Point2D(x=0.0, y=3.0)
    scene.camera_track.initial_zoom = 1.5

    def check(samples):
        errs = []
        _, c0, w0 = samples[0]
        if abs(c0[1] - 3.0) > TOL or abs(w0 - config.frame_width / 1.5) > TOL:
            errs.append(f"initial framing not applied: center {c0} width {w0}")
        for t, want_x in ((2.0, 4.0), (4.0, -4.0)):
            _, c, _ = at(samples, t)
            if abs(c[0] - want_x) > TOL:
                errs.append(f"t={t}: center {c} x != {want_x}")
        return errs
    return scene, check


def sc_focus_follows_moved_object():
    """A focus keyframe frames the object where it *is* when the move starts —
    the object moved right by 3 before the camera focuses on it."""
    scene = ir([shape("a", x=0.0, y=0.0)], [
        obj_kf("a", "create", 0.0),
        obj_kf("a", "move", 1.0, 1.0, {"delta": {"x": 3.0, "y": 0.0}}),
        cam_kf(3.0, 1.0, focus_object_id="a", zoom=1.0),
    ])

    def check(samples):
        _, c, _ = at(samples, 4.0)
        return ([] if abs(c[0] - 3.0) <= TOL and abs(c[1]) <= TOL
                else [f"focus landed at {c}, expected the object at (3.0, 0.0)"])
    return scene, check


def sc_tracking_then_moves():
    """The *sequential* emission model (a tracking keyframe forces it): a follow
    updater, then two one-shot moves that must each land."""
    scene = ir([shape("a", x=0.0, y=0.0)], [
        obj_kf("a", "create", 0.0),
        obj_kf("a", "move", 1.0, 1.0, {"delta": {"x": 4.0, "y": 0.0}}),
        cam_kf(1.0, 1.0, focus_object_id="a", track=True),
        cam_kf(3.0, 1.0, pan={"x": -3.0, "y": 0.0}),
        cam_kf(5.0, 1.0, pan={"x": 2.0, "y": 2.0}),
    ])

    def check(samples):
        errs = []
        _, c, _ = at(samples, 2.0)
        if abs(c[0] - 4.0) > TOL:  # followed the object to x=4
            errs.append(f"tracking did not follow the object: center {c}")
        for t, want in ((4.0, (-3.0, 0.0)), (6.0, (2.0, 2.0))):
            _, c, _ = at(samples, t)
            if abs(c[0] - want[0]) > TOL or abs(c[1] - want[1]) > TOL:
                errs.append(f"t={t}: center {c} != {want}")
        return errs
    return scene, check


SCENARIOS = {
    "three_moves": sc_three_moves,
    "tracking_then_moves": sc_tracking_then_moves,
    "pan_keeps_zoom": sc_pan_keeps_zoom,
    "zoom_keeps_pan": sc_zoom_keeps_pan,
    "initial_framing_then_moves": sc_initial_framing_then_moves,
    "focus_follows_moved_object": sc_focus_follows_moved_object,
}


def main(argv: list[str]) -> int:
    show_src = "--src" in argv
    names = [a for a in argv if not a.startswith("--")] or list(SCENARIOS)
    failures = 0
    for name in names:
        fn = SCENARIOS.get(name)
        if fn is None:
            print(f"?? unknown scenario: {name}")
            failures += 1
            continue
        try:
            scn, check = fn()
            samples, src = run_camera_scene(scn)
            errs = check(samples)
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
        else:
            print(f"pass  {name}")
        if show_src:
            print("      --- generated script ---")
            for ln in src.split("\n"):
                print("      " + ln)
    print(f"\n{len(names) - failures}/{len(names)} scenarios passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
