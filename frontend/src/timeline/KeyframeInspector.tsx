import { useProjectStore } from '../store/projectStore';
import { useRenderStore } from '../store/renderStore';
import { useTimelineStore, VERB_META, TIMELINE_VERBS, EASING_OPTIONS, defaultParams, CAMERA_ID } from './timelineStore';
import type { AnimationVerb, EasingType, Point2D } from '../types/ir';

// Approximate rate functions for the visual easing preview (not used for render).
const RATE: Record<string, (t: number) => number> = {
  linear: t => t,
  smooth: t => t * t * t * (t * (t * 6 - 15) + 10),
  rush_from: t => t * (2 - t),
  rush_into: t => t * t,
  there_and_back: t => Math.sin(Math.PI * t),
  double_smooth: t => {
    const s = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
    return t < 0.5 ? s(t * 2) / 2 : 0.5 + s((t - 0.5) * 2) / 2;
  },
};

function EasingPreview({ easing }: { easing: string }) {
  const fn = RATE[easing] ?? RATE.smooth;
  const w = 120, h = 40, n = 32;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return `${(t * w).toFixed(1)},${(h - fn(t) * h).toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} className="kf-ease-preview">
      <polyline points={`0,${h} ${w},${h}`} stroke="var(--border)" strokeWidth={1} fill="none" />
      <polyline points={pts} stroke="var(--accent)" strokeWidth={2} fill="none" />
    </svg>
  );
}

function Num({ label, value, step = 0.1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="field__input" type="number" step={step} value={Number.isFinite(value) ? value : 0}
        onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} />
    </label>
  );
}

function Vec({ label, value, onChange }: { label: string; value: Point2D; onChange: (v: Point2D) => void }) {
  const v = value ?? { x: 0, y: 0 };
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="field-row">
        <input className="field__input" type="number" step={0.1} value={v.x} onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) onChange({ x: n, y: v.y }); }} />
        <input className="field__input" type="number" step={0.1} value={v.y} onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) onChange({ x: v.x, y: n }); }} />
      </div>
    </div>
  );
}

// key-map editor + "Preview Morph" 1-second test render
function MorphTools({ keyMap, onChange, canPreview, keyframeId }: {
  keyMap: Record<string, string>; onChange: (m: Record<string, string>) => void; canPreview: boolean; keyframeId: string;
}) {
  const project = useProjectStore(s => s.project);
  const sceneId = useProjectStore(s => s.selectedSceneId);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const triggerMorphPreview = useRenderStore(s => s.triggerMorphPreview);
  const isRendering = useRenderStore(s => s.isRendering);

  const entries = Object.entries(keyMap);
  const rebuild = (list: [string, string][]) => {
    const o: Record<string, string> = {};
    for (const [k, v] of list) if (k) o[k] = v;
    onChange(o);
  };

  const preview = async () => {
    if (!project || !sceneId) return;
    if (isDirty) await save(); // ensure the backend has the latest key_map/targets
    await triggerMorphPreview(project.id, sceneId, keyframeId);
  };

  return (
    <div className="field">
      <span className="field__label">Key map (match TeX substrings)</span>
      {entries.map(([from, to], i) => (
        <div className="field-row" key={i} style={{ marginBottom: 4 }}>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, monospace' }} type="text" placeholder="from" value={from}
            onChange={e => { const l = [...entries] as [string, string][]; l[i] = [e.target.value, to]; rebuild(l); }} />
          <span style={{ alignSelf: 'center' }}>→</span>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, monospace' }} type="text" placeholder="to" value={to}
            onChange={e => { const l = [...entries] as [string, string][]; l[i] = [from, e.target.value]; rebuild(l); }} />
          <button className="btn btn--ghost" onClick={() => rebuild(entries.filter((_, j) => j !== i) as [string, string][])}>✕</button>
        </div>
      ))}
      <button className="btn" onClick={() => rebuild([...entries as [string, string][], ['', '']])}>+ pair</button>
      <button className="btn btn--secondary" style={{ marginTop: 6 }} disabled={!canPreview || isRendering} onClick={preview}>
        {isRendering ? 'Rendering…' : '▶ Preview Morph'}
      </button>
      <span className="panel-hint">Renders a 1-second test of just this morph (see the Render panel).</span>
    </div>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="field__color" type="color" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

export function KeyframeInspector() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);
  const { selectedKfIds, clearKf } = useTimelineStore();

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const kf = scene?.timeline.keyframes.find(k => k.id === selectedKfIds[0]);
  if (!scene || !kf) return null;

  const obj = scene.objects.find(o => o.id === kf.object_id);
  const params = (kf.params ?? {}) as Record<string, any>;
  const setParam = (patch: Record<string, any>) => updateKeyframe(kf.id, { params: { ...params, ...patch } });
  const verb = kf.verb;
  const isCamera = kf.object_id === CAMERA_ID || verb === 'camera_move';

  const otherObjects = scene.objects.filter(o => o.id !== kf.object_id);
  const moveMode: 'to' | 'by' = params.delta ? 'by' : 'to';
  const focusId = String(params.focus_object_id ?? '');

  return (
    <div className="kf-inspector">
      <h3 className="panel-title">{isCamera ? '📷 Camera Move' : `Animation — ${obj?.name || obj?.type || '?'}`}</h3>

      {!isCamera && (
        <label className="field">
          <span className="field__label">Verb</span>
          <select className="field__input" value={verb} onChange={e => { const v = e.target.value as AnimationVerb; updateKeyframe(kf.id, { verb: v, params: defaultParams(v) }); }}>
            {TIMELINE_VERBS.map(v => <option key={v} value={v}>{VERB_META[v].label}</option>)}
          </select>
        </label>
      )}

      <div className="field-row">
        <Num label="Start (s)" value={kf.start_time} onChange={v => updateKeyframe(kf.id, { start_time: Math.max(0, v) })} />
        <Num label="Duration (s)" value={kf.duration} onChange={v => updateKeyframe(kf.id, { duration: Math.max(0.1, v) })} />
      </div>

      <label className="field">
        <span className="field__label">Easing</span>
        <select className="field__input" value={kf.easing} onChange={e => updateKeyframe(kf.id, { easing: e.target.value as EasingType })}>
          {EASING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <EasingPreview easing={kf.easing} />

      {/* ---- camera move ---- */}
      {isCamera && (
        <>
          <label className="field">
            <span className="field__label">Focus object (optional)</span>
            <select className="field__input" value={focusId}
              onChange={e => setParam({ focus_object_id: e.target.value || undefined, track: e.target.value ? params.track : undefined })}>
              <option value="">— pan to point —</option>
              {otherObjects.map(o => <option key={o.id} value={o.id}>{o.name || o.type}</option>)}
            </select>
          </label>
          {!focusId && (
            <Vec label="Pan to (x, y)" value={params.pan ?? { x: 0, y: 0 }} onChange={v => setParam({ pan: v })} />
          )}
          {focusId && (
            <label className="field field--check">
              <input type="checkbox" checked={!!params.track} onChange={e => setParam({ track: e.target.checked })} />
              <span className="field__label" style={{ margin: 0 }}>Track continuously (follow while it moves)</span>
            </label>
          )}
          <Num label="Zoom (1 = full frame)" value={Number(params.zoom ?? 1)} step={0.1}
            onChange={v => setParam({ zoom: Math.max(0.1, v) })} />
          <span className="panel-hint">
            {params.track && focusId
              ? 'The camera locks onto the object for this keyframe’s duration — overlap it with the object’s move.'
              : 'Zoom > 1 moves the camera in; the frame width is the scene width ÷ zoom.'}
          </span>
        </>
      )}

      {/* ---- verb-specific params ---- */}
      {(verb === 'fade_in' || verb === 'fade_out') && (
        <Vec label="Shift (x, y)" value={params.shift ?? { x: 0, y: 0 }} onChange={v => setParam({ shift: v })} />
      )}

      {verb === 'move' && (
        <>
          <label className="field">
            <span className="field__label">Mode</span>
            <select className="field__input" value={moveMode} onChange={e => {
              if (e.target.value === 'to') updateKeyframe(kf.id, { params: { target_position: params.target_position ?? { x: 0, y: 0 } } });
              else updateKeyframe(kf.id, { params: { delta: params.delta ?? { x: 1, y: 0 } } });
            }}>
              <option value="to">Move to point</option>
              <option value="by">Move by delta</option>
            </select>
          </label>
          {moveMode === 'to'
            ? <Vec label="Target (x, y)" value={params.target_position ?? { x: 0, y: 0 }} onChange={v => setParam({ target_position: v })} />
            : <Vec label="Delta (x, y)" value={params.delta ?? { x: 1, y: 0 }} onChange={v => setParam({ delta: v })} />}
        </>
      )}

      {verb === 'scale' && <Num label="Factor" value={Number(params.factor ?? 1.5)} step={0.1} onChange={v => setParam({ factor: v })} />}
      {verb === 'rotate' && <Num label="Angle (°)" value={Number(params.angle_degrees ?? 90)} step={5} onChange={v => setParam({ angle_degrees: v })} />}

      {verb === 'indicate' && (
        <>
          <Color label="Color" value={String(params.color ?? '#ffff00')} onChange={v => setParam({ color: v })} />
          <Num label="Scale factor" value={Number(params.scale_factor ?? 1.2)} step={0.1} onChange={v => setParam({ scale_factor: v })} />
        </>
      )}
      {verb === 'circumscribe' && <Color label="Color" value={String(params.color ?? '#ffff00')} onChange={v => setParam({ color: v })} />}
      {verb === 'flash' && (
        <>
          <Color label="Color" value={String(params.color ?? '#ffff00')} onChange={v => setParam({ color: v })} />
          <div className="field-row">
            <Num label="Radius" value={Number(params.flash_radius ?? 0.5)} step={0.1} onChange={v => setParam({ flash_radius: v })} />
            <Num label="Lines" value={Number(params.num_lines ?? 12)} step={1} onChange={v => setParam({ num_lines: Math.round(v) })} />
          </div>
        </>
      )}

      {(verb === 'transform' || verb === 'replacement_transform' || verb === 'morph_equation') && (
        <label className="field">
          <span className="field__label">Target object</span>
          <select className="field__input" value={String(params.target_object_id ?? '')} onChange={e => setParam({ target_object_id: e.target.value })}>
            <option value="">— pick target —</option>
            {otherObjects.map(o => <option key={o.id} value={o.id}>{o.name || o.type}</option>)}
          </select>
          {!params.target_object_id && <span className="kf-warn">Pick a target or this animation is skipped.</span>}
        </label>
      )}

      {verb === 'morph_equation' && (
        <MorphTools
          keyMap={(params.key_map as Record<string, string>) || {}}
          onChange={m => setParam({ key_map: m })}
          canPreview={!!params.target_object_id}
          keyframeId={kf.id}
        />
      )}

      <div className="field-row" style={{ marginTop: 6 }}>
        <button className="btn btn--ghost" onClick={() => clearKf()}>Done</button>
        <button className="btn btn--danger-ghost" onClick={() => { removeKeyframe(kf.id); clearKf(); }}>Delete</button>
      </div>
    </div>
  );
}
