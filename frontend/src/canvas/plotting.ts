// Math helpers for rendering coordinate systems + function plots on the canvas.
// These mirror (approximately) how Manim's Axes maps data coords to the scene.

import type { SceneObject } from '../types/ir';
import { worldX, worldY } from './coords';

export interface AxesGeom {
  posX: number; posY: number;     // axes center (manim units)
  xmin: number; xmax: number;
  ymin: number; ymax: number;
  xLen: number; yLen: number;     // manim units
}

function rng(v: unknown, fb: [number, number]): [number, number] {
  if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
  return fb;
}

export function axesGeom(axes: SceneObject): AxesGeom {
  const p = axes.props as any;
  const [xmin, xmax] = rng(p.x_range, [-5, 5]);
  const [ymin, ymax] = rng(p.y_range, [-3, 3]);
  return {
    posX: axes.position.x,
    posY: axes.position.y,
    xmin, xmax, ymin, ymax,
    xLen: Number(p.x_length ?? 6),
    yLen: Number(p.y_length ?? 4),
  };
}

// data (dx,dy) -> manim units
export function dataToManim(g: AxesGeom, dx: number, dy: number): { x: number; y: number } {
  const xmid = (g.xmin + g.xmax) / 2;
  const ymid = (g.ymin + g.ymax) / 2;
  const xSpan = (g.xmax - g.xmin) || 1;
  const ySpan = (g.ymax - g.ymin) || 1;
  const lx = ((dx - xmid) / xSpan) * g.xLen;
  const ly = ((dy - ymid) / ySpan) * g.yLen;
  return { x: g.posX + lx, y: g.posY + ly };
}

// data -> world pixels (for Konva points)
export function dataToWorldPx(g: AxesGeom, dx: number, dy: number): [number, number] {
  const m = dataToManim(g, dx, dy);
  return [worldX(m.x), worldY(m.y)];
}

const MATH_PREAMBLE =
  'const sin=Math.sin,cos=Math.cos,tan=Math.tan,exp=Math.exp,' +
  'log=Math.log,sqrt=Math.sqrt,abs=Math.abs,pi=Math.PI,e=Math.E,' +
  'pow=Math.pow,floor=Math.floor,ceil=Math.ceil,sign=Math.sign,atan=Math.atan,' +
  'atan2=Math.atan2,sinh=Math.sinh,cosh=Math.cosh,tanh=Math.tanh;';

// Compile a Python/numpy-ish expression into a JS function of the given vars.
// `**` is translated to `Math.pow` via a simple exponent rewrite.
function makeFn(expr: string, params: string[]): ((...a: number[]) => number) | null {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...params, `${MATH_PREAMBLE} return (${expr.replace(/\*\*/g, '**')});`) as (...a: number[]) => number;
    fn(...params.map(() => 0)); // smoke test
    return fn;
  } catch {
    return null;
  }
}

// y = f(x)
export function compileExpr(expr: string): ((x: number) => number) | null {
  const fn = makeFn(expr, ['x']);
  return fn ? (x: number) => fn(x) : null;
}

// parametric component as a function of t
export function compileExprT(expr: string): ((t: number) => number) | null {
  const fn = makeFn(expr, ['t']);
  return fn ? (t: number) => fn(t) : null;
}

// two-variable field component f(x, y)
export function compileExpr2(expr: string): ((x: number, y: number) => number) | null {
  const fn = makeFn(expr, ['x', 'y']);
  return fn ? (x: number, y: number) => fn(x, y) : null;
}

// Sample a parametric curve (x(t), y(t)) → flat [x0,y0,...] world px points.
export function sampleParametric(axes: SceneObject, fx: string, fy: string, tRange?: number[]): number[] {
  const g = axesGeom(axes);
  const X = compileExprT(fx), Y = compileExprT(fy);
  if (!X || !Y) return [];
  const [t0, t1, step] = tRange && tRange.length >= 2 ? [tRange[0], tRange[1], tRange[2] ?? 0.05] : [0, 6.2832, 0.05];
  const n = Math.min(3000, Math.max(2, Math.ceil(Math.abs(t1 - t0) / (Math.abs(step) || 0.05))));
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    let dx: number, dy: number;
    try { dx = X(t); dy = Y(t); } catch { continue; }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const [px, py] = dataToWorldPx(g, dx, dy);
    pts.push(px, py);
  }
  return pts;
}

export interface FieldArrow { x: number; y: number; dx: number; dy: number; mag: number; }

// Manim ArrowVectorField default color scheme: a 4-stop gradient over a FIXED
// magnitude range [0, 2] (min/max_color_scheme_value), so the canvas matches
// the render regardless of the field's actual peak magnitude.
const VF_STOPS: [number, number, number][] = [
  [0x23, 0x6B, 0x8E], // BLUE_E
  [0x83, 0xC1, 0x67], // GREEN
  [0xF7, 0xD9, 0x6F], // YELLOW
  [0xFC, 0x62, 0x55], // RED
];

export function vectorFieldColor(mag: number): string {
  const t = Math.max(0, Math.min(1, mag / 2)); // normalize to [0, 2]
  const seg = t * (VF_STOPS.length - 1);
  const i = Math.min(VF_STOPS.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = VF_STOPS[i], b = VF_STOPS[i + 1];
  const c = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

// Sample a vector field on a grid (scene coords, like Manim's ArrowVectorField).
export function sampleVectorField(o: SceneObject): FieldArrow[] {
  const p = o.props as any;
  const xf = compileExpr2(String(p.x_func ?? '-y'));
  const yf = compileExpr2(String(p.y_func ?? 'x'));
  if (!xf || !yf) return [];
  const xr = rng(p.x_range, [-5, 5]); let xs = Math.abs(Number((p.x_range ?? [])[2]) || 1) || 1;
  const yr = rng(p.y_range, [-3, 3]); let ys = Math.abs(Number((p.y_range ?? [])[2]) || 1) || 1;
  // Cap the preview grid (~800 arrows) so a tiny step can't freeze the canvas.
  const cap = 800;
  while (((xr[1] - xr[0]) / xs + 1) * ((yr[1] - yr[0]) / ys + 1) > cap) { xs *= 1.5; ys *= 1.5; }
  const arrows: FieldArrow[] = [];
  for (let x = xr[0]; x <= xr[1] + 1e-9; x += xs) {
    for (let y = yr[0]; y <= yr[1] + 1e-9; y += ys) {
      let vx: number, vy: number;
      try { vx = xf(x, y); vy = yf(x, y); } catch { continue; }
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
      const mag = Math.hypot(vx, vy) || 1e-6;
      const len = Math.min(0.5, 0.18 * Math.log1p(mag) + 0.12); // units
      arrows.push({ x, y, dx: (vx / mag) * len, dy: (vy / mag) * len, mag });
    }
  }
  return arrows;
}

// Sample a plot across the axes; returns flat [x0,y0,x1,y1,...] world px points.
export function samplePlot(axes: SceneObject, expr: string, xRange?: number[], samples = 120): number[] {
  const g = axesGeom(axes);
  const fn = compileExpr(expr);
  if (!fn) return [];
  const [x0, x1] = xRange && xRange.length >= 2 ? [xRange[0], xRange[1]] : [g.xmin, g.xmax];
  const pts: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const dx = x0 + ((x1 - x0) * i) / samples;
    let dy: number;
    try { dy = fn(dx); } catch { continue; }
    if (!Number.isFinite(dy)) continue;
    const [px, py] = dataToWorldPx(g, dx, dy);
    pts.push(px, py);
  }
  return pts;
}
