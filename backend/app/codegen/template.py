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
            self._locus_about = self.mobject.get_center().copy()
            delta = np.zeros(3)
            if move_to is not None:
                delta = delta + (np.asarray(move_to, dtype=float) - self._locus_about)
            if shift is not None:
                delta = delta + np.asarray(shift, dtype=float)
            self._locus_delta = delta
            super().begin()

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
    if "LocusApply(" in body or "LocusFade(" in body:
        helpers += _LOCUS_FX_HELPER
    if "LocusIntro(" in body:
        helpers += _LOCUS_INTRO_HELPER
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
