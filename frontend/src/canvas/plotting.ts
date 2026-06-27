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

// Compile a y=f(x) expression (Python/numpy-ish) into a JS function.
// Supports sin, cos, tan, exp, log, sqrt, abs, pi, e and ** exponentiation.
export function compileExpr(expr: string): ((x: number) => number) | null {
  try {
    const preamble =
      'const sin=Math.sin,cos=Math.cos,tan=Math.tan,exp=Math.exp,' +
      'log=Math.log,sqrt=Math.sqrt,abs=Math.abs,pi=Math.PI,e=Math.E,' +
      'pow=Math.pow,floor=Math.floor,ceil=Math.ceil,sign=Math.sign;';
    // eslint-disable-next-line no-new-func
    const fn = new Function('x', `${preamble} return (${expr});`) as (x: number) => number;
    fn(0); // smoke test
    return fn;
  } catch {
    return null;
  }
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
