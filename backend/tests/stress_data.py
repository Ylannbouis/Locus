"""Stress harness for data-driven objects: `graph.histogram` + `number`, and the
`update_data` verb (LocusHistogram / LocusBars / LocusNumber / LocusCount).

Builds IR scenes, generates the Manim script through the real codegen, runs it
in-process frame by frame (stub file writer, tiny resolution — the same runner
as stress_groups.py) and samples what the mobjects really hold each frame: the
bar heights a histogram is laid out for (and the bars' actual geometry), the
value a number readout shows, and visibility.

Run with the backend venv python:
    backend> .venv\\Scripts\\python.exe tests\\stress_data.py [scenario ...]
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on sys.path

# Importing the group harness also applies its tiny-render manim config.
from stress_groups import StubFileWriter, _instrument, _snapshot, _visible, kf, ir_scene  # noqa: E402

from app.models.ir import ObjectType, Point2D, SceneObject, StyleDef  # noqa: E402
from app.codegen.scene import _uses_camera, build_body  # noqa: E402
from app.codegen.template import render_script  # noqa: E402

import numpy as np  # noqa: E402
from manim.renderer.cairo_renderer import CairoRenderer  # noqa: E402

TOL = 0.03


# ---------------------------------------------------------------------------
# IR builders
# ---------------------------------------------------------------------------

def axes(oid: str = "ax") -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.COORDINATE_SYSTEM, name=oid,
        style=StyleDef(stroke_color="#FFFFFF", stroke_width=2.0),
        props={"subtype": "axes", "x_range": [0, 6, 1], "y_range": [0, 4, 1],
               "x_length": 6, "y_length": 4, "include_numbers": False},
    )


def hist(oid: str = "h", values=(0, 0, 0), parent: str | None = None, **props) -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.GRAPH, name=oid, parent_id=parent,
        style=StyleDef(stroke_color="#FFFFFF", stroke_width=2.0,
                       fill_color="#3366FF", fill_opacity=0.7),
        props={"subtype": "histogram", "axes_ref": "ax", "bin_start": 1,
               "bin_width": 1, "values": list(values), **props},
    )


def number(oid: str = "n", value: float = 0, decimals: int = 0, label: str = "n =",
           color: str = "#FFFF00", x: float = 0.0) -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.NUMBER, name=oid, position=Point2D(x=x, y=3.0),
        style=StyleDef(fill_color=color, fill_opacity=1.0),
        props={"value": value, "decimals": decimals, "label": label, "font_size": 48},
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def _data(mob):
    """What a tracked mobject holds right now: bar heights for a histogram, the
    value for a number readout, else None."""
    if hasattr(mob, "_locus_vals"):
        return list(mob._locus_vals)
    if len(mob.submobjects) and hasattr(mob[-1], "number"):
        return float(mob[-1].number)
    return None


def _geo(track) -> dict:
    """How far attached graphs sit from where their axes say they belong (scene
    units): bar 0's base corner vs `c2p(bin_start, 0)` (or the bin's midpoint
    once collapsed to an empty bar), and a `y = x` plot's first point vs
    `c2p(0, 0)`. 0 means the graph is riding along with its axes."""
    out = {}
    ax = track.get("m_ax")
    if ax is None:
        return out
    h = track.get("m_h")
    if h is not None and len(h[0].points):
        p0 = h[0].points[0]
        out["m_h"] = min(float(np.linalg.norm(p0 - ax.c2p(1, 0))), float(np.linalg.norm(p0 - ax.c2p(1.5, 0))))
    pl = track.get("m_p")
    if pl is not None and len(pl.points):
        out["m_p"] = float(np.linalg.norm(pl.points[0] - ax.c2p(0, 0)))
    return out


def run(ir):
    body = build_body(ir)
    base = "MovingCameraScene" if _uses_camera(ir) else "Scene"
    src = _instrument(render_script(body=body, background_color="#000000", base_class=base))
    ns: dict = {}
    exec(compile(src, "<generated_scene>", "exec"), ns)
    samples: list[tuple[float, dict, dict]] = []

    class Probe(ns["LocusScene"]):
        def setup(self):
            self._locus_track = {}

        def is_current_animation_frozen_frame(self):
            return False

        def update_to_time(self, t):
            super().update_to_time(t)
            samples.append((self.renderer.time, _snapshot(self),
                            {k: _data(m) for k, m in self._locus_track.items()},
                            _geo(self._locus_track)))

    if base == "MovingCameraScene":
        from manim.camera.moving_camera import MovingCamera
        renderer = CairoRenderer(file_writer_class=StubFileWriter, camera_class=MovingCamera)
    else:
        renderer = CairoRenderer(file_writer_class=StubFileWriter)
    scene = Probe(renderer=renderer)
    scene.render()
    return samples, scene, src


def at(samples, t):
    """The sample nearest time t."""
    return min(samples, key=lambda s: abs(s[0] - t))


def close(a, b) -> bool:
    if isinstance(a, list):
        return isinstance(b, (list, tuple)) and len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    return a is not None and abs(float(a) - float(b)) <= TOL * max(1.0, abs(float(b)))


# ---------------------------------------------------------------------------
# Scenarios: fn() -> (IRScene, check(samples, scene) -> list[str] of failures)
# ---------------------------------------------------------------------------

SCENARIOS: dict = {}


def scenario(fn):
    SCENARIOS[fn.__name__] = fn
    return fn


def expect_data(samples, name, points):
    errs = []
    for t, want in points:
        got = at(samples, t)[2].get(name)
        if not close(got, want):
            errs.append(f"{name} @ {t}s: got {got}, want {want}")
    return errs


@scenario
def hist_chain():
    """Two linear updates with a gap: each starts from where the last ended
    (a construction-time snapshot would restart the second from 0)."""
    kfs = [kf("h", "update_data", 0.0, 1.0, {"values": [1, 2, 3]}),
           kf("h", "update_data", 2.0, 1.0, {"values": [3, 2, 1]})]

    def check(samples, scene):
        errs = expect_data(samples, "m_h", [(0.5, [0.5, 1, 1.5]), (1.5, [1, 2, 3]),
                                            (2.5, [2, 2, 2]), (3.0, [3, 2, 1])])
        # The bars really are that tall: bar 0's top edge sits at data y=3.
        h, ax = scene._locus_track["m_h"], scene._locus_track["m_ax"]
        top = h[0].get_top()[1]
        if abs(top - ax.c2p(0, 3)[1]) > 1e-3:
            errs.append(f"bar 0 top at {top:.3f}, axes y=3 is {ax.c2p(0, 3)[1]:.3f}")
        if abs(h[0].get_left()[0] - ax.c2p(1, 0)[0]) > 1e-3:
            errs.append("bar 0 does not start at bin_start")
        return errs
    return ir_scene([axes(), hist()], kfs), check


@scenario
def hist_delayed_write_then_update():
    """Written in at 1s, updated at 2s: hidden before its Write even though the
    update keyframe exposes it to the play from t=0 (the hide pass)."""
    kfs = [kf("h", "write", 1.0, 1.0), kf("h", "update_data", 2.0, 1.0, {"values": [2, 2, 2]})]

    def check(samples, scene):
        errs = []
        if _visible(at(samples, 0.5)[1]["m_h"]):
            errs.append("histogram visible before its Write")
        if not _visible(at(samples, 2.5)[1]["m_h"]):
            errs.append("histogram not visible after its Write")
        return errs + expect_data(samples, "m_h", [(3.0, [2, 2, 2])])
    return ir_scene([axes(), hist(values=[1, 1, 1])], kfs), check


@scenario
def hist_more_values_than_bins():
    """An update carrying more values than there are bars is truncated, fewer is
    padded with zeros (the bin count changed after the keyframes were made)."""
    kfs = [kf("h", "update_data", 0.0, 1.0, {"values": [1, 2, 3, 4, 5]}),
           kf("h", "update_data", 1.0, 1.0, {"values": [2]})]

    def check(samples, scene):
        return expect_data(samples, "m_h", [(1.0, [1, 2, 3]), (2.0, [2, 0, 0])])
    return ir_scene([axes(), hist()], kfs), check


@scenario
def hist_group_fadeout():
    """A histogram in a group with its axes: the group fades out after an update
    and stays gone."""
    g = SceneObject(id="G", type=ObjectType.GROUP, name="G", props={})
    ax = axes()
    ax.parent_id = "G"
    kfs = [kf("h", "update_data", 0.0, 1.0, {"values": [1, 2, 3]}), kf("G", "fade_out", 1.5, 1.0)]

    def check(samples, scene):
        errs = []
        if not _visible(at(samples, 1.0)[1]["m_h"]):
            errs.append("histogram hidden before the fade")
        if _visible(_snapshot(scene)["m_h"]):
            errs.append("histogram visible after the group faded out")
        return errs
    return ir_scene([ax, hist(parent="G"), g], kfs), check


@scenario
def number_chain():
    kfs = [kf("n", "update_data", 0.0, 1.0, {"value": 100}),
           kf("n", "update_data", 2.0, 1.0, {"value": 250})]

    def check(samples, scene):
        errs = expect_data(samples, "m_n", [(0.5, 50), (1.5, 100), (2.5, 175), (3.0, 250)])
        n = scene._locus_track["m_n"]
        # Every glyph kept the authored colour as digits were added.
        cols = {sm.get_fill_color().to_hex().upper() for sm in n[-1].get_family() if len(sm.points)}
        if cols != {"#FFFF00"}:
            errs.append(f"digit colours {cols}, want only #FFFF00")
        # Same baseline as the label: the number's bottom matches a digit's.
        return errs
    return ir_scene([number()], kfs), check


@scenario
def number_counts_while_hidden():
    """Faded out, counted up to more digits, faded back in: the new digits must
    stay hidden meanwhile (DecimalNumber.set_value builds them fully opaque)."""
    kfs = [kf("n", "fade_out", 0.0, 0.5), kf("n", "update_data", 1.0, 1.0, {"value": 12345}),
           kf("n", "fade_in", 3.0, 1.0)]

    def check(samples, scene):
        errs = []
        for t in (1.5, 2.5):
            if _visible(at(samples, t)[1]["m_n"]):
                errs.append(f"readout visible at {t}s while faded out")
        if not _visible(_snapshot(scene)["m_n"]):
            errs.append("readout not visible after its fade-in")
        return errs + expect_data(samples, "m_n", [(2.5, 12345)])
    return ir_scene([number(value=1)], kfs), check


@scenario
def number_without_label():
    kfs = [kf("n", "write", 0.0, 1.0), kf("n", "update_data", 1.0, 1.0, {"value": 3.14159})]

    def check(samples, scene):
        return expect_data(samples, "m_n", [(2.0, 3.14159)])
    return ir_scene([number(label="", decimals=2)], kfs), check


@scenario
def mismatched_params_dropped():
    """A `value` update on a histogram / `values` on a number can't run — the
    scene builder drops them instead of emitting a call that raises."""
    kfs = [kf("h", "update_data", 0.0, 1.0, {"value": 3}),
           kf("n", "update_data", 0.0, 1.0, {"values": [1, 2]}),
           kf("h", "update_data", 1.0, 1.0, {"values": [1, 1, 1]})]

    def check(samples, scene):
        return expect_data(samples, "m_h", [(2.0, [1, 1, 1])]) + expect_data(samples, "m_n", [(2.0, 7)])
    return ir_scene([axes(), hist(), number(value=7)], kfs), check


@scenario
def sequential_model():
    """Camera tracking switches to one self.play per slot; updates still chain."""
    kfs = [kf("n", "update_data", 0.0, 1.0, {"value": 10}),
           kf("h", "update_data", 0.0, 1.0, {"values": [1, 2, 3]}),
           kf("__camera__", "camera_move", 0.0, 3.0, {"focus_object_id": "n", "track": True, "zoom": 1}),
           kf("n", "update_data", 2.0, 1.0, {"value": 20}),
           kf("h", "update_data", 2.0, 1.0, {"values": [0, 0, 0]})]

    def check(samples, scene):
        return (expect_data(samples, "m_n", [(1.5, 10), (3.0, 20)])
                + expect_data(samples, "m_h", [(1.5, [1, 2, 3]), (3.0, [0, 0, 0])]))
    return ir_scene([axes(), hist(), number()], kfs), check


def plot(oid: str = "p") -> SceneObject:
    return SceneObject(
        id=oid, type=ObjectType.GRAPH, name=oid,
        style=StyleDef(stroke_color="#FFFF00", stroke_width=2.0),
        props={"subtype": "function_plot", "axes_ref": "ax", "expression": "x", "x_range": [0, 4]},
    )


def expect_attached(samples, names=("m_h", "m_p")):
    """Every frame: each attached graph sits where its axes put it."""
    worst: dict[str, tuple[float, float]] = {}
    for t, _vis, _d, geo in samples:
        for n in names:
            if n in geo and geo[n] > worst.get(n, (0.0, 0.0))[0]:
                worst[n] = (geo[n], t)
    return [f"{n} drifted {d:.3f} off its axes @ {t:.2f}s" for n, (d, t) in worst.items() if d > 1e-3]


@scenario
def graphs_follow_axes():
    """Axes drawn in, then moved / rotated / scaled: the histogram and a plot ride
    along every frame (they are separate mobjects — `_locus_follow`), including
    a move_to (pivot = data midpoint) and while the bars update mid-move. A move
    keyframe on the histogram itself is dropped, not applied on top."""
    kfs = [kf("ax", "create", 0.0, 1.0),
           kf("ax", "move", 1.0, 1.0, {"target_position": {"x": 2, "y": 1}}),
           kf("h", "move", 1.0, 1.0, {"target_position": {"x": 2, "y": 1}}),
           kf("h", "update_data", 1.5, 1.0, {"values": [1, 2, 3]}),
           kf("ax", "rotate", 2.0, 1.0, {"angle_degrees": 90}),
           kf("ax", "scale", 3.0, 1.0, {"factor": 0.5})]

    def check(samples, scene):
        errs = expect_attached(samples)
        ax = scene._locus_track["m_ax"]
        if np.linalg.norm(ax.c2p(3, 2) - np.array([2, 1, 0])) > 1e-3:
            errs.append(f"axes data midpoint at {ax.c2p(3, 2)}, want (2, 1)")
        return errs + expect_data(samples, "m_h", [(3.0, [1, 2, 3])])
    a = axes()
    a.props.update({"include_numbers": True, "tips": True})
    return ir_scene([a, hist(values=[1, 1, 1]), plot()], kfs), check


@scenario
def graphs_follow_group_once():
    """Axes + histogram + plot in one group that moves: everything moves once —
    the follower must not add the axes' motion on top of the group's."""
    g = SceneObject(id="G", type=ObjectType.GROUP, name="G", props={})
    a, h, p = axes(), hist(values=[1, 2, 1], parent="G"), plot()
    a.parent_id = "G"
    p.parent_id = "G"
    kfs = [kf("G", "move", 0.0, 1.0, {"delta": {"x": 1.5, "y": -1}}),
           kf("ax", "scale", 1.0, 1.0, {"factor": 0.8})]

    def check(samples, scene):
        return expect_attached(samples)
    return ir_scene([a, h, p, g], kfs), check


@scenario
def empty_bars_draw_nothing():
    """A zero-height bar is collapsed to a point: no stroke along the base (it
    read as a stray x-axis before the axes were drawn in)."""
    kfs = [kf("ax", "create", 1.0, 1.0), kf("h", "update_data", 2.0, 1.0, {"values": [0, 2, 0]})]

    def check(samples, scene):
        errs = []
        h = scene._locus_track["m_h"]
        for i in (0, 2):
            w = float(np.ptp(h[i].points[:, 0])) if len(h[i].points) else 0.0
            if w > 1e-6:
                errs.append(f"empty bar {i} still spans {w:.3f} wide")
        if h[1].height < 1.0:
            errs.append("bar 1 did not grow")
        return errs
    return ir_scene([axes(), hist(values=[0, 0, 0])], kfs), check


# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    names = argv or list(SCENARIOS)
    failed = 0
    for name in names:
        try:
            ir, check = SCENARIOS[name]()
            samples, scene, _src = run(ir)
            errs = check(samples, scene)
        except Exception:
            errs = ["raised:\n" + traceback.format_exc()]
        if errs:
            failed += 1
            print(f"FAIL {name}")
            for e in errs:
                print(f"     {e}")
        else:
            print(f"ok   {name}")
    print(f"\n{len(names) - failed}/{len(names)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
