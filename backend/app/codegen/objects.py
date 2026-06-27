"""Emit Manim Mobject construction code for each scene-model object type.

Supported (Phase 2):
  latex_text (MathTex/Tex, per-term coloring)
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
from typing import Any

from app.models.ir import SceneObject

POINT_SHAPES = {"line", "arrow", "double_arrow", "dashed_line", "polygon"}
# Open shapes with no meaningful fill — color them with set_color so that e.g.
# an Arrow's filled tip is recolored too (set_stroke alone leaves the tip white).
LINE_LIKE = {"line", "arrow", "double_arrow", "dashed_line"}


def var_name(obj_id: str) -> str:
    safe = re.sub(r"[^0-9a-zA-Z_]", "_", obj_id)
    return f"m_{safe}"


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


def _range(lst: Any, default: list[float]) -> str:
    if not isinstance(lst, (list, tuple)) or len(lst) < 2:
        lst = default
    vals = [_num(v, 0.0) for v in lst]
    # A non-positive step makes Manim's tick generation hang/raise — clamp it.
    if len(vals) >= 3 and vals[2] <= 0:
        vals[2] = 1.0
    return "[" + ", ".join(str(v) for v in vals) + "]"


def _otype(obj: SceneObject) -> str:
    return obj.type.value if hasattr(obj.type, "value") else str(obj.type)


# ---------------------------------------------------------------------------
# Constructor expression
# ---------------------------------------------------------------------------

def _emit_construct(obj: SceneObject) -> str:
    props = obj.props or {}
    otype = _otype(obj)

    if otype == "latex_text":
        tex = props.get("tex_string", "")
        font_size = int(_num(props.get("font_size"), 42))
        ctor = "MathTex" if props.get("use_mathtex", True) else "Tex"
        return f"{ctor}({tex!r}, font_size={font_size})"

    if otype == "shape":
        subtype = props.get("subtype", "rectangle")
        if subtype == "rectangle":
            return f"Rectangle(width={_num(props.get('width'), 2.0)}, height={_num(props.get('height'), 1.0)})"
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
            return (f"Axes(x_range={xr}, y_range={yr}, x_length={xl}, y_length={yl}, "
                    f"tips=True, axis_config={{'include_numbers': {inc}}})")
        if subtype == "number_line":
            xr = _range(props.get("x_range"), [-5, 5, 1])
            length = _num(props.get("length"), 8.0)
            inc = bool(props.get("include_numbers", True))
            return f"NumberLine(x_range={xr}, length={length}, include_numbers={inc})"
        if subtype == "number_plane":
            xr = _range(props.get("x_range"), [-5, 5, 1])
            yr = _range(props.get("y_range"), [-3, 3, 1])
            xl = _num(props.get("x_length"), 8.0)
            yl = _num(props.get("y_length"), 5.0)
            return f"NumberPlane(x_range={xr}, y_range={yr}, x_length={xl}, y_length={yl})"

    if otype == "graph":
        subtype = props.get("subtype", "function_plot")
        if subtype == "function_plot":
            axes_ref = props.get("axes_ref")
            raw_expr = props.get("expression")
            expr = raw_expr if isinstance(raw_expr, str) and raw_expr.strip() else "0"
            xr = props.get("x_range")
            axes_var = var_name(axes_ref) if axes_ref else "Axes()"
            xr_str = f", x_range={_range(xr, [-5, 5])}" if isinstance(xr, (list, tuple)) and len(xr) >= 2 else ""
            # expression is Python/numpy; sin/cos/etc are imported in the template.
            return f"{axes_var}.plot(lambda x: ({expr}){xr_str})"

    if otype == "matrix":
        entries = props.get("entries") or [["a", "b"], ["c", "d"]]
        rows = ", ".join("[" + ", ".join(repr(str(c)) for c in row) + "]" for row in entries)
        lb = props.get("left_bracket", "[")
        rb = props.get("right_bracket", "]")
        return f"Matrix([{rows}], left_bracket={lb!r}, right_bracket={rb!r})"

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

    if otype in ("latex_text", "matrix"):
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
        color = sc or fc
        if color:
            lines.append(f"{var}.set_color({color!r})")
        if sw is not None:
            lines.append(f"{var}.set_stroke(width={float(sw)})")
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

def emit_object(obj: SceneObject) -> tuple[str, list[str]]:
    var = var_name(obj.id)
    otype = _otype(obj)
    subtype = (obj.props or {}).get("subtype")
    lines: list[str] = [f"{var} = {_emit_construct(obj)}"]
    lines.extend(_emit_styling(var, obj))

    x, y = _point(obj.position)
    if otype == "graph":
        pass  # follows its axes; no independent placement
    elif otype == "shape" and subtype in POINT_SHAPES:
        if abs(x) > 1e-9 or abs(y) > 1e-9:
            lines.append(f"{var}.shift(np.array([{x}, {y}, 0.0]))")
    else:
        lines.append(f"{var}.move_to(np.array([{x}, {y}, 0.0]))")

    if obj.z_index:
        lines.append(f"{var}.set_z_index({int(obj.z_index)})")

    return var, lines
