// Data-driven objects — `graph.histogram` and `number` — and their `update_data`
// keyframes, as the editor sees them. Shared by the canvas renderers, the
// playback preview (`playback.ts`), Duplicate final state (`store/finalState.ts`)
// and the inspectors. Mirrors the codegen's template helpers (LocusHistogram /
// LocusBars / LocusNumber / LocusCount in backend/app/codegen/template.py):
//   - an update starts from whatever the previous one left (not from the
//     authored props), and eases to its target with the keyframe's easing;
//   - a histogram update with more values than bars is truncated, fewer is
//     padded with zeros;
//   - a number shows `decimals` places, no thousands separators.
import type { Keyframe, SceneObject } from '../types/ir';
import { kfAlpha } from './motion';

export type DataKind = 'bars' | 'count' | null;

export function isHistogram(o: SceneObject | undefined): boolean {
  return o?.type === 'graph' && (o.props as Record<string, unknown>)?.subtype === 'histogram';
}

export function dataKind(o: SceneObject | undefined): DataKind {
  if (isHistogram(o)) return 'bars';
  if (o?.type === 'number') return 'count';
  return null;
}

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function histValues(o: SceneObject): number[] {
  const v = (o.props as Record<string, unknown>).values;
  return Array.isArray(v) ? v.map(x => num(x, 0)) : [];
}

// Pad / truncate to `n` bars, like `_locus_set_bars`.
export function fitBars(vals: number[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => num(vals[i], 0));
}

// A keyframe's data, if it fits the object (the codegen drops the rest).
function kfData(kind: DataKind, kf: Keyframe): number | number[] | null {
  const p = (kf.params ?? {}) as Record<string, unknown>;
  if (kind === 'bars') return Array.isArray(p.values) ? p.values.map(x => num(x, 0)) : null;
  if (kind === 'count') return p.value != null && !Array.isArray(p.values) ? num(p.value, 0) : null;
  return null;
}

// The object's data at time `t`: bar heights for a histogram, the value for a
// number, null for anything else. `t = Infinity` is the end state.
export function dataAt(o: SceneObject, kfs: Keyframe[], t: number): number | number[] | null {
  const kind = dataKind(o);
  if (!kind) return null;
  const own = kfs.filter(k => k.object_id === o.id && k.verb === 'update_data' && k.start_time < t)
    .sort((a, b) => a.start_time - b.start_time);
  if (kind === 'bars') {
    let cur = histValues(o);
    const n = Math.max(1, cur.length);
    cur = fitBars(cur, n);
    for (const k of own) {
      const to = kfData(kind, k);
      if (!Array.isArray(to)) continue;
      const tgt = fitBars(to, n);
      const a = kfAlpha(k, t);
      cur = cur.map((v, i) => v + (tgt[i] - v) * a);
    }
    return cur;
  }
  let cur = num((o.props as Record<string, unknown>).value, 0);
  for (const k of own) {
    const to = kfData(kind, k);
    if (typeof to !== 'number') continue;
    cur += (to - cur) * kfAlpha(k, t);
  }
  return cur;
}

// The object with its data at time `t` written into its props (a clone).
export function withDataAt<T extends SceneObject>(o: T, kfs: Keyframe[], t: number): T {
  const d = dataAt(o, kfs, t);
  if (d == null) return o;
  return { ...o, props: { ...o.props, ...(Array.isArray(d) ? { values: d } : { value: d }) } };
}

// --- number formatting (mirrors Manim's DecimalNumber) ----------------------

export function numberDecimals(o: SceneObject): number {
  return Math.max(0, Math.min(10, Math.trunc(num((o.props as Record<string, unknown>).decimals, 2))));
}

export function formatNumber(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  // Manim formats with Python's "{:.Nf}", which keeps a "-0.00"; toFixed drops
  // the sign of -0 but keeps it for tiny negatives, so normalise both to "0.00".
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

// KaTeX source for a number readout: label then number with TeX's spacing
// between them — the codegen typesets the label with a placeholder digit and
// drops the DecimalNumber onto it, so the gap is exactly this.
export function numberTex(o: SceneObject): string {
  const p = o.props as Record<string, unknown>;
  const label = String(p.label ?? '').trim();
  const n = formatNumber(num(p.value, 0), numberDecimals(o));
  return label ? `${label} ${n}` : n;
}

// Rough character count of the rendered readout (for bounds).
export function numberWidthChars(o: SceneObject): number {
  const label = String((o.props as Record<string, unknown>).label ?? '')
    .replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}^_\s]/g, '');
  return label.length + numberTex({ ...o, props: { ...o.props, label: '' } }).length;
}
