// Sampling simulator — the central-limit-theorem workhorse.
//
// Draw `trials` samples of size `n` from a population, take each sample's mean
// (or sum), and pour those statistics into a histogram over time: a few trials
// one by one, then ever bigger batches, so the bell shape builds up on screen.
//
// Everything random happens HERE, at authoring time, from a seeded generator,
// and lands in the IR as plain numbers — `update_data` keyframes carrying bar
// heights / readout values. The codegen and the canvas preview just play those
// numbers back, so the preview and the render show the very same run, the run
// is reproducible (same seed → same keyframes), and "re-roll" is a new seed.
// The IR stays the source of truth; nothing random reaches the Python.
import type { Keyframe } from '../types/ir';

export type Population = 'die' | 'coin' | 'uniform' | 'exponential' | 'u_shaped';
export type Statistic = 'mean' | 'sum';
export type BarScale = 'count' | 'density';

interface PopulationSpec {
  label: string;
  mean: number;
  variance: number;
  // Spacing of a single draw's possible values (discrete populations), or
  // null when continuous. Bins are aligned to it so no bin catches more
  // possible values than its neighbours (which would make the bars comb-like).
  lattice: number | null;
  support: [number, number];
  draw: (u: number) => number; // u ~ U[0, 1)
}

export const POPULATIONS: Record<Population, PopulationSpec> = {
  die: {
    label: 'Fair die (1–6)', mean: 3.5, variance: 35 / 12, lattice: 1, support: [1, 6],
    draw: u => 1 + Math.floor(u * 6),
  },
  coin: {
    label: 'Biased coin (1 w.p. 0.3)', mean: 0.3, variance: 0.21, lattice: 1, support: [0, 1],
    draw: u => (u < 0.3 ? 1 : 0),
  },
  uniform: {
    label: 'Uniform (0–1)', mean: 0.5, variance: 1 / 12, lattice: null, support: [0, 1],
    draw: u => u,
  },
  exponential: {
    label: 'Exponential (skewed, mean 1)', mean: 1, variance: 1, lattice: null, support: [0, Infinity],
    draw: u => -Math.log(1 - u),
  },
  u_shaped: {
    label: 'U-shaped (arcsine)', mean: 0.5, variance: 1 / 8, lattice: null, support: [0, 1],
    draw: u => Math.sin((Math.PI * u) / 2) ** 2,
  },
};

export interface SimSettings {
  population: Population;
  statistic: Statistic;
  n: number;          // sample size
  trials: number;     // how many samples
  seed: number;
  scale: BarScale;    // bar heights: raw counts, or a density (area 1 at the end)
  start: number;      // seconds
  duration: number;   // seconds for the whole run
  steps: number;      // keyframes (batches) the run is split into
  counter_id: string; // `number` object showing trials so far ('' = none)
  stat_id: string;    // `number` object showing the latest sample's mean/sum ('' = none)
  auto_bins: boolean; // fit the bins to the statistic (fitBins) on every run
  fit_axes: boolean;  // resize the axes to the bins and the tallest bar
  run_id: string;     // tags this run's keyframes so a re-run replaces them
}

export const DEFAULT_SIM: Omit<SimSettings, 'run_id'> = {
  population: 'die', statistic: 'mean', n: 5, trials: 500, seed: 1, scale: 'count',
  start: 0, duration: 8, steps: 40, counter_id: '', stat_id: '', auto_bins: true, fit_axes: true,
};

export const MIN_STEP_S = 0.1; // shortest keyframe the inspector allows

export function simSettings(raw: unknown, runId: string): SimSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SimSettings>;
  const s = { ...DEFAULT_SIM, ...r, run_id: runId } as SimSettings;
  if (!(s.population in POPULATIONS)) s.population = 'die';
  s.n = clampInt(s.n, 1, 10000);
  s.trials = clampInt(s.trials, 1, 100000);
  s.seed = clampInt(s.seed, 0, 2 ** 31 - 1);
  s.duration = Math.max(MIN_STEP_S, Number(s.duration) || DEFAULT_SIM.duration);
  s.start = Math.max(0, Number(s.start) || 0);
  s.steps = clampInt(s.steps, 1, Math.min(s.trials, Math.floor(s.duration / MIN_STEP_S)));
  return s;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

// mulberry32: tiny, fast, good enough for a picture, and identical everywhere.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Theory for the statistic: its mean, standard deviation (σ/√n for a mean —
// the CLT's whole point), the spacing of its possible values, and its range.
export function statTheory(s: Pick<SimSettings, 'population' | 'statistic' | 'n'>) {
  const p = POPULATIONS[s.population];
  const sd = Math.sqrt(p.variance);
  if (s.statistic === 'sum') {
    return {
      mean: p.mean * s.n, sd: sd * Math.sqrt(s.n),
      lattice: p.lattice, support: [p.support[0] * s.n, p.support[1] * s.n] as [number, number],
    };
  }
  return {
    mean: p.mean, sd: sd / Math.sqrt(s.n),
    lattice: p.lattice == null ? null : p.lattice / s.n, support: p.support,
  };
}

export interface Bins { bin_start: number; bin_width: number; count: number }

// Bins covering μ ± 4σ of the statistic (clipped to what it can take). For a
// discrete population each bin holds a whole number of possible values,
// centred on them, so n = 1 reproduces the population's own bar chart.
export function fitBins(s: Pick<SimSettings, 'population' | 'statistic' | 'n'>, target = 24): Bins {
  const th = statTheory(s);
  const L = th.lattice;
  const half = L ? L / 2 : 0;
  let lo = Math.max(th.mean - 4 * th.sd, th.support[0] - half);
  let hi = Math.min(th.mean + 4 * th.sd, th.support[1] + half);
  if (!(hi > lo)) { lo = th.mean - 1; hi = th.mean + 1; }
  if (L) {
    const w = Math.max(1, Math.round((hi - lo) / target / L)) * L;
    lo = (Math.round(lo / L - 0.5) + 0.5) * L; // an edge halfway between values
    const count = Math.max(1, Math.ceil((hi - lo) / w - 1e-9));
    return { bin_start: round(lo), bin_width: round(w), count };
  }
  const w = niceStep((hi - lo) / target);
  lo = Math.floor(lo / w) * w;
  return { bin_start: round(lo), bin_width: round(w), count: Math.max(1, Math.ceil((hi - lo) / w - 1e-9)) };
}

// The 1, 2 or 5 × a power of ten nearest to x (on a log scale).
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  let best = p;
  for (const m of [1, 2, 5, 10]) {
    if (Math.abs(Math.log(m * p / x)) < Math.abs(Math.log(best / x))) best = m * p;
  }
  return round(best);
}

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

// Cumulative trials after each step: equal batches (T·i/K, rounded), ending
// exactly at T. Every step lasts the same time, so samples arrive at a constant
// rate and the bars grow at a steady pace (a geometric schedule made them
// visibly accelerate). steps ≤ trials (simSettings), so every batch is ≥ 1.
export function schedule(trials: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= steps; i++) out.push(Math.round((trials * i) / steps));
  return out;
}

export interface SimResult {
  histKfs: Keyframe[];
  counterKfs: Keyframe[];
  statKfs: Keyframe[];
  maxBar: number;
  // Normal approximation in the bars' units — a numpy expression in x, ready
  // for a function plot on the same axes.
  normalExpr: string;
  normalPeak: number;
  outOfRange: number; // statistics that fell outside every bin
}

export function simulate(s: SimSettings, bins: Bins, objIds: { hist: string }, newId: (p: string) => string): SimResult {
  const pop = POPULATIONS[s.population];
  const next = rng(s.seed);
  const stats: number[] = [];
  for (let t = 0; t < s.trials; t++) {
    let sum = 0;
    for (let k = 0; k < s.n; k++) sum += pop.draw(next());
    stats.push(s.statistic === 'mean' ? sum / s.n : sum);
  }

  const counts = new Array(bins.count).fill(0);
  let outOfRange = 0;
  const unit = s.scale === 'density' ? 1 / (s.trials * bins.bin_width) : 1;
  const cum = schedule(s.trials, s.steps);
  const dt = s.duration / cum.length;
  const histKfs: Keyframe[] = [];
  const counterKfs: Keyframe[] = [];
  const statKfs: Keyframe[] = [];
  let done = 0;
  let maxBar = 0;
  const mk = (objectId: string, i: number, dur: number, params: Record<string, unknown>): Keyframe => ({
    id: newId('kf'), object_id: objectId, start_time: round(s.start + i * dt, 3), verb: 'update_data',
    duration: round(dur, 3), easing: 'linear', group_id: null, params: { ...params, sim_run: s.run_id },
  });

  cum.forEach((upto, i) => {
    for (; done < upto; done++) {
      // A tiny epsilon keeps a value that sits exactly on an edge (lattice
      // points never do, by construction) out of floating-point limbo.
      const b = Math.floor((stats[done] - bins.bin_start) / bins.bin_width + 1e-9);
      if (b >= 0 && b < bins.count) counts[b]++;
      else outOfRange++;
    }
    const values = counts.map(c => round(c * unit, 5));
    maxBar = Math.max(maxBar, ...values);
    histKfs.push(mk(objIds.hist, i, dt, { values }));
    if (s.counter_id) counterKfs.push(mk(s.counter_id, i, dt, { value: upto }));
    // The readout jumps (quickly) to each batch's newest sample rather than
    // sliding through in-between values that were never drawn.
    if (s.stat_id) statKfs.push(mk(s.stat_id, i, Math.min(dt, 0.15), { value: round(stats[upto - 1], 4) }));
  });

  const nc = normalCurve(s, bins.bin_width);
  return { histKfs, counterKfs, statKfs, maxBar, outOfRange, normalPeak: nc.peak, normalExpr: nc.expr };
}

// The CLT's prediction for these bars: N(μ, σ²/n) for a mean (N(nμ, nσ²) for a
// sum), scaled to the bars' units — a density as is, counts × trials × bin width.
// A numpy expression in x, so a function plot on the same axes overlays it.
export function normalCurve(s: Pick<SimSettings, 'population' | 'statistic' | 'n' | 'scale' | 'trials'>, binWidth: number) {
  const th = statTheory(s);
  const k = s.scale === 'density' ? 1 : s.trials * binWidth;
  const mu = round(th.mean, 5), sd = round(th.sd, 5);
  return {
    // `-((…)**2)`, not `-(…)**2`: the same string is evaluated as JavaScript by
    // the canvas preview, where a unary minus right before ** is a SyntaxError.
    expr: `${round(k, 5)} * exp(-((x - ${mu})**2) / (2 * ${sd}**2)) / (${sd} * sqrt(2 * pi))`,
    peak: k / (th.sd * Math.sqrt(2 * Math.PI)),
    mean: th.mean, sd: th.sd,
  };
}

// Axes ranges that frame the bins and the tallest bar (or the normal curve's
// peak, so an overlay fits too), with tidy tick steps.
export function fitAxesRanges(bins: Bins, top: number): { x_range: number[]; y_range: number[] } {
  const lo = bins.bin_start, hi = bins.bin_start + bins.count * bins.bin_width;
  const xs = niceStep((hi - lo) / 5); // ~5 ticks: labels stay legible
  const ytop = Math.max(top * 1.1, 1e-6);
  const ys = niceStep(ytop / 5);
  return {
    x_range: [round(Math.floor(lo / xs + 1e-9) * xs), round(Math.ceil(hi / xs - 1e-9) * xs), xs],
    y_range: [0, round(Math.ceil(ytop / ys - 1e-9) * ys), ys],
  };
}
