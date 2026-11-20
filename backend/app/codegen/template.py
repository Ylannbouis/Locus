"""Jinja2 template for the generated Manim scene script."""
from __future__ import annotations

from jinja2 import Template

SCENE_CLASS_NAME = "LocusScene"

# Helpers emitted into the script only when the body uses them.
#
# LocusApply / LocusFade replace `.animate`-style transforms and FadeIn/FadeOut:
#   - Their Transform target is built at begin() time (Succession begins its
#     segments lazily), so each animation composes with everything that already
#     played in the same self.play — a pre-built target (`.animate`, or
#     `Transform(m, m.copy()...)`) snapshots pre-play state and would e.g.
#     resurrect an object that faded out earlier in the play.
#   - Fades are NOT removers. Manim's FadeOut removes its mobject during
#     clean-up and then resets it to full visibility (`interpolate(0)`), while
#     `Scene.remove` does not extract the removed mobject's family from *other*
#     scene containers (every play wraps animated mobjects in helper Groups) —
#     the combination made grouped objects reappear after a group fade-out.
#     LocusFade just drives opacity to `alpha` × the authored value and leaves
#     scene membership alone.
_LOCUS_FX_HELPER = '''

def _locus_authored_alphas(mobject):
    """Authored opacity (fill, stroke, background-stroke) per family member.
    Reads a member's `saved_state` when present (objects pre-hidden with
    set_opacity(0) call save_state() first), else the member itself — helpers
    are constructed before the play runs, so that *is* the authored state.
    A deeper member's own saved_state wins over an ancestor's."""
    ref = {id(sm): sm for sm in mobject.get_family()}
    for sm in mobject.get_family():
        saved = getattr(sm, "saved_state", None)
        if saved is not None:
            for live, kept in zip(sm.get_family(), saved.get_family()):
                ref[id(live)] = kept
    alphas = []
    for sm in mobject.get_family():
        r = ref[id(sm)]
        if isinstance(r, VMobject):
            alphas.append((r.get_fill_opacity(), r.get_stroke_opacity(),
                           r.get_stroke_opacity(background=True)))
        else:
            alphas.append(float(getattr(r, "fill_opacity", 1.0)))
    return alphas


def _locus_apply_alpha(sm, authored, k):
    if isinstance(sm, VMobject):
        f, s, b = authored if isinstance(authored, tuple) else (1.0, 1.0, 1.0)
        sm.set_fill(opacity=k * f, family=False)
        sm.set_stroke(opacity=k * s, family=False)
        sm.set_stroke(opacity=k * b, family=False, background=True)
    elif not sm.submobjects:
        try:
            sm.set_opacity(k * (authored if isinstance(authored, float) else 1.0))
        except (AttributeError, TypeError):
            pass


class LocusApply(Transform):
    """Transform to a target built at begin() from the mobject's *current*
    state: `func` (move/scale/rotate chain) is applied to a fresh copy, and
    `opacity` fades every family member toward `opacity` × its authored
    opacity. `intro_shift` offsets the starting state (fade_in with a shift
    slides into place)."""

    def __init__(self, mobject, func=None, opacity=None, intro_shift=None, **kwargs):
        self._locus_func = func
        self._locus_opacity = opacity
        self._locus_intro_shift = intro_shift
        self._locus_authored = _locus_authored_alphas(mobject) if opacity is not None else None
        super().__init__(mobject, **kwargs)

    # AnimationGroup.finish() re-finishes *every* member at the end of the play,
    # and Animation.finish() re-interpolates to 1 — so a transform that ended
    # long ago would snap its whole family back to its own target, undoing
    # whatever later animations did to members (a group moved, then its axes
    # scaled: the axes' graphs snapped back). Once a LocusApply has played to
    # its end, finishing it again leaves the mobject alone.
    def interpolate(self, alpha):
        self._locus_done = alpha >= 1
        super().interpolate(alpha)

    def finish(self):
        if getattr(self, "_locus_done", False):
            if self.suspend_mobject_updating and self.mobject is not None:
                self.mobject.resume_updating()
            return
        super().finish()

    def create_target(self):
        target = self.mobject.copy()
        if self._locus_func is not None:
            target = self._locus_func(target)
        if self._locus_opacity is not None:
            for sm, authored in zip(target.get_family(), self._locus_authored):
                _locus_apply_alpha(sm, authored, self._locus_opacity)
        return target

    def create_starting_mobject(self):
        start = super().create_starting_mobject()
        if self._locus_intro_shift is not None:
            start.shift(self._locus_intro_shift)
        return start

    def interpolate_submobject(self, submobject, starting_submobject, target_copy, alpha):
        # A fade on a group and a transform on one of its children (or the
        # reverse) are two animations whose families overlap: both interpolate
        # the shared member each frame and the later one clobbers the other.
        # So: a pure fade drives *style only* and a pure transform drives
        # *geometry only* — concurrent family-overlapping animations then
        # compose instead of fighting. A fused fade+transform (or a shifted
        # fade) owns its object outright and interpolates everything.
        pure_fade = (self._locus_func is None and self._locus_intro_shift is None
                     and self._locus_opacity is not None)
        pure_move = self._locus_opacity is None
        if pure_fade:
            submobject.interpolate_color(starting_submobject, target_copy, alpha)
            return self
        if pure_move and isinstance(submobject, VMobject):
            submobject.points = self.path_func(
                starting_submobject.points, target_copy.points, alpha)
            return self
        return super().interpolate_submobject(
            submobject, starting_submobject, target_copy, alpha)


def _locus_reveal(mobject):
    """Restore the authored opacity of a hidden-until-creation mobject at once
    (a statement, for the sequential model; geometry untouched)."""
    for sm, authored in zip(mobject.get_family(), _locus_authored_alphas(mobject)):
        _locus_apply_alpha(sm, authored, 1.0)


def LocusFade(mobject, alpha, shift=None, **kwargs):
    """Fade in place to `alpha` × the mobject's authored opacity (no scene
    add/remove). A shift drifts the mobject by that vector while fading out,
    or slides it into place from the opposite offset while fading in."""
    func = None
    intro_shift = None
    if shift is not None:
        vec = np.asarray(shift, dtype=float)
        if alpha > 0:
            intro_shift = -vec
        else:
            def func(m, _v=vec):
                return m.shift(_v)
    return LocusApply(mobject, func=func, opacity=alpha, intro_shift=intro_shift, **kwargs)

'''

# A creation verb (Write/Create/…) fused with a simultaneous move/scale/rotate
# on the same mobject (see animations.emit_intro_transform). Creation animations
# rebuild the mobject from its captured start state on every frame, so applying
# the partial transform *after* each interpolation step composes cleanly —
# running the introducer and a Transform as two animations on one mobject would
# fight.
_LOCUS_INTRO_HELPER = '''

def LocusIntro(base_cls, mobject, shift=None, move_to=None, scale=None, rotate=None,
             rotate_about=None, intro_span=(0.0, 1.0), xform_span=(0.0, 1.0),
             xform_rate=smooth, **kwargs):
    """A creation animation (Write/Create/DrawBorderThenFill) that also applies a
    move/scale/rotate while it draws. The spans are (start, end) fractions of this
    animation's run_time, so the creation and the transform can each cover only
    part of their union window; kwargs (run_time, rate_func) go to the base
    animation, whose rate_func shapes the drawing while xform_rate shapes the
    transform. `rotate_about` pivots the rotation about a fixed scene point
    instead of the mobject's own center."""
    def sub_alpha(alpha, span):
        lo, hi = span
        return min(1.0, max(0.0, (alpha - lo) / max(hi - lo, 1e-6)))

    class _MasIntro(base_cls):
        def begin(self):
            self._locus_about = _locus_pivot(self.mobject).copy()
            delta = np.zeros(3)
            if move_to is not None:
                delta = delta + (np.asarray(move_to, dtype=float) - self._locus_about)
            if shift is not None:
                delta = delta + np.asarray(shift, dtype=float)
            self._locus_delta = delta
            super().begin()

        # Same end-of-play guard as LocusApply.finish: don't rebuild the
        # mobject from this animation's start state once it has played out.
        def interpolate(self, alpha):
            self._locus_done = alpha >= 1
            super().interpolate(alpha)

        def finish(self):
            if getattr(self, "_locus_done", False):
                if self.suspend_mobject_updating and self.mobject is not None:
                    self.mobject.resume_updating()
                return
            super().finish()

        def interpolate_mobject(self, alpha):
            super().interpolate_mobject(sub_alpha(alpha, intro_span))
            t = xform_rate(sub_alpha(alpha, xform_span))
            m = self.mobject
            if scale is not None:
                m.scale(1.0 + (float(scale) - 1.0) * t, about_point=self._locus_about)
            if rotate and rotate_about is None:
                m.rotate(rotate * t, about_point=self._locus_about)
            m.shift(self._locus_delta * t)
            # A fixed-point pivot does not commute with the shift; the fused
            # chain's convention is move first, then orbit the anchor, so the
            # anchored rotate is applied after the shift.
            if rotate and rotate_about is not None:
                m.rotate(rotate * t, about_point=np.asarray(rotate_about, dtype=float))

    return _MasIntro(mobject, **kwargs)

'''


# Where a mobject "is" for move/scale/rotate. Usually its bbox center, but a
# coordinate system is placed by its *data midpoint* (`_locus_mid`, set by
# emit_object) — the editor's `position` — and its bbox also covers tips, tick
# numbers and labels, which are lopsided. Moving / scaling / rotating about the
# bbox center would land the axes somewhere other than the preview shows.
_LOCUS_PIVOT_HELPER = '''

def _locus_pivot(m):
    mid = getattr(m, "_locus_mid", None)
    if mid is not None:
        if hasattr(m, "c2p") and len(mid) >= 2:
            return np.array(m.c2p(mid[0], mid[1]), dtype=float)
        if hasattr(m, "number_to_point"):
            return np.array(m.number_to_point(mid[0]), dtype=float)
    return m.get_center()


def _locus_to(m, point):
    """The shift that puts `m`'s pivot at `point` (move_to, pivot-aware)."""
    return np.asarray(point, dtype=float) - _locus_pivot(m)

'''

# Graphs attached to an Axes (function plots, histograms, …) belong to it: when
# the axes moves, scales or rotates — by its own keyframe, a group's, a fade
# with a shift, an Indicate — they go along, like the editor preview shows.
# They are separate mobjects in Manim, so a scene updater carries them: every
# frame it measures where the axes' coordinate frame went since the last frame
# and applies the same similarity transform to each follower.
#   - The frame is read from points that survive partial drawing (each axis
#     line's first point and the last tick's first point — Create/Write keep a
#     submobject's first point fixed), so drawing the axes in doesn't count as
#     motion.
#   - A follower that already moved the same way this frame (it is in a group
#     that moved together with the axes) is left alone, or it would move twice.
#   - A histogram is re-laid out from its data against the live axes instead
#     (exact, and composes with a concurrent update_data).
_LOCUS_FOLLOW_HELPER = '''

def _locus_axes_frame(axes):
    pts = []
    for ax in (getattr(axes, "x_axis", None), getattr(axes, "y_axis", None)):
        if ax is not None and len(ax.points):
            pts.append(np.array(ax.points[0][:2], dtype=float))
    for ax in (getattr(axes, "x_axis", None), getattr(axes, "y_axis", None)):
        ticks = getattr(ax, "ticks", None) if ax is not None else None
        if ticks is not None and len(ticks.submobjects) and len(ticks[-1].points):
            pts.append(np.array(ticks[-1].points[0][:2], dtype=float))
    a = pts[0] if pts else None
    for b in pts[1:]:
        if np.linalg.norm(b - a) > 1e-6:
            return a, b
    return None


def _locus_similarity(prev, cur):
    """(R, t) with R a 2x2 rotation*scale such that p -> R p + t maps the
    previous frame's two reference points onto the current ones."""
    (a0, b0), (a1, b1) = prev, cur
    u, v = b0 - a0, b1 - a1
    d = complex(*v) / complex(*u)
    R = np.array([[d.real, -d.imag], [d.imag, d.real]])
    return R, a1 - R @ a0


def _locus_follow(scene, axes, followers):
    state = {"frame": _locus_axes_frame(axes),
             "pts": [np.concatenate([sm.points for sm in f.get_family()] or [np.zeros((0, 3))])
                     for f in followers]}

    def follow(dt):
        cur = _locus_axes_frame(axes)
        prev = state["frame"]
        if cur is None:
            return
        state["frame"] = cur
        if prev is None:
            return
        if np.allclose(prev[0], cur[0], atol=1e-9) and np.allclose(prev[1], cur[1], atol=1e-9):
            moved = False
        else:
            moved = True
        R, t = _locus_similarity(prev, cur)
        for i, f in enumerate(followers):
            if moved:
                if hasattr(f, "_locus_layout"):
                    _locus_set_bars(f, getattr(f, "_locus_vals", []))
                else:
                    old = state["pts"][i]
                    now = np.concatenate([sm.points for sm in f.get_family()] or [np.zeros((0, 3))])
                    want = old[:, :2] @ R.T + t if len(old) else old
                    same = (len(now) == len(old) and len(old)
                            and np.allclose(now[:, :2], want, atol=1e-4))
                    if not same:
                        for sm in f.get_family():
                            if len(sm.points):
                                sm.points[:, :2] = sm.points[:, :2] @ R.T + t
            state["pts"][i] = np.concatenate([sm.points for sm in f.get_family()] or [np.zeros((0, 3))]).copy()

    scene.add_updater(follow)
    return follow

'''

# Data-driven objects: the `graph.histogram` bars and the `number` readout, plus
# the `update_data` animations that move them to new data. Like LocusApply,
# both animations read their *start* from the live mobject at begin() (Succession
# begins segments lazily), so a chain of updates on one object composes — a
# ChangeDecimalToValue, by contrast, snapshots its start value at construction.
#
# The histogram keeps no reference to its Axes as an attribute: Mobject.copy()
# deep-copies attributes, and every save_state / Transform target would drag a
# copy of the whole Axes along. The layout closure is shared instead (deepcopy
# treats functions as atomic) and always measures against the live Axes.
_LOCUS_DATA_HELPER = '''

def _locus_set_bars(bars, values):
    """Lay the bars out for `values` (data-y heights), padding/truncating to the
    bar count, and remember them so the next LocusBars starts from here."""
    n = len(bars.submobjects)
    vals = ([float(v) for v in values] + [0.0] * n)[:n]
    bars._locus_layout(bars, vals)
    bars._locus_vals = vals
    return bars


def LocusHistogram(axes, bin_start, bin_width, values, gap=0.0):
    """Bars on `axes`: bar i covers [bin_start + i*w, bin_start + (i+1)*w] (minus
    `gap`/2 of a bin on each side) and rises from y=0 — clamped into the y range —
    to values[i]. Each bar is a plain closed VMobject whose points are rewritten
    in place, so styling survives every update; an empty bin collapses to a
    point (no stroke along the base)."""
    gap = min(max(float(gap), 0.0), 0.95)

    def layout(bars, vals):
        y0, y1 = float(axes.y_range[0]), float(axes.y_range[1])
        base = min(max(0.0, y0), y1)
        for i, (bar, h) in enumerate(zip(bars.submobjects, vals)):
            xl = bin_start + (i + gap / 2) * bin_width
            xr = bin_start + (i + 1 - gap / 2) * bin_width
            if abs(h - base) < 1e-9:
                # An empty bin draws nothing: a zero-height outline would still
                # stroke a line along the base, reading as a stray x-axis
                # (e.g. before the axes are drawn in). One repeated point keeps
                # the bar a valid path that later updates grow from.
                p = axes.c2p((xl + xr) / 2, base)
                bar.set_points_as_corners([p, p])
                continue
            bar.set_points_as_corners([
                axes.c2p(xl, base), axes.c2p(xr, base), axes.c2p(xr, h),
                axes.c2p(xl, h), axes.c2p(xl, base),
            ])

    bars = VGroup(*[VMobject() for _ in values])
    bars._locus_layout = layout
    return _locus_set_bars(bars, values)


class LocusBars(Animation):
    """`update_data` on a histogram: every bar grows/shrinks from its current
    height to the new one."""

    def __init__(self, mobject, values, **kwargs):
        self._locus_to = [float(v) for v in values]
        super().__init__(mobject, **kwargs)

    def begin(self):
        n = len(self.mobject.submobjects)
        self._locus_from = (list(getattr(self.mobject, "_locus_vals", [])) + [0.0] * n)[:n]
        self._locus_to = (self._locus_to + [0.0] * n)[:n]
        super().begin()

    def interpolate_mobject(self, alpha):
        t = self.rate_func(alpha)
        _locus_set_bars(self.mobject, [a + (b - a) * t for a, b in zip(self._locus_from, self._locus_to)])


def LocusNumber(value, places=2, font_size=48, label=None):
    """A DecimalNumber, optionally after a LaTeX label on the same baseline. The
    label is typeset together with a placeholder digit ("n = 0") and the number
    is dropped onto that digit, so the gap and baseline are TeX's own. Always a
    VGroup whose last member is the DecimalNumber (what LocusCount drives). No
    thousands commas: a comma descends below the baseline and would shift the
    bottom-aligned number up."""
    num = DecimalNumber(value, num_decimal_places=places, font_size=font_size,
                        group_with_commas=False)
    if not label:
        return VGroup(num)
    ref = MathTex(label, "0", font_size=font_size)
    num.move_to(ref[1], aligned_edge=DL)
    return VGroup(ref[0], num)


def _locus_set_number(num, value):
    # DecimalNumber.set_value rebuilds its glyphs and only matches style pairwise
    # with the old ones, so a value gaining digits would show the extra ones in
    # the default style (white, fully opaque — even while the readout is hidden
    # or faded). Restyle every glyph from the old first one instead.
    src = num.submobjects[0] if num.submobjects else None
    num.set_value(value)
    if src is not None:
        for sm in num.submobjects:
            sm.match_style(src)


class LocusCount(Animation):
    """`update_data` on a number readout: count from the live value to `value`."""

    def __init__(self, mobject, value, **kwargs):
        self._locus_to = float(value)
        super().__init__(mobject, **kwargs)

    def begin(self):
        self._locus_from = float(self.mobject[-1].number)
        super().begin()

    def interpolate_mobject(self, alpha):
        t = self.rate_func(alpha)
        _locus_set_number(self.mobject[-1], self._locus_from + (self._locus_to - self._locus_from) * t)

'''

# Emitted only for worker renders (`render_script(progress_total=…)`), never for
# the ejected script the user downloads. It gives the render worker a *real*
# progress signal: Manim's own per-frame counter.
#
# `Scene.play_internal` drives every play AND every wait by iterating the
# tqdm returned from `get_time_progression` — one item per rendered frame, with
# the animation-time offset as its value. Wrapping that iterator is therefore the
# one hook that sees every frame, without touching how anything renders. The
# wrapper only counts; it forwards the frame time untouched.
#
# `_locus_total` is the scene's expected animation seconds, baked in by codegen,
# so the worker gets a fraction it can trust rather than a guess. A cached play
# yields a single item (Manim sets `skip_animations`), so it jumps straight to
# its end time — which is accurate: that play really is done.
_LOCUS_PROGRESS_HELPER = '''
import time as _time


class _LocusFrameCounter:
    """Proxies Manim's frame iterator, reporting elapsed animation time."""

    def __init__(self, scene, inner, run_time):
        self._scene = scene
        self._inner = inner
        self._run_time = run_time

    def __iter__(self):
        base = self._scene._locus_elapsed
        self._scene._locus_counted = True
        for t in self._inner:
            self._scene._locus_report(base + min(float(t), self._run_time))
            yield t
        self._scene._locus_elapsed = base + self._run_time
        self._scene._locus_report(self._scene._locus_elapsed, force=True)

    def __getattr__(self, name):  # .close(), .n, … stay Manim's
        return getattr(self._inner, name)


class _LocusProgress:
    """Mixin: prints `LOCUS_PROGRESS <done_s> <total_s>` as frames render."""

    _locus_total = 1.0
    _locus_elapsed = 0.0
    _locus_last_emit = 0.0
    _locus_counted = False

    def play(self, *args, **kwargs):
        self._locus_counted = False
        super().play(*args, **kwargs)
        if not self._locus_counted:
            # A static wait renders as a frozen frame: the renderer duplicates
            # one image for the whole duration and never runs the frame loop, so
            # the counter above never sees it. Settling up here keeps elapsed
            # aligned with the timeline — and a frozen wait really is that fast.
            self._locus_elapsed += float(getattr(self, "duration", 0.0) or 0.0)
            self._locus_report(self._locus_elapsed, force=True)

    def _locus_report(self, done, force=False):
        now = _time.monotonic()
        if not force and now - self._locus_last_emit < 0.2:
            return  # a 60fps render would otherwise flood the pipe
        self._locus_last_emit = now
        print("LOCUS_PROGRESS %.3f %.3f" % (done, self._locus_total), flush=True)

    def get_time_progression(self, run_time, description, n_iterations=None,
                             override_skip_animations=False):
        inner = super().get_time_progression(
            run_time, description, n_iterations, override_skip_animations)
        if n_iterations is not None and n_iterations < 0:
            return inner  # open-ended (stop_condition) wait: no known length
        return _LocusFrameCounter(self, inner, float(run_time))

'''

# Range renders (worker only): output just the frames in [t0, t1) of the scene's
# timeline. Everything still *runs* — mobjects are built, every animation
# interpolates, so the state at t0 is exactly right — but frames before t0 / after
# t1 are never rasterized (the Cairo draw is the expensive part), only counted on
# the renderer's clock (`renderer.time`, which drives everything here):
#   - `render` (one animation frame): draw + emit only inside the window;
#   - `add_frame` (also hit directly by frozen-frame waits with num_frames > 1):
#     emit only the slice of those frames inside the window;
#   - `play`: a play that ends up with no frames in the window has its partial
#     movie dropped (set to None — the file writer skips those), or Manim would
#     try to concat an empty segment.
_LOCUS_RANGE_HELPER = '''
import math as _math


class _LocusRange:
    _locus_t0 = 0.0
    _locus_t1 = 1e9

    def setup(self):
        super().setup()
        r = self.renderer
        if not hasattr(r, "add_frame") or not hasattr(r, "file_writer"):
            return  # not the Cairo renderer: render everything
        t0, t1 = float(self._locus_t0), float(self._locus_t1)
        dt = 1.0 / config.frame_rate
        half = dt / 2
        orig_render, orig_add, orig_play = r.render, r.add_frame, r.play
        written = [0]

        def inside():
            return t0 - half <= r.time < t1 - half

        def render(scene, time, moving_mobjects=None):
            if inside():
                orig_render(scene, time, moving_mobjects)
            elif not r.skip_animations:
                r.time += dt  # keep the clock, skip the draw

        def add_frame(frame, num_frames=1):
            if r.skip_animations:
                return orig_add(frame, num_frames)
            start = r.time
            lo = max(0, _math.ceil((t0 - half - start) / dt))
            hi = min(num_frames, _math.ceil((t1 - half - start) / dt))
            if hi > lo:
                r.time = start + lo * dt
                orig_add(frame, hi - lo)
                written[0] += hi - lo
            r.time = start + num_frames * dt

        def play(scene, *args, **kwargs):
            before = written[0]
            orig_play(scene, *args, **kwargs)
            fw = r.file_writer
            if written[0] == before and fw.partial_movie_files and fw.partial_movie_files[-1] is not None:
                fw.partial_movie_files[-1] = None
                if fw.sections and fw.sections[-1].partial_movie_files:
                    fw.sections[-1].partial_movie_files[-1] = None

        r.render, r.add_frame, r.play = render, add_frame, play

'''

# The construct body is pre-rendered (already indented 8 spaces) and injected.
# base_class is "Scene" normally, or "MovingCameraScene" when the scene animates
# the camera (only that class exposes self.camera.frame).
_TEMPLATE = Template(
    '''# AUTO-GENERATED by Locus. Do not edit by hand.
from manim import *
import numpy as np
from numpy import sin, cos, tan, exp, log, sqrt, pi, e

{{ helpers }}
class {{ class_name }}({{ bases }}):
{{ class_prefix }}    def construct(self):
        self.camera.background_color = {{ background_color_repr }}
{{ body }}
''',
    keep_trailing_newline=True,
)


def render_script(body: str, background_color: str = "#000000",
                  base_class: str = "Scene",
                  progress_total: float | None = None,
                  time_range: tuple[float, float] | None = None) -> str:
    """Render the scene script. `progress_total` (the scene's expected animation
    seconds) adds the frame-progress instrumentation the render worker reads;
    leave it None — as the eject/`/script` endpoint does — for a clean script.
    `time_range` (worker only) outputs just those seconds — `_LocusRange`."""
    helpers = ""
    if "LocusApply(" in body or "LocusFade(" in body or "_locus_reveal(" in body:
        helpers += _LOCUS_FX_HELPER
    if any(n in body for n in ("_locus_pivot(", "_locus_to(", "LocusIntro(")):
        helpers += _LOCUS_PIVOT_HELPER
    if "LocusIntro(" in body:
        helpers += _LOCUS_INTRO_HELPER
    if any(n in body for n in ("LocusHistogram(", "LocusBars(", "LocusNumber(", "LocusCount(")):
        helpers += _LOCUS_DATA_HELPER
    if "_locus_follow(" in body:
        helpers += _LOCUS_FOLLOW_HELPER
    bases = base_class
    class_prefix = ""
    if progress_total is not None:
        helpers += _LOCUS_PROGRESS_HELPER
        bases = f"_LocusProgress, {base_class}"
        class_prefix = f"    _locus_total = {max(0.01, float(progress_total)):.3f}\n\n"
    if time_range is not None:
        t0, t1 = time_range
        helpers += _LOCUS_RANGE_HELPER
        bases = f"_LocusRange, {bases}"
        class_prefix += f"    _locus_t0 = {float(t0)!r}\n    _locus_t1 = {float(t1)!r}\n\n"
    return _TEMPLATE.render(
        class_name=SCENE_CLASS_NAME,
        background_color_repr=repr(background_color),
        bases=bases,
        class_prefix=class_prefix,
        body=body,
        helpers=helpers or "\n",
    )
