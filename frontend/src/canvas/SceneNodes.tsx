import { Rect, Circle as KCircle, Ellipse, Line, Arrow, Group, Path } from 'react-konva';
import type Konva from 'konva';
import type { SceneObject } from '../types/ir';
import { PX_PER_UNIT, worldX, worldY } from './coords';
import { samplePlot, sampleParametric, sampleVectorField, vectorFieldColor } from './plotting';
import { objectBounds, lineSegment, intersect, BRACE_BUFF, BRACE_DEPTH } from './geometry';

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
}

const PXU = PX_PER_UNIT;

function rng(v: unknown, fb: number[]): number[] {
  return Array.isArray(v) && v.length >= 2 ? (v as number[]) : fb;
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

  if (st === 'number_line') {
    const len = Number(p.length ?? 8) * PXU;
    els.push(<Line key="axis" points={[-len / 2, 0, len / 2, 0]} stroke={stroke} strokeWidth={sw} />);
    const [xmin, xmax, xstep = 1] = rng(p.x_range, [-5, 5, 1]);
    const span = (xmax - xmin) || 1;
    for (const x of safeTicks(xmin, xmax, xstep)) {
      const px = ((x - (xmin + xmax) / 2) / span) * len;
      els.push(<Line key={`t${x}`} points={[px, -6, px, 6]} stroke={stroke} strokeWidth={sw} />);
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
    }
    for (const y of safeTicks(ymin, ymax, ystep)) {
      if (Math.abs(y) < 1e-9) continue;
      const py = dataYpx(y);
      els.push(<Line key={`ty${y}`} points={[axisXpx - 5, py, axisXpx + 5, py]} stroke={stroke} strokeWidth={sw} />);
    }
  }
  return els;
}

export function SceneNodes({ objects, selectedIds, onSelect, onCommitDrag }: Props) {
  const renderNode = (o: SceneObject): React.ReactNode => {
    if (!o.visible) return null;
    if (o.type === 'latex_text' || o.type === 'matrix') return null; // handled by overlay

    const isSel = selectedIds.includes(o.id);
    const stroke = hexToRgba(o.style.stroke_color, o.style.stroke_opacity ?? 1);
    const strokeWidth = Number(o.style.stroke_width ?? 2);
    const fill = hexToRgba(o.style.fill_color, o.style.fill_opacity ?? 0);
    const sel = isSel ? { shadowColor: '#2563eb', shadowBlur: 10, shadowOpacity: 1 } : {};
    const pos = { x: worldX(o.position.x), y: worldY(o.position.y) };
    const drag = {
      draggable: true,
      onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; },
      onClick: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); },
      onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => { if (!isSel) onSelect(o.id, false); void e; },
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onCommitDrag(o, e.target),
    };
    const common = { key: o.id, ...pos, ...drag, ...sel };
    const p = o.props as any;

    if (o.type === 'shape') {
      const st = p.subtype;
      if (st === 'circle') {
        return <KCircle {...common} radius={Number(p.radius ?? 1) * PXU} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'ellipse') {
        return <Ellipse {...common} radiusX={(Number(p.width ?? 2) / 2) * PXU} radiusY={(Number(p.height ?? 1.2) / 2) * PXU} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'polygon') {
        const pts = (p.vertices ?? []).flatMap((v: any) => [worldX(v.x), worldY(v.y)]);
        return <Line {...common} points={pts} closed fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
      }
      if (st === 'line' || st === 'dashed_line') {
        const pts = [worldX(p.start_point?.x ?? 0), worldY(p.start_point?.y ?? 0), worldX(p.end_point?.x ?? 0), worldY(p.end_point?.y ?? 0)];
        const d = Number(p.dash_length ?? 0.15) * PXU;
        return <Line {...common} points={pts} stroke={stroke} strokeWidth={strokeWidth} dash={st === 'dashed_line' ? [d, d] : undefined} />;
      }
      if (st === 'arrow' || st === 'double_arrow') {
        const pts = [worldX(p.start_point?.x ?? 0), worldY(p.start_point?.y ?? 0), worldX(p.end_point?.x ?? 0), worldY(p.end_point?.y ?? 0)];
        const tip = Number(p.tip_length ?? 0.3) * PXU;
        return <Arrow {...common} points={pts} stroke={stroke} fill={stroke} strokeWidth={strokeWidth}
          pointerLength={tip} pointerWidth={tip * 0.9} pointerAtBeginning={st === 'double_arrow'} />;
      }
      // rectangle (default)
      const w = Number(p.width ?? 2) * PXU, h = Number(p.height ?? 1.2) * PXU;
      return <Rect {...common} width={w} height={h} offsetX={w / 2} offsetY={h / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }

    if (o.type === 'coordinate_system') {
      return <Group {...common}>{coordChildren(o, stroke, strokeWidth)}</Group>;
    }

    if (o.type === 'graph') {
      const st = p.subtype ?? 'function_plot';
      const pick = (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); };

      if (st === 'vector_field') {
        const arrows = sampleVectorField(o);
        if (!arrows.length) return null;
        return (
          <Group key={o.id} onClick={pick} onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}>
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
          {...sel}
          onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}
          onClick={pick} />
      );
    }

    if (o.type === 'geometry') {
      const pick = (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey); };

      if (p.subtype === 'vector') {
        const dir = (p.direction as { x: number; y: number }) ?? { x: 1, y: 0 };
        const tip = 0.25 * PXU;
        return <Arrow {...common} points={[0, 0, worldX(dir.x), worldY(dir.y)]} stroke={stroke} fill={stroke}
          strokeWidth={strokeWidth} pointerLength={tip} pointerWidth={tip * 0.9} />;
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
        return <Line key={o.id} points={pts} stroke={stroke} strokeWidth={strokeWidth} {...sel}
          onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
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
        return <Path key={o.id} data={d} stroke={stroke} strokeWidth={2} {...sel}
          onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
      }

      return null;
    }
    return null;
  };

  // Render in z-order so higher z draws on top.
  const ordered = [...objects].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  return <>{ordered.map(renderNode)}</>;
}
