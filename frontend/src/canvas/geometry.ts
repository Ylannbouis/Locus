// Shared geometry math for the canvas (SceneNodes) and the KaTeX overlay
// (LatexOverlay), so a brace/vector and its label stay in sync. All values are
// in Manim units unless noted.
import type { SceneObject } from '../types/ir';

export const LINE_SUBTYPES = ['line', 'arrow', 'dashed_line', 'double_arrow'];

// Brace geometry (units): gap from target, depth of the curly, and label offset.
export const BRACE_BUFF = 0.12;
export const BRACE_DEPTH = 0.3;
const LABEL_GAP = 0.24;
const VEC_LABEL_OFFSET = 0.18;

export interface Bounds { cx: number; cy: number; hw: number; hh: number; }

// Approximate bounding box of an object in Manim units.
export function objectBounds(o: SceneObject): Bounds {
  const p = o.props as any;
  const pos = o.position;
  if (o.type === 'shape') {
    if (p.subtype === 'circle') { const r = Number(p.radius ?? 1); return { cx: pos.x, cy: pos.y, hw: r, hh: r }; }
    if (p.subtype === 'rectangle' || p.subtype === 'ellipse') return { cx: pos.x, cy: pos.y, hw: Number(p.width ?? 2) / 2, hh: Number(p.height ?? 1.2) / 2 };
    if (p.subtype === 'polygon') {
      const vs = (p.vertices ?? []) as { x: number; y: number }[];
      const xs = vs.map(v => v.x), ys = vs.map(v => v.y);
      const x0 = Math.min(...xs, 0), x1 = Math.max(...xs, 0), y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0);
      return { cx: pos.x + (x0 + x1) / 2, cy: pos.y + (y0 + y1) / 2, hw: (x1 - x0) / 2 || 0.5, hh: (y1 - y0) / 2 || 0.5 };
    }
    const sx = p.start_point?.x ?? 0, ex = p.end_point?.x ?? 0, sy = p.start_point?.y ?? 0, ey = p.end_point?.y ?? 0;
    return { cx: pos.x + (sx + ex) / 2, cy: pos.y + (sy + ey) / 2, hw: Math.abs(ex - sx) / 2 || 0.4, hh: Math.abs(ey - sy) / 2 || 0.4 };
  }
  if (o.type === 'latex_text' || o.type === 'matrix') {
    const fs = Number(p.font_size ?? 48) / 48;
    const len = o.type === 'matrix' ? 1.6 : Math.max(1, String(p.tex_string ?? '').length * 0.28);
    return { cx: pos.x, cy: pos.y, hw: (len * fs) / 2, hh: 0.35 * fs };
  }
  if (o.type === 'coordinate_system') return { cx: pos.x, cy: pos.y, hw: Number(p.x_length ?? 6) / 2, hh: Number(p.y_length ?? 4) / 2 };
  if (o.type === 'image') return { cx: pos.x, cy: pos.y, hw: Number(p.width ?? 4) / 2, hh: Number(p.height ?? 3) / 2 };
  return { cx: pos.x, cy: pos.y, hw: 0.5, hh: 0.5 };
}

// Manim-units line segment of a line-like shape, or null.
export function lineSegment(o: SceneObject | undefined): [[number, number], [number, number]] | null {
  if (!o || o.type !== 'shape') return null;
  const p = o.props as any;
  if (!LINE_SUBTYPES.includes(p.subtype)) return null;
  const s = p.start_point ?? { x: 0, y: 0 }, e = p.end_point ?? { x: 0, y: 0 };
  return [[o.position.x + s.x, o.position.y + s.y], [o.position.x + e.x, o.position.y + e.y]];
}

// Intersection of two infinite lines (each two points), or null if parallel.
export function intersect(a: [[number, number], [number, number]], b: [[number, number], [number, number]]): [number, number] | null {
  const [[x1, y1], [x2, y2]] = a, [[x3, y3], [x4, y4]] = b;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

// Anchor point (Manim units) for a brace's label, just past the brace tip.
export function braceLabelPoint(b: Bounds, dir: string): { x: number; y: number } {
  const out = BRACE_BUFF + BRACE_DEPTH + LABEL_GAP;
  switch (dir.toUpperCase()) {
    case 'UP': return { x: b.cx, y: b.cy + b.hh + out };
    case 'LEFT': return { x: b.cx - b.hw - out, y: b.cy };
    case 'RIGHT': return { x: b.cx + b.hw + out, y: b.cy };
    default: return { x: b.cx, y: b.cy - b.hh - out }; // DOWN
  }
}

// Anchor point (Manim units) for a vector's label, just past its tip.
export function vectorLabelPoint(o: SceneObject): { x: number; y: number } {
  const d = (o.props as any).direction ?? { x: 1, y: 0 };
  return { x: o.position.x + d.x + VEC_LABEL_OFFSET, y: o.position.y + d.y + VEC_LABEL_OFFSET };
}
