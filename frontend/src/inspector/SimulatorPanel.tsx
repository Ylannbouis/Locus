// "Sampling simulator" section of a histogram's Inspector — fills the histogram
// with the sample means (or sums) of a simulated sampling run, over time, plus
// optional trial-counter / latest-statistic readouts and a normal-curve overlay.
// The maths lives in sim/sampling.ts; this file is settings + one commit.
//
// Settings persist in the histogram's `props.sim` (editor-only — the codegen
// ignores it). A run is committed with `applySimulation`: one undo step that
// replaces the previous run's keyframes (tagged `params.sim_run`) and resets the
// histogram / readouts to their pre-run state.
import { useProjectStore } from '../store/projectStore';
import { useTimelineStore } from '../timeline/timelineStore';
import { createFunctionPlot, createNumber, newId, objectDefaultFor, withDefaults } from '../store/objectFactory';
import {
  DEFAULT_SIM, POPULATIONS, fitAxesRanges, fitBins, normalCurve, simSettings, simulate, statTheory,
  type Bins, type SimSettings,
} from '../sim/sampling';
import type { Scene, SceneObject } from '../types/ir';

function Num({ label, value, step = 1, min, onChange, title }: {
  label: string; value: number; step?: number; min?: number; onChange: (v: number) => void; title?: string;
}) {
  return (
    <label className="field" title={title}>
      <span className="field__label">{label}</span>
      <input className="field__input" type="number" step={step} min={min} value={Number.isFinite(value) ? value : 0}
        onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} />
    </label>
  );
}

const fmt = (v: number, d = 3) => String(Math.round(v * 10 ** d) / 10 ** d);

export function SimulatorPanel({ obj, scene }: { obj: SceneObject; scene: Scene }) {
  const project = useProjectStore(s => s.project);
  const updateObject = useProjectStore(s => s.updateObject);
  const addObject = useProjectStore(s => s.addObject);
  const applySimulation = useProjectStore(s => s.applySimulation);
  const selectObject = useProjectStore(s => s.selectObject);

  const props = obj.props as Record<string, unknown>;
  const raw = (props.sim ?? {}) as Partial<SimSettings>;
  const sim: SimSettings = { ...DEFAULT_SIM, run_id: '', ...raw } as SimSettings;
  const setSim = (patch: Partial<SimSettings>) =>
    updateObject(obj.id, { props: { ...props, sim: { ...sim, ...patch } } }, `obj:${obj.id}:sim:${Object.keys(patch).join(',')}`);

  const axes = scene.objects.find(o => o.id === props.axes_ref && o.type === 'coordinate_system');
  const numbers = scene.objects.filter(o => o.type === 'number');
  // The run id this histogram may replace keyframes under. A histogram copied
  // before the fix kept its original's `run_id`; if that id's keyframes are on
  // another histogram (and none on this one), they're the other's run — mint a
  // fresh id rather than delete them.
  const ownRunId = (): string => {
    const id = sim.run_id;
    if (!id) return '';
    const tagged = scene.timeline.keyframes.filter(k => (k.params as Record<string, unknown>)?.sim_run === id);
    const histIds = new Set(scene.objects.filter(o => o.type === 'graph'
      && (o.props as Record<string, unknown>).subtype === 'histogram').map(o => o.id));
    const mine = tagged.some(k => k.object_id === obj.id);
    const others = tagged.some(k => k.object_id !== obj.id && histIds.has(k.object_id));
    return !mine && others ? '' : id;
  };

  const myRun = ownRunId();
  const runKfs = myRun
    ? scene.timeline.keyframes.filter(k => (k.params as Record<string, unknown>)?.sim_run === myRun)
    : [];
  const runEnd = runKfs.reduce((m, k) => Math.max(m, k.start_time + k.duration), 0);
  const th = statTheory(sim);
  const normalPlot = scene.objects.find(o => o.type === 'graph' && (o.props as Record<string, unknown>).normal_of === obj.id);
  const statSym = sim.statistic === 'mean' ? 'x̄' : 'Σx';

  // A readout placed above the histogram's axes (left: counter, right: statistic).
  const newReadout = (which: 'counter' | 'stat') => {
    const base = withDefaults(createNumber(), objectDefaultFor(project, 'number'));
    const ap = (axes?.props ?? {}) as Record<string, unknown>;
    const ax = axes?.position ?? { x: 0, y: 0 };
    const xl = Number(ap.x_length ?? 6), yl = Number(ap.y_length ?? 4);
    const o: SceneObject = {
      ...base,
      name: which === 'counter' ? 'Trials' : sim.statistic === 'mean' ? 'Sample mean' : 'Sample sum',
      position: { x: Math.round((ax.x + (which === 'counter' ? -xl / 4 : xl / 4)) * 100) / 100, y: Math.round((ax.y + yl / 2 + 0.7) * 100) / 100 },
      props: which === 'counter'
        ? { ...base.props, label: '\\text{trials: }', decimals: 0, value: 0 }
        : { ...base.props, label: sim.statistic === 'mean' ? '\\bar{x} =' : '\\textstyle\\sum x =', decimals: 2, value: Math.round(th.mean * 100) / 100 },
    };
    addObject(o);
    setSim(which === 'counter' ? { counter_id: o.id } : { stat_id: o.id });
    selectObject(obj.id); // addObject selects the new readout; stay on this panel
  };

  const run = (seed = sim.seed) => {
    const runId = ownRunId() || newId('sim');
    const s = simSettings({ ...sim, seed }, runId);
    const vals = Array.isArray(props.values) ? props.values as number[] : [];
    const bins: Bins = s.auto_bins
      ? fitBins(s)
      : { bin_start: Number(props.bin_start ?? 0), bin_width: Number(props.bin_width) > 0 ? Number(props.bin_width) : 1, count: Math.max(1, vals.length) };
    const res = simulate(s, bins, { hist: obj.id }, newId);
    const patches: { id: string; patch: Partial<SceneObject> }[] = [{
      id: obj.id,
      patch: { props: { ...props, bin_start: bins.bin_start, bin_width: bins.bin_width, values: new Array(bins.count).fill(0), sim: s } },
    }];
    // Readouts start where the run starts: no trials yet, and the first
    // sample's statistic (the first keyframe then holds it).
    const counter = scene.objects.find(o => o.id === s.counter_id && o.type === 'number');
    if (counter) patches.push({ id: counter.id, patch: { props: { ...counter.props, value: 0, decimals: 0 } } });
    const stat = scene.objects.find(o => o.id === s.stat_id && o.type === 'number');
    if (stat && res.statKfs.length) patches.push({ id: stat.id, patch: { props: { ...stat.props, value: res.statKfs[0].params.value as number } } });
    if (s.fit_axes && axes) {
      const r = fitAxesRanges(bins, Math.max(res.maxBar, normalPlot ? res.normalPeak : 0));
      patches.push({ id: axes.id, patch: { props: { ...axes.props, ...r } } });
    }
    if (normalPlot) {
      const hi = bins.bin_start + bins.count * bins.bin_width;
      patches.push({ id: normalPlot.id, patch: { props: { ...normalPlot.props, expression: res.normalExpr, x_range: [bins.bin_start, hi] } } });
    }
    const kfs = [...res.histKfs, ...res.counterKfs, ...res.statKfs];
    applySimulation(runId, kfs, patches);
  };

  const remove = () => {
    const id = ownRunId();
    if (!id) return;
    applySimulation(id, [], []);
  };

  const addNormal = () => {
    if (!axes) return;
    const p = obj.props as Record<string, unknown>;
    const bw = Number(p.bin_width) > 0 ? Number(p.bin_width) : 1;
    const n = Array.isArray(p.values) ? (p.values as unknown[]).length : 1;
    const x0 = Number(p.bin_start ?? 0);
    const nc = normalCurve(simSettings(sim, sim.run_id), bw);
    const base = withDefaults(createFunctionPlot(axes.id), objectDefaultFor(project, 'function_plot'));
    const curve: SceneObject = {
      ...base, name: 'Normal curve',
      style: { ...base.style, stroke_color: '#ffff00' },
      props: { ...base.props, expression: nc.expr, x_range: [x0, x0 + n * bw], normal_of: obj.id },
    };
    addObject(curve);
    selectObject(obj.id);
  };

  const picker = (label: string, value: string, which: 'counter' | 'stat', hint: string) => (
    <div className="field" title={hint}>
      <span className="field__label">{label}</span>
      <div className="field-row sim-panel__picker">
        <select className="field__input" value={numbers.some(o => o.id === value) ? value : ''}
          onChange={e => setSim(which === 'counter' ? { counter_id: e.target.value } : { stat_id: e.target.value })}>
          <option value="">— none —</option>
          {numbers.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
        </select>
        <button type="button" className="btn btn--ghost" onClick={() => newReadout(which)} title="Add a new number readout for this">+ New</button>
      </div>
    </div>
  );

  return (
    <details className="sim-panel" open>
      <summary className="sim-panel__title">Sampling simulator</summary>
      <p className="panel-hint">
        Draws {sim.trials} samples of {sim.n} from the population and stacks each sample's {sim.statistic} into the bars,
        a few at a time and then faster. Same seed → same run, in the preview and the render.
      </p>

      <label className="field">
        <span className="field__label">Population</span>
        <select className="field__input" value={sim.population} onChange={e => setSim({ population: e.target.value as SimSettings['population'] })}>
          {Object.entries(POPULATIONS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field__label">Statistic</span>
          <select className="field__input" value={sim.statistic} onChange={e => setSim({ statistic: e.target.value as SimSettings['statistic'] })}>
            <option value="mean">Mean</option>
            <option value="sum">Sum</option>
          </select>
        </label>
        <Num label="Sample size n" value={sim.n} min={1} onChange={v => setSim({ n: Math.max(1, Math.round(v)) })}
          title="Draws per sample. n = 1 shows the population itself; raise it and the bars turn into a bell." />
      </div>
      <div className="field-row">
        <Num label="Samples (trials)" value={sim.trials} min={1} step={50} onChange={v => setSim({ trials: Math.max(1, Math.round(v)) })} />
        <label className="field">
          <span className="field__label">Bar height</span>
          <select className="field__input" value={sim.scale} onChange={e => setSim({ scale: e.target.value as SimSettings['scale'] })}>
            <option value="count">Count</option>
            <option value="density">Density</option>
          </select>
        </label>
      </div>
      <p className="panel-hint">
        Theory: {statSym} has mean {fmt(th.mean)} and SD {fmt(th.sd)}
        {sim.statistic === 'mean' ? ` (= σ/√n, σ = ${fmt(Math.sqrt(POPULATIONS[sim.population].variance))})` : ''}.
      </p>

      <div className="field-row">
        <Num label="Start (s)" value={sim.start} step={0.5} min={0} onChange={v => setSim({ start: Math.max(0, v) })} />
        <Num label="Duration (s)" value={sim.duration} step={0.5} min={0.1} onChange={v => setSim({ duration: Math.max(0.1, v) })} />
        <Num label="Steps" value={sim.steps} min={1} onChange={v => setSim({ steps: Math.max(1, Math.round(v)) })}
          title="Keyframes the run is split into — each adds the same number of samples, so the bars grow at a steady pace." />
      </div>
      <button type="button" className="btn btn--ghost" onClick={() => setSim({ start: Math.round(useTimelineStore.getState().playhead * 100) / 100 })}>
        Start at playhead
      </button>

      {picker('Trial counter', sim.counter_id, 'counter', 'A number readout that counts the samples drawn so far')}
      {picker(`Latest ${statSym}`, sim.stat_id, 'stat', "A number readout showing the newest sample's statistic")}

      <label className="field field--check">
        <input type="checkbox" checked={sim.auto_bins} onChange={e => setSim({ auto_bins: e.target.checked })} />
        <span>Fit bins to the statistic</span>
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={sim.fit_axes} onChange={e => setSim({ fit_axes: e.target.checked })} disabled={!axes} />
        <span>Fit the axes to the result</span>
      </label>

      <div className="field-row sim-panel__actions">
        <Num label="Seed" value={sim.seed} min={0} onChange={v => setSim({ seed: Math.max(0, Math.round(v)) })} />
        <button type="button" className="btn btn--secondary" onClick={() => run(sim.seed + 1)} disabled={!axes}
          title="Same settings, a new random run (seed + 1)">🎲 Re-roll</button>
      </div>
      <button type="button" className="btn btn--primary" onClick={() => run()} disabled={!axes}>
        {runKfs.length ? 'Re-run simulation' : 'Simulate'}
      </button>
      {!axes && <span className="kf-warn">Pick the axes for this histogram first.</span>}

      {runKfs.length > 0 && (
        <div className="sim-panel__status">
          <span className="panel-hint">
            {runKfs.length} keyframes, {fmt(sim.start, 2)}–{fmt(runEnd, 2)} s. Re-running replaces them.
          </span>
          <button type="button" className="btn btn--danger-ghost" onClick={remove}>Remove run</button>
        </div>
      )}

      <button type="button" className="btn btn--ghost" onClick={addNormal} disabled={!axes || !!normalPlot}
        title="A function plot of the normal distribution the CLT predicts, in the bars' units — re-running keeps it in step">
        {normalPlot ? '✓ Normal curve added' : '+ Add normal curve'}
      </button>
    </details>
  );
}
