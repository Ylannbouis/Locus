"""Emit Manim Mobject construction code for each scene-model object type.

Supported (Phase 2):
  latex_text (MathTex/Tex, per-term coloring)
  text (plain prose via Tex text mode; the raw string is LaTeX-escaped)
  shape: rectangle, circle, ellipse, line, arrow, double_arrow, dashed_line, polygon
  coordinate_system: axes, number_line, number_plane
  graph: function_plot (references an axes object via props.axes_ref)
  matrix

Positioning semantics:
  - point-based shapes (line/arrow/double_arrow/dashed_line/polygon) keep their
    points in local space and use .shift(position) to translate.
  - graph.function_plot has no independent position (it follows its axes).
  - everything else uses .move_to(position) (centered at position).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app.models.ir import SceneObject

POINT_SHAPES = {"line", "arrow", "double_arrow", "dashed_line", "polygon"}
# Open shapes with no meaningful fill — color them with set_color so that e.g.
# an Arrow's filled tip is recolored too (set_stroke alone leaves the tip white).
LINE_LIKE = {"line", "arrow", "double_arrow", "dashed_line"}
# Graph subtypes that are anchored to an Axes (need a valid axes_ref).
AXES_BOUND_GRAPHS = {"function_plot", "parametric", "implicit"}
# Size at which Pango `Text` is always built, then scaled to the authored
# font_size. Large enough that Pango's glyph-advance hinting is stable (its
# quantization is ruinous in the single digits); matches the /48 convention the
# Matrix path already uses.
PANGO_REF_FONT_SIZE = 48

_DIR_CONST = {
    "UP": "UP", "DOWN": "DOWN", "LEFT": "LEFT", "RIGHT": "RIGHT",
    "UL": "UL", "UR": "UR", "DL": "DL", "DR": "DR",
}


def var_name(obj_id: str) -> str:
    safe = re.sub(r"[^0-9a-zA-Z_]", "_", obj_id)
    return f"m_{safe}"


def tracker_name(obj_id: str) -> str:
    safe = re.sub(r"[^0-9a-zA-Z_]", "_", obj_id)
    return f"t_{safe}"


def _expr(raw: Any, default: str) -> str:
    return raw if isinstance(raw, str) and raw.strip() else default


# LaTeX special characters that must be escaped so a `text` object renders the
# user's literal prose (e.g. "50% off" instead of "50" + a comment). Applied in a
# single pass (each source char → its replacement, output never re-scanned) so a
# replacement that itself contains braces (\textbackslash{}) isn't re-escaped.
# Kept in sync with `texEscape` in frontend/src/canvas/LatexOverlay.tsx.
_TEX_ESCAPE_MAP = {
    "\\": r"\textbackslash{}",
    "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def _tex_escape(s: str) -> str:
    return "".join(_TEX_ESCAPE_MAP.get(ch, ch) for ch in s)


def _sweep(obj: SceneObject) -> dict | None:
    props = obj.props or {}
    sw = props.get("sweep")
    if isinstance(sw, dict) and sw.get("enabled"):
        return sw
    return None


def _num(v: Any, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _point(p: Any) -> tuple[float, float]:
    if p is None:
        return 0.0, 0.0
    if isinstance(p, dict):
        return _num(p.get("x"), 0.0), _num(p.get("y"), 0.0)
    return _num(getattr(p, "x", None), 0.0), _num(getattr(p, "y", None), 0.0)


def _np(p: Any) -> str:
    x, y = _point(p)
    return f"np.array([{x}, {y}, 0.0])"


def _fmt_num(v: float) -> str:
    # Emit whole numbers without a trailing ".0". Manim's NumberLine infers the
    # tick label decimal count from the *string form of the step* (str(1.0)
    # -> "1.0" -> one decimal place), so an integer step must render as "1" for
    # whole-number ticks to show without decimals in the render.
    if v == int(v):
        return str(int(v))
    return str(v)


def _range(lst: Any, default: list[float]) -> str:
    if not isinstance(lst, (list, tuple)) or len(lst) < 2:
        lst = default
    vals = [_num(v, 0.0) for v in lst]
    # A non-positive step makes Manim's tick generation hang/raise — clamp it.
    if len(vals) >= 3 and vals[2] <= 0:
        vals[2] = 1.0
    return "[" + ", ".join(_fmt_num(v) for v in vals) + "]"


def _otype(obj: SceneObject) -> str:
    return obj.type.value if hasattr(obj.type, "value") else str(obj.type)


# ---------------------------------------------------------------------------
# Constructor expression
# ---------------------------------------------------------------------------

def _emit_construct(obj: SceneObject, assets_root: str | None = None) -> str:
    props = obj.props or {}
    otype = _otype(obj)

    if otype == "image":
        # `asset` is a filename inside the project's assets dir; the script runs
        # from a job dir, so bake in the absolute path (repr keeps backslashes).
        asset = str(props.get("asset") or "")
        path = str(Path(assets_root) / asset) if assets_root else asset
        return f"ImageMobject({path!r})"

    if otype == "latex_text":
        tex = props.get("tex_string", "")
        font_size = int(_num(props.get("font_size"), 42))
        use_mathtex = props.get("use_mathtex", True)
        ctor = "MathTex" if use_mathtex else "Tex"
        # Multi-line justification. MathTex defaults to LaTeX's align* environment,
        # which *right-aligns* lines with no '&' marker. Wrap multi-line content in
        # an array of the chosen column type (l/c/r) so lines are left/center/right
        # justified; move_to then centers the whole block on the anchor. Skipped for
        # single-line content (a no-op) and when the user uses '&' for explicit
        # align* column alignment (their alignment wins). Tex text-mode centers on
        # its own, so this only applies to MathTex.
        body = tex
        if use_mathtex and "\\\\" in tex and "&" not in tex:
            col = {"left": "l", "center": "c", "right": "r"}.get(
                str(props.get("align", "center")).lower(), "c")
            body = r"\begin{array}{%s}%s\end{array}" % (col, tex)
        # Per-term coloring (set_color_by_tex) only targets a term if it's its own
        # submobject, so isolate the colored substrings at construction. Otherwise
        # `set_color_by_tex('a', …)` matches the single whole-string submobject and
        # recolors the entire equation.
        color_map = props.get("color_map") or {}
        terms = [t for t in color_map if isinstance(t, str) and t.strip()]
        if terms:
            iso = ", ".join(repr(t) for t in terms)
            return f"{ctor}({body!r}, font_size={font_size}, substrings_to_isolate=[{iso}])"
        return f"{ctor}({body!r}, font_size={font_size})"

    if otype == "text":
        raw = str(props.get("text", ""))
        font_size = int(_num(props.get("font_size"), 48))
        # A `font` prop switches this object off the LaTeX path onto Manim's
        # Pango-backed `Text`, the only mobject that takes an arbitrary system
        # font. No escaping there (Pango draws the string literally) and
        # bold/italic become Pango weight/slant instead of \textbf/\textit.
        font = str(props.get("font") or "").strip()
        if font:
            extra = ""
            if props.get("bold"):
                extra += ', weight="BOLD"'
            if props.get("italic"):
                extra += ', slant="ITALIC"'
            # Pango breaks on a literal newline, so the raw string carries the
            # editor's line breaks through as-is.
            #
            # Always build at PANGO_REF_FONT_SIZE and scale to the authored size
            # rather than passing a small font_size straight through: Pango hints
            # and grid-fits glyph advances at the size it rasterizes, and below
            # ~24pt that quantization is a large fraction of an advance. The
            # errors don't cancel — adjacent letters land too far apart or
            # outright overlap (negative gaps), which reads as broken word
            # spacing ("pen d in g") once a zoomed-in camera magnifies it. A
            # textured face like Chalkduster is worst hit, but the wobble is
            # there for any font. Building at 48 puts Pango in its stable
            # metrics regime and the scale is exact, so the mobject's height —
            # and hence every object's vertical centering — is unchanged.
            body = f"Text({raw!r}, font={font!r}, font_size={PANGO_REF_FONT_SIZE}{extra})"
            k = font_size / float(PANGO_REF_FONT_SIZE)
            if abs(k - 1.0) > 1e-6:
                body = f"{body}.scale({round(k, 6)})"
            return body
        # Plain prose via Tex (LaTeX text mode). Escape LaTeX specials so the user
        # types literally; bold/italic wrap the escaped content.
        def _cell(s: str) -> str:
            b = _tex_escape(s)
            if props.get("italic"):
                b = r"\textit{" + b + "}"
            if props.get("bold"):
                b = r"\textbf{" + b + "}"
            return b

        lines = raw.split("\n")
        if len(lines) > 1:
            # LaTeX collapses a raw newline to a space, so the editor's line breaks
            # become tabular rows. `{l}` matches the left alignment the Pango path
            # gives for free, and LaTeX's built-in row strut keeps the leading even
            # — including blank lines, which stay blank rows. Single-line content
            # keeps the bare form: wrapping it would change its bbox, and with it
            # the vertical centering of every existing text object.
            body = r"\begin{tabular}{l}" + r" \\ ".join(_cell(l) for l in lines) + r"\end{tabular}"
        else:
            body = _cell(raw)
        return f"Tex({body!r}, font_size={font_size})"

    if otype == "shape":
        subtype = props.get("subtype", "rectangle")
        if subtype == "rectangle":
            w = _num(props.get("width"), 2.0)
            h = _num(props.get("height"), 1.0)
            # Optional rounded corners. Manim happily accepts a radius larger than
            # half the shorter side and emits self-intersecting arcs, so clamp
            # (the canvas preview clamps identically).
            cr = _num(props.get("corner_radius"), 0.0)
            if cr > 0:
                cr = min(cr, min(abs(w), abs(h)) / 2)
                return f"RoundedRectangle(corner_radius={cr}, width={w}, height={h})"
            return f"Rectangle(width={w}, height={h})"
        if subtype == "circle":
            return f"Circle(radius={_num(props.get('radius'), 1.0)})"
        if subtype == "ellipse":
            return f"Ellipse(width={_num(props.get('width'), 2.0)}, height={_num(props.get('height'), 1.0)})"
        if subtype == "line":
            return f"Line(start={_np(props.get('start_point'))}, end={_np(props.get('end_point'))})"
        if subtype == "arrow":
            tl = props.get("tip_length")
            extra = f", tip_length={_num(tl, 0.25)}" if tl is not None else ""
            return f"Arrow(start={_np(props.get('start_point'))}, end={_np(props.get('end_point'))}, buff=0{extra})"
        if subtype == "double_arrow":
            return f"DoubleArrow(start={_np(props.get('start_point'))}, end={_np(props.get('end_point'))}, buff=0)"
        if subtype == "dashed_line":
            dl = _num(props.get("dash_length"), 0.15)
            dr = _num(props.get("dashed_ratio"), 0.5)
            return f"DashedLine(start={_np(props.get('start_point'))}, end={_np(props.get('end_point'))}, dash_length={dl}, dashed_ratio={dr})"
        if subtype == "polygon":
            verts = props.get("vertices") or []
            if len(verts) >= 3:
                pts = ", ".join(_np(v) for v in verts)
                return f"Polygon({pts})"
            return "Triangle()"

    if otype == "coordinate_system":
        subtype = props.get("subtype", "axes")
        if subtype == "axes":
            xr = _range(props.get("x_range"), [-5, 5, 1])
            yr = _range(props.get("y_range"), [-3, 3, 1])
            xl = _num(props.get("x_length"), 6.0)
            yl = _num(props.get("y_length"), 4.0)
            inc = bool(props.get("include_numbers", True))
            # No arrow tips by default (matches the canvas preview); opt in via props.
            tips = bool(props.get("tips", False))
            axis_cfg = f"'include_numbers': {inc}"
            if props.get("number_font_size") is not None:
                axis_cfg += f", 'font_size': {_num(props.get('number_font_size'), 36)}"
            return (f"Axes(x_range={xr}, y_range={yr}, x_length={xl}, y_length={yl}, "
                    f"tips={tips}, axis_config={{{axis_cfg}}})")
        if subtype == "number_line":
            xr = _range(props.get("x_range"), [-5, 5, 1])
            length = _num(props.get("length"), 8.0)
            inc = bool(props.get("include_numbers", True))
            fs = ""
            if props.get("number_font_size") is not None:
                fs = f", font_size={_num(props.get('number_font_size'), 36)}"
            return f"NumberLine(x_range={xr}, length={length}, include_numbers={inc}{fs})"
        if subtype == "number_plane":
            xr = _range(props.get("x_range"), [-5, 5, 1])
            yr = _range(props.get("y_range"), [-3, 3, 1])
            xl = _num(props.get("x_length"), 8.0)
            yl = _num(props.get("y_length"), 5.0)
            return f"NumberPlane(x_range={xr}, y_range={yr}, x_length={xl}, y_length={yl})"

    if otype == "graph":
        subtype = props.get("subtype", "function_plot")
        axes_ref = props.get("axes_ref")
        if subtype in AXES_BOUND_GRAPHS and not axes_ref:
            raise ValueError(f"Graph ({subtype}) requires axes_ref")
        axes_var = var_name(axes_ref) if axes_ref else ""
        if subtype == "function_plot":
            expr = _expr(props.get("expression"), "0")
            xr = props.get("x_range")
            xr_str = f", x_range={_range(xr, [-5, 5])}" if isinstance(xr, (list, tuple)) and len(xr) >= 2 else ""
            # expression is Python/numpy; sin/cos/etc are imported in the template.
            return f"{axes_var}.plot(lambda x: ({expr}){xr_str})"
        if subtype == "parametric":
            fx = _expr(props.get("x_expression"), "cos(t)")
            fy = _expr(props.get("y_expression"), "sin(t)")
            tr = _range(props.get("t_range"), [0, 6.2832, 0.05])
            return f"{axes_var}.plot_parametric_curve(lambda t: np.array([({fx}), ({fy}), 0.0]), t_range={tr})"
        if subtype == "implicit":
            expr = _expr(props.get("expression"), "x**2 + y**2 - 4")
            return f"{axes_var}.plot_implicit_curve(lambda x, y: ({expr}))"
        if subtype == "vector_field":
            xf = _expr(props.get("x_func"), "-y")
            yf = _expr(props.get("y_func"), "x")
            xr = _range(props.get("x_range"), [-5, 5, 1])
            yr = _range(props.get("y_range"), [-3, 3, 1])
            return ("ArrowVectorField(lambda p: np.array(["
                    f"(lambda x, y: ({xf}))(p[0], p[1]), (lambda x, y: ({yf}))(p[0], p[1]), 0.0]), "
                    f"x_range={xr}, y_range={yr})")

    if otype == "geometry":
        subtype = props.get("subtype", "vector")
        label = props.get("label")
        if subtype == "vector":
            dx, dy = _point(props.get("direction"))
            base = f"Vector(np.array([{dx}, {dy}, 0.0]))"
            if isinstance(label, str) and label.strip():
                return f"VGroup((_v := {base}), MathTex({label!r}).next_to(_v.get_end(), UR, buff=0.15))"
            return base
        if subtype == "angle":
            l1 = var_name(props["line1_id"]) if props.get("line1_id") else "Line(LEFT, RIGHT)"
            l2 = var_name(props["line2_id"]) if props.get("line2_id") else "Line(DOWN, UP)"
            r = _num(props.get("radius"), 0.5)
            return f"Angle({l1}, {l2}, radius={r})"
        if subtype == "brace":
            tgt = var_name(props["target_id"]) if props.get("target_id") else "Dot()"
            direction = _DIR_CONST.get(str(props.get("direction_str", "DOWN")).upper(), "DOWN")
            if isinstance(label, str) and label.strip():
                return f"VGroup((_b := Brace({tgt}, direction={direction})), _b.get_text({label!r}))"
            return f"Brace({tgt}, direction={direction})"

    if otype == "matrix":
        entries = props.get("entries") or [["a", "b"], ["c", "d"]]
        rows = ", ".join("[" + ", ".join(repr(str(c)) for c in row) + "]" for row in entries)
        lb = props.get("left_bracket", "[")
        rb = props.get("right_bracket", "]")
        base = f"Matrix([{rows}], left_bracket={lb!r}, right_bracket={rb!r})"
        # Matrix has no font_size arg; scale the whole mobject by font_size/48 so
        # glyphs, spacing and brackets grow together (mirrors the canvas preview).
        k = _num(props.get("font_size"), 48) / 48.0
        if abs(k - 1.0) > 1e-6:
            base = f"{base}.scale({round(k, 6)})"
        return base

    return "Dot()"


# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------

def _emit_styling(var: str, obj: SceneObject) -> list[str]:
    otype = _otype(obj)
    s = obj.style
    fc, fo = s.fill_color, s.fill_opacity
    sc, sw, so = s.stroke_color, s.stroke_width, s.stroke_opacity
    lines: list[str] = []

    if otype == "image":
        # Raster pixels — stroke/fill styling doesn't apply. Opacity is a prop
        # (emitted with the sizing in emit_object).
        return lines

    if otype in ("latex_text", "text", "matrix"):
        color = fc or sc
        if color:
            lines.append(f"{var}.set_color({color!r})")
        if otype == "latex_text":
            color_map = (obj.props or {}).get("color_map") or {}
            for sub, col in color_map.items():
                if sub and col:
                    lines.append(f"{var}.set_color_by_tex({sub!r}, {col!r})")
        return lines

    if otype in ("coordinate_system", "graph"):
        # ArrowVectorField colors itself by vector magnitude; don't override it.
        if otype == "graph" and (obj.props or {}).get("subtype") == "vector_field":
            return lines
        color = sc or fc
        if color:
            lines.append(f"{var}.set_color({color!r})")
        if sw is not None:
            lines.append(f"{var}.set_stroke(width={float(sw)})")
        return lines

    if otype == "geometry":
        color = sc or fc
        if color:
            lines.append(f"{var}.set_color({color!r})")
        return lines

    subtype = (obj.props or {}).get("subtype")
    if otype == "shape" and subtype in LINE_LIKE:
        color = sc or fc
        if color:
            lines.append(f"{var}.set_color({color!r})")
        parts = []
        if sw is not None:
            parts.append(f"width={float(sw)}")
        if so is not None:
            parts.append(f"opacity={float(so)}")
        if parts:
            lines.append(f"{var}.set_stroke({', '.join(parts)})")
        return lines

    # generic closed shapes (rectangle/circle/ellipse/polygon)
    if sc is not None or sw is not None or so is not None:
        parts = []
        if sc is not None:
            parts.append(f"color={sc!r}")
        if sw is not None:
            parts.append(f"width={float(sw)}")
        if so is not None:
            parts.append(f"opacity={float(so)}")
        lines.append(f"{var}.set_stroke({', '.join(parts)})")
    if fc is not None or fo is not None:
        parts = []
        if fc is not None:
            parts.append(f"color={fc!r}")
        parts.append(f"opacity={float(fo) if fo is not None else 1.0}")
        lines.append(f"{var}.set_fill({', '.join(parts)})")
    return lines


# ---------------------------------------------------------------------------
# Object -> source lines
# ---------------------------------------------------------------------------

def emit_object(obj: SceneObject, assets_root: str | None = None) -> tuple[str, list[str]]:
    var = var_name(obj.id)
    otype = _otype(obj)
    props = obj.props or {}
    subtype = props.get("subtype")

    # A function plot with a parameter sweep becomes a ValueTracker + always_redraw
    # so the curve re-draws as the parameter animates (the play is emitted by the
    # scene builder). The swept parameter name is exposed as a variable in the
    # plotting lambda, bound to the tracker's current value each frame.
    sweep = _sweep(obj) if otype == "graph" and subtype == "function_plot" else None
    if sweep:
        axes_ref = props.get("axes_ref")
        if not axes_ref:
            raise ValueError("Swept function plot requires axes_ref")
        axes_var = var_name(axes_ref)
        param = re.sub(r"[^0-9a-zA-Z_]", "", str(sweep.get("param", "a"))) or "a"
        if param == "x":
            raise ValueError("Sweep parameter cannot be named 'x' (conflicts with the plot variable)")
        expr = _expr(props.get("expression"), "0")
        xr = props.get("x_range")
        xr_str = f", x_range={_range(xr, [-5, 5])}" if isinstance(xr, (list, tuple)) and len(xr) >= 2 else ""
        start_val = _num(sweep.get("from"), 0.0)
        tvar = tracker_name(obj.id)
        lines = [
            f"{tvar} = ValueTracker({start_val})",
            f"{var} = always_redraw(lambda: {axes_var}.plot("
            f"lambda x, {param}={tvar}.get_value(): ({expr}){xr_str}))",
        ]
        lines.extend(_emit_styling(var, obj))
        if obj.z_index:
            lines.append(f"{var}.set_z_index({int(obj.z_index)})")
        return var, lines

    lines: list[str] = [f"{var} = {_emit_construct(obj, assets_root)}"]
    lines.extend(_emit_styling(var, obj))

    # Image sizing: both dims are stored (stretch_to_fit keeps them independent,
    # so a non-uniform stretch from the editor is reproduced exactly).
    if otype == "image":
        lines.append(f"{var}.stretch_to_fit_width({_num(props.get('width'), 4.0)})")
        lines.append(f"{var}.stretch_to_fit_height({_num(props.get('height'), 3.0)})")
        op = _num(props.get("opacity"), 1.0)
        if op < 1.0:
            lines.append(f"{var}.set_opacity({max(0.0, op)})")

    # Axis labels on a coordinate system, added so they move with the axes.
    if otype == "coordinate_system":
        xl, yl = props.get("x_axis_label"), props.get("y_axis_label")
        if (isinstance(xl, str) and xl.strip()) or (isinstance(yl, str) and yl.strip()):
            xa = f"MathTex({xl!r})" if isinstance(xl, str) and xl.strip() else "MathTex('x')"
            ya = f"MathTex({yl!r})" if isinstance(yl, str) and yl.strip() else "MathTex('y')"
            lines.append(f"{var}.add({var}.get_axis_labels({xa}, {ya}))")

    x, y = _point(obj.position)
    if otype == "graph":
        if subtype == "vector_field" and (abs(x) > 1e-9 or abs(y) > 1e-9):
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]))")
        # other graph types follow their axes; no independent placement
    elif otype == "geometry":
        # Vector starts at the origin; shift it to its position. Angle/Brace are
        # anchored to the objects they reference, so leave them where they land.
        if subtype == "vector" and (abs(x) > 1e-9 or abs(y) > 1e-9):
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]))")
    elif otype == "shape" and subtype in POINT_SHAPES:
        if abs(x) > 1e-9 or abs(y) > 1e-9:
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]))")
    elif otype == "coordinate_system":
        # The canvas centers the axis-line region (data midpoint) at `position`.
        # move_to() would instead center Manim's full bbox (tips/numbers/labels
        # included), shifting the axes; align the data midpoint via c2p instead.
        props = obj.props or {}
        st = props.get("subtype", "axes")
        if st == "number_line":
            xr = props.get("x_range") or [-5, 5, 1]
            xmid = (_num(xr[0], -5) + _num(xr[1], 5)) / 2
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]) - {var}.number_to_point({xmid}))")
        elif st in ("axes", "number_plane"):
            xr = props.get("x_range") or [-5, 5, 1]
            yr = props.get("y_range") or [-3, 3, 1]
            xmid = (_num(xr[0], -5) + _num(xr[1], 5)) / 2
            ymid = (_num(yr[0], -3) + _num(yr[1], 3)) / 2
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]) - {var}.c2p({xmid}, {ymid}))")
        else:
            lines.append(f"{var}.move_to(np.array([{x}, {y}, 0.0]))")
    else:
        lines.append(f"{var}.move_to(np.array([{x}, {y}, 0.0]))")

    # Baked rotation (center-based, Manim CCW degrees). Point-based shapes bake
    # rotation into their own points instead, so they never carry this prop;
    # graphs follow their axes and are never rotated independently.
    rot = _num(props.get("rotation"), 0.0)
    if abs(rot) > 1e-9 and otype != "graph":
        lines.append(f"{var}.rotate({rot} * DEGREES)")

    if obj.z_index:
        lines.append(f"{var}.set_z_index({int(obj.z_index)})")

    return var, lines
