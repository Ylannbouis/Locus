import { Rect, Circle as KCircle, Ellipse, Line, Arrow, Group, Path, Text } from 'react-konva';
import type Konva from 'konva';
import type { Point2D, SceneObject } from '../types/ir';
import { PX_PER_UNIT, MANIM_EM_UNITS_PER_PT, SNAP_PX, worldX, worldY, manimX, manimY } from './coords';
import { samplePlot, sampleParametric, sampleVectorField, vectorFieldColor } from './plotting';
import { objectBounds, lineSegment, intersect, BRACE_BUFF, BRACE_DEPTH } from './geometry';
import { useCanvasStore } from '../store/canvasStore';
import { useProjectStore } from '../store/projectStore';

// Snap a node's drag onto the horizontal/vertical center lines when it lands
// within SNAP_PX of them. dragBoundFunc works in absolute (screen) pixels, and
// the Manim origin sits at the stage's own (x, y), so snapping each axis to the
// stage position pulls the object's drag reference onto that center line.
// Skipped while several objects are selected (a group move shouldn't snap on one
// member's edge, which would shift the whole group unexpectedly).
function snapDragBound(this: Konva.Node, pos: { x: number; y: number }) {
  if (!useCanvasStore.getState().snapToCenter) return pos;
  if (useProjectStore.getState().selectedObjectIds.length > 1) return pos;
  const stage = this.getStage();
  if (!stage) return pos;
  const cx = stage.x(), cy = stage.y();
  return {
    x: Math.abs(pos.x - cx) <= SNAP_PX ? cx : pos.x,
    y: Math.abs(pos.y - cy) <= SNAP_PX ? cy : pos.y,
  };
}

// Build an SVG path for a brace along a baseline (world px). axis 'h' or 'v';
// `sign` is the direction the tip points (away from the target).
function bracePath(a0: number, a1: number, base: number, depth: number, axis: 'h' | 'v', sign: number): string {
  const mid = (a0 + a1) / 2;
  const m = base + sign * depth * 0.5;
  const tip = base + sign * depth;
  if (axis === 'h') {
    return `M ${a0} ${base} Q ${a0} ${m} ${(a0 + mid) / 2} ${m} Q ${mid} ${m} ${mid} ${tip} Q ${mid} ${m} ${(mid + a1) / 2} ${m} Q ${a1} ${m} ${a1} ${base}`;
  }
  return `M ${base} ${a0} Q ${m} ${a0} ${m} ${(a0 + mid) / 2} Q ${m} ${mid} ${tip} ${mid} Q ${m} ${mid} ${m} ${(mid + a1) / 2} Q ${m} ${a1} ${base} ${a1}`;
}

function hexToRgba(hex: string | null | undefined, alpha: number): string {
  if (!hex) return 'rgba(0,0,0,0)';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex || 'rgba(0,0,0,0)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

interface Props {
  objects: SceneObject[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
  onCommitDrag: (o: SceneObject, node: Konva.Node) => void;
  // Objects being edited via a move/scale/rotate keyframe preview must not steal
  // pointer events from the destination drag handle.
  nonInteractiveIds?: string[];
  // Current view scale, so on-canvas handles keep a constant screen size.
  viewScale?: number;
  // Live override + callbacks for dragging a selected line-like shape's endpoints.
  endpointDrag?: { id: string; which: 'start' | 'end'; point: Point2D } | null;
  onEndpointDrag?: (id: string, which: 'start' | 'end', point: Point2D) => void;
  onEndpointCommit?: (id: string, which: 'start' | 'end', point: Point2D) => void;
  // Live multi-select drag: while `anchorId` is being dragged, every *other*
  // selected object renders offset by (dx, dy) so the whole set moves together.
  groupDrag?: { anchorId: string; dx: number; dy: number } | null;
  onNodeDragMove?: (o: SceneObject, node: Konva.Node) => void;
}

const PXU = PX_PER_UNIT;
// Extra clickable padding (world px) around thin/open shapes so lines, arrows
// and curves are easy to grab even where they're only a couple of pixels wide.
const HIT = 16;

function rng(v: unknown, fb: number[]): number[] {
  return Array.isArray(v) && v.length >= 2 ? (v as number[]) : fb;
}

// Format a tick value for display: trim floating-point fuzz and drop the
// decimal point entirely for whole numbers (so 2 shows as "2", not "2.0").
function fmtNum(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  if (Object.is(r, -0)) return '0';
  return String(r);
}

// Manim number font_size (points) -> world px, using the same em calibration
// as the KaTeX overlay so preview sizes track the render roughly.
function numberPx(fs: number): number {
  return fs * MANIM_EM_UNITS_PER_PT * PX_PER_UNIT;
}

// Tick values from min..max, guarding against non-positive steps (infinite
// loops) and absurdly dense ranges (capped at 500 lines for the preview).
function safeTicks(min: number, max: number, step: number): number[] {
  const s = Math.abs(step) || 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const out: number[] = [];
  let v = Math.ceil(min);
  let guard = 0;
  while (v <= max && guard < 500) { out.push(v); v += s; guard++; }
  return out;
}

// Local-space child lines for a coordinate system (group sits at its center).
function coordChildren(o: SceneObject, stroke: string, sw: number) {
  const p = o.props as any;
  const st = p.subtype;
  const els: React.ReactNode[] = [];
  const faint = hexToRgba(o.style.stroke_color, 0.25);
  const showNums = !!p.include_numbers;
  const fs = numberPx(Number(p.number_font_size ?? 36));

  if (st === 'number_line') {
    const len = Number(p.length ?? 8) * PXU;
    els.push(<Line key="axis" points={[-len / 2, 0, len / 2, 0]} stroke={stroke} strokeWidth={sw} />);
    const [xmin, xmax, xstep = 1] = rng(p.x_range, [-5, 5, 1]);
    const span = (xmax - xmin) || 1;
    for (const x of safeTicks(xmin, xmax, xstep)) {
      const px = ((x - (xmin + xmax) / 2) / span) * len;
      els.push(<Line key={`t${x}`} points={[px, -6, px, 6]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(x);
        els.push(<Text key={`n${x}`} text={label} x={px} y={10} fontSize={fs} fill={stroke}
          offsetX={(label.length * fs * 0.55) / 2} />);
      }
    }
    return els;
  }

  const xLen = Number(p.x_length ?? 6) * PXU;
  const yLen = Number(p.y_length ?? 4) * PXU;
  const [xmin, xmax, xstep = 1] = rng(p.x_range, [-5, 5, 1]);
  const [ymin, ymax, ystep = 1] = rng(p.y_range, [-3, 3, 1]);
  const xmid = (xmin + xmax) / 2, ymid = (ymin + ymax) / 2;
  const xSpan = (xmax - xmin) || 1, ySpan = (ymax - ymin) || 1;
  const dataXpx = (x: number) => ((x - xmid) / xSpan) * xLen;
  const dataYpx = (y: number) => -((y - ymid) / ySpan) * yLen; // world flip
  const axisYpx = dataYpx(0);
  const axisXpx = dataXpx(0);

  if (st === 'number_plane') {
    for (const x of safeTicks(xmin, xmax, xstep)) {
      const px = dataXpx(x);
      els.push(<Line key={`gx${x}`} points={[px, -yLen / 2, px, yLen / 2]} stroke={faint} strokeWidth={1} />);
    }
    for (const y of safeTicks(ymin, ymax, ystep)) {
      const py = dataYpx(y);
      els.push(<Line key={`gy${y}`} points={[-xLen / 2, py, xLen / 2, py]} stroke={faint} strokeWidth={1} />);
    }
  }

  // axes lines (with optional arrow tips at the positive ends, matching Manim)
  const tips = st === 'axes' && !!p.tips;
  if (tips) {
    const tip = 0.18 * PXU;
    els.push(<Arrow key="xaxis" points={[-xLen / 2, axisYpx, xLen / 2, axisYpx]} stroke={stroke} fill={stroke} strokeWidth={sw} pointerLength={tip} pointerWidth={tip} />);
    els.push(<Arrow key="yaxis" points={[axisXpx, yLen / 2, axisXpx, -yLen / 2]} stroke={stroke} fill={stroke} strokeWidth={sw} pointerLength={tip} pointerWidth={tip} />);
  } else {
    els.push(<Line key="xaxis" points={[-xLen / 2, axisYpx, xLen / 2, axisYpx]} stroke={stroke} strokeWidth={sw} />);
    els.push(<Line key="yaxis" points={[axisXpx, -yLen / 2, axisXpx, yLen / 2]} stroke={stroke} strokeWidth={sw} />);
  }

  if (st === 'axes') {
    for (const x of safeTicks(xmin, xmax, xstep)) {
      if (Math.abs(x) < 1e-9) continue;
      const px = dataXpx(x);
      els.push(<Line key={`tx${x}`} points={[px, axisYpx - 5, px, axisYpx + 5]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(x);
        els.push(<Text key={`nx${x}`} text={label} x={px} y={axisYpx + 8} fontSize={fs} fill={stroke}
          offsetX={(label.length * fs * 0.55) / 2} />);
      }
    }
    for (const y of safeTicks(ymin, ymax, ystep)) {
      if (Math.abs(y) < 1e-9) continue;
      const py = dataYpx(y);
      els.push(<Line key={`ty${y}`} points={[axisXpx - 5, py, axisXpx + 5, py]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(y);
        els.push(<Text key={`ny${y}`} text={label} x={axisXpx - 8} y={py} fontSize={fs} fill={stroke}
          offsetX={label.length * fs * 0.55} offsetY={fs / 2} />);
      }
    }
  }
  return els;
}

export function SceneNodes({ objects, selectedIds, onSelect, onCommitDrag, nonInteractiveIds = [], viewScale = 1, endpointDrag = null, onEndpointDrag, onEndpointCommit, groupDrag = null, onNodeDragMove }: Props) {
  const frozen = new Set(nonInteractiveIds);

  const renderNode = (o: SceneObject): React.ReactNode => {
    if (!o.visible) return null;
    if (o.type === 'latex_text' || o.type === 'matrix') return null; // handled by overlay

    const isSel = selectedIds.includes(o.id);
    const isFrozen = frozen.has(o.id);
    const stroke = hexToRgba(o.style.stroke_color, o.style.stroke_opacity ?? 1);
    const strokeWidth = Number(o.style.stroke_width ?? 2);
    const fill = hexToRgba(o.style.fill_color, o.style.fill_opacity ?? 0);
    const sel = isSel ? { shadowColor: '#2563eb', shadowBlur: 10, shadowOpacity: 1 } : {};
    // During a multi-select drag, follow the anchor: offset every *other* selected
    // object by the live delta. The anchor keeps its stored position (Konva drives
    // it), so its `x`/`y` props don't change mid-drag and Konva doesn't reset it.
    const follow = groupDrag && groupDrag.anchorId !== o.id && isSel;
    const px = o.position.x + (follow ? groupDrag!.dx : 0);
    const py = o.position.y + (follow ? groupDrag!.dy : 0);
    const pos = { x: worldX(px), y: worldY(py) };
    // Show the move cursor over any selectable object (matches the equations).
    const hover = isFrozen ? {} : {
      onMouseEnter: (e: Konva.KonvaEventObject<MouseEvent>) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'move'; },
      onMouseLeave: (e: Konva.KonvaEventObject<MouseEvent>) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'default'; },
    };
    const drag = isFrozen ? { draggable: false, listening: false } : {
      draggable: true,
      dragBoundFunc: snapDragBound,
      ...hover,
      onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; },
      onClick: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); },
      onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => { if (!isSel) onSelect(o.id, false); void e; },
      onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onNodeDragMove?.(o, e.target),
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onCommitDrag(o, e.target),
    };
    const common = { key: o.id, ...pos, ...drag, ...sel };
    const p = o.props as any;

    if (o.type === 'shape') {
      const st = p.subtype;
      // Baked rotation (Manim CCW degrees). Konva rotation is CW on screen (y-down),
      // so negate; rect/ellipse pivot about their center (origin already centered).
      const rot = -(Number(p.rotation) || 0);
      if (st === 'circle') {
        return <KCircle {...common} radius={Number(p.radius ?? 1) * PXU} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'ellipse') {
        return <Ellipse {...common} rotation={rot} radiusX={(Number(p.width ?? 2) / 2) * PXU} radiusY={(Number(p.height ?? 1.2) / 2) * PXU} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'polygon') {
        const pts = (p.vertices ?? []).flatMap((v: any) => [worldX(v.x), worldY(v.y)]);
        return <Line {...common} points={pts} closed fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'line' || st === 'dashed_line' || st === 'arrow' || st === 'double_arrow') {
        // Line-likes render as a group at `position` so draggable endpoint handles
        // can share the translation (no lag when the whole shape moves). While an
        // endpoint is dragged, `endpointDrag` overrides it so the shape follows live.
        const arrowLike = st === 'arrow' || st === 'double_arrow';
        const live = (w: 'start' | 'end') =>
          endpointDrag && endpointDrag.id === o.id && endpointDrag.which === w ? endpointDrag.point : null;
        const startP = live('start') ?? (p.start_point ?? { x: 0, y: 0 });
        const endP = live('end') ?? (p.end_point ?? { x: 0, y: 0 });
        const sx = worldX(startP.x), sy = worldY(startP.y), ex = worldX(endP.x), ey = worldY(endP.y);
        const tip = Number(p.tip_length ?? 0.3) * PXU;
        const d = Number(p.dash_length ?? 0.15) * PXU;
        const shapeNode = arrowLike
          ? <Arrow points={[sx, sy, ex, ey]} stroke={stroke} fill={stroke} strokeWidth={strokeWidth} hitStrokeWidth={HIT}
              pointerLength={tip} pointerWidth={tip * 0.9} pointerAtBeginning={st === 'double_arrow'} {...sel} />
          : <Line points={[sx, sy, ex, ey]} stroke={stroke} strokeWidth={strokeWidth} hitStrokeWidth={HIT}
              dash={st === 'dashed_line' ? [d, d] : undefined} {...sel} />;
        if (isFrozen) return <Group key={o.id} {...pos} listening={false}>{shapeNode}</Group>;
        const hr = 8 / viewScale;
        // A single arrow exposes only its tip (end); everything else exposes both ends.
        const ends: [('start' | 'end'), number, number][] = st === 'arrow'
          ? [['end', ex, ey]]
          : [['start', sx, sy], ['end', ex, ey]];
        // Endpoint handles only for a lone selection (avoid clutter / drag conflicts
        // when several objects are selected and moved together).
        const canEdit = isSel && selectedIds.length === 1 && onEndpointDrag && onEndpointCommit;
        return (
          <Group key={o.id} {...pos} {...drag}>
            {shapeNode}
            {canEdit && ends.map(([which, hx, hy]) => (
              <KCircle key={which} x={hx} y={hy} radius={hr} fill="#ea580c" stroke="#ffffff" strokeWidth={1.5 / viewScale}
                hitStrokeWidth={20 / viewScale} draggable
                onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}
                onDragStart={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; }}
                onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; onEndpointDrag!(o.id, which, { x: manimX(e.target.x()), y: manimY(e.target.y()) }); }}
                onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; onEndpointCommit!(o.id, which, { x: manimX(e.target.x()), y: manimY(e.target.y()) }); }}
                onMouseEnter={(e: Konva.KonvaEventObject<MouseEvent>) => { const s = e.target.getStage(); if (s) s.container().style.cursor = 'grab'; }}
                onMouseLeave={(e: Konva.KonvaEventObject<MouseEvent>) => { const s = e.target.getStage(); if (s) s.container().style.cursor = 'default'; }} />
            ))}
          </Group>
        );
      }
      // rectangle (default)
      const w = Number(p.width ?? 2) * PXU, h = Number(p.height ?? 1.2) * PXU;
      return <Rect {...common} rotation={rot} width={w} height={h} offsetX={w / 2} offsetY={h / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }

    if (o.type === 'coordinate_system') {
      return <Group {...common} rotation={-(Number(p.rotation) || 0)}>{coordChildren(o, stroke, strokeWidth)}</Group>;
    }

    if (o.type === 'graph') {
      const st = p.subtype ?? 'function_plot';
      const pick = isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); };

      if (st === 'vector_field') {
        const arrows = sampleVectorField(o);
        if (!arrows.length) return null;
        return (
          <Group key={o.id} listening={!isFrozen} onClick={pick} onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}>
            {arrows.map((a, i) => {
              const c = vectorFieldColor(a.mag); // matches Manim's [0,2] gradient
              return (
                <Arrow key={i} points={[worldX(a.x), worldY(a.y), worldX(a.x + a.dx), worldY(a.y + a.dy)]}
                  stroke={c} fill={c} strokeWidth={2} pointerLength={6} pointerWidth={5} listening={false} />
              );
            })}
          </Group>
        );
      }

      if (st === 'implicit') return null; // render-only (no canvas preview)

      const axes = objects.find(a => a.id === p.axes_ref && a.type === 'coordinate_system');
      if (!axes) return null;
      const pts = st === 'parametric'
        ? sampleParametric(axes, String(p.x_expression ?? 'cos(t)'), String(p.y_expression ?? 'sin(t)'), p.t_range)
        : samplePlot(axes, String(p.expression ?? ''), p.x_range);
      if (pts.length < 4) return null;
      return (
        <Line key={o.id} points={pts} stroke={stroke} strokeWidth={strokeWidth} lineJoin="round" lineCap="round"
          listening={!isFrozen} hitStrokeWidth={HIT}
          {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}
          onClick={pick} />
      );
    }

    if (o.type === 'geometry') {
      const pick = isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); };

      if (p.subtype === 'vector') {
        const dir = (p.direction as { x: number; y: number }) ?? { x: 1, y: 0 };
        const tip = 0.25 * PXU;
        return <Arrow {...common} points={[0, 0, worldX(dir.x), worldY(dir.y)]} stroke={stroke} fill={stroke}
          strokeWidth={strokeWidth} hitStrokeWidth={HIT} pointerLength={tip} pointerWidth={tip * 0.9} />;
      }

      if (p.subtype === 'angle') {
        const s1 = lineSegment(objects.find(a => a.id === p.line1_id));
        const s2 = lineSegment(objects.find(a => a.id === p.line2_id));
        if (!s1 || !s2) return null;
        const v = intersect(s1, s2);
        if (!v) return null;
        // direction along each line toward the endpoint farther from the vertex
        const far = (seg: [[number, number], [number, number]]) => {
          const d0 = Math.hypot(seg[0][0] - v[0], seg[0][1] - v[1]);
          const d1 = Math.hypot(seg[1][0] - v[0], seg[1][1] - v[1]);
          const pt = d1 >= d0 ? seg[1] : seg[0];
          return Math.atan2(pt[1] - v[1], pt[0] - v[0]);
        };
        let a1 = far(s1), a2 = far(s2);
        let delta = a2 - a1;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const R = Number(p.radius ?? 0.6);
        const pts: number[] = [];
        const N = 28;
        for (let i = 0; i <= N; i++) {
          const ang = a1 + (delta * i) / N;
          pts.push(worldX(v[0] + R * Math.cos(ang)), worldY(v[1] + R * Math.sin(ang)));
        }
        return <Line key={o.id} points={pts} stroke={stroke} strokeWidth={strokeWidth} listening={!isFrozen} hitStrokeWidth={HIT} {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
      }

      if (p.subtype === 'brace') {
        const target = objects.find(a => a.id === p.target_id);
        if (!target) return null;
        const b = objectBounds(target);
        const buff = BRACE_BUFF, depth = BRACE_DEPTH * PXU;
        const dir = String(p.direction_str ?? 'DOWN').toUpperCase();
        let d: string;
        if (dir === 'DOWN') d = bracePath(worldX(b.cx - b.hw), worldX(b.cx + b.hw), worldY(b.cy - b.hh - buff), depth, 'h', +1);
        else if (dir === 'UP') d = bracePath(worldX(b.cx - b.hw), worldX(b.cx + b.hw), worldY(b.cy + b.hh + buff), depth, 'h', -1);
        else if (dir === 'LEFT') d = bracePath(worldY(b.cy - b.hh), worldY(b.cy + b.hh), worldX(b.cx - b.hw - buff), depth, 'v', -1);
        else d = bracePath(worldY(b.cy - b.hh), worldY(b.cy + b.hh), worldX(b.cx + b.hw + buff), depth, 'v', +1);
        return <Path key={o.id} data={d} stroke={stroke} strokeWidth={2} listening={!isFrozen} hitStrokeWidth={HIT} {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
      }

      return null;
    }
    return null;
  };

  // Render in z-order so higher z draws on top.
  const ordered = [...objects].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  return <>{ordered.map(renderNode)}</>;
}
