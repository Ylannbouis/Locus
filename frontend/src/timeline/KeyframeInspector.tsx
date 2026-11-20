import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useRenderStore } from '../store/renderStore';
import { useTimelineStore, VERB_META, timelineVerbsFor, EASING_OPTIONS, defaultParams, CAMERA_ID } from './timelineStore';
import { transformAfter, RATE } from '../canvas/motion';
import type { AnimationVerb, EasingType, Point2D } from '../types/ir';

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

  // Local rows so a blank in-progress pair can exist before the "from" is typed
  // (the map can't key an empty string). Only non-empty rows serialize back.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(keyMap));
  useEffect(() => {
    const serialized: Record<string, string> = {};
    for (const [k, v] of rows) if (k) serialized[k] = v;
    if (JSON.stringify(serialized) !== JSON.stringify(keyMap)) setRows(Object.entries(keyMap));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyMap]);
  const commit = (next: [string, string][]) => {
    setRows(next);
    const o: Record<string, string> = {};
    for (const [k, v] of next) if (k) o[k] = v;
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
      {rows.map(([from, to], i) => (
        <div className="field-row" key={i} style={{ marginBottom: 4 }}>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, monospace' }} type="text" placeholder="from" value={from}
            onChange={e => commit(rows.map((r, j) => j === i ? [e.target.value, r[1]] : r))} />
          <span style={{ alignSelf: 'center' }}>→</span>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, monospace' }} type="text" placeholder="to" value={to}
            onChange={e => commit(rows.map((r, j) => j === i ? [r[0], e.target.value] : r))} />
          <button className="btn btn--ghost" onClick={() => commit(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn" onClick={() => setRows([...rows, ['', '']])}>+ pair</button>
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
  const updateAnimationGroup = useProjectStore(s => s.updateAnimationGroup);
  const copyKeyframes = useProjectStore(s => s.copyKeyframes);
  const kfClipCount = useProjectStore(s => (s.lastCopy === 'keyframes' ? s.kfClipboard?.length ?? 0 : 0));
  const ungroupKeyframes = useProjectStore(s => s.ungroupKeyframes);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);
  // Field selectors, not a whole-store destructure — the store's playhead
  // updates at 60fps during audio playback.
  const selectedKfIds = useTimelineStore(s => s.selectedKfIds);
  const clearKf = useTimelineStore(s => s.clearKf);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const kf = scene?.timeline.keyframes.find(k => k.id === selectedKfIds[0]);
  if (!scene || !kf) return null;

  const obj = scene.objects.find(o => o.id === kf.object_id);
  const params = (kf.params ?? {}) as Record<string, any>;
  // Typed / spun inputs: coalesce per keyframe + field so a burst is one undo step.
  const setParam = (patch: Record<string, any>) =>
    updateKeyframe(kf.id, { params: { ...params, ...patch } }, `kf:${kf.id}:params:${Object.keys(patch).join(',')}`);
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
            {timelineVerbsFor(obj).map(v => <option key={v} value={v}>{VERB_META[v].label}</option>)}
          </select>
        </label>
      )}

      <div className="field-row">
        <Num label="Start (s)" value={kf.start_time} onChange={v => updateKeyframe(kf.id, { start_time: Math.max(0, v) }, `kf:${kf.id}:start`)} />
        <Num label="Duration (s)" value={kf.duration} onChange={v => updateKeyframe(kf.id, { duration: Math.max(0.1, v) }, `kf:${kf.id}:duration`)} />
      </div>

      <label className="field">
        <span className="field__label">Easing</span>
        <select className="field__input" value={kf.easing} onChange={e => updateKeyframe(kf.id, { easing: e.target.value as EasingType })}>
          {EASING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <EasingPreview easing={kf.easing} />

      <div className="kf-copy">
        <button type="button" className="btn btn--ghost" onClick={() => copyKeyframes(selectedKfIds)}
          title="Copy (Ctrl+C), then select objects and paste (Ctrl+V) to give them this animation">
          ⧉ Copy animation{selectedKfIds.length > 1 ? `s (${selectedKfIds.length})` : ''}
        </button>
        {kfClipCount > 0 && <span className="panel-hint">Copied — select objects, then Ctrl+V.</span>}
      </div>

      {/* ---- animation group: parallel or staggered ---- */}
      {kf.group_id && (() => {
        const g = scene.timeline.groups.find(x => x.id === kf.group_id);
        if (!g) return null;
        const members = scene.timeline.keyframes.filter(k => k.group_id === g.id);
        const lag = Number(g.lag_ratio) || 0;
        const setLag = (v: number) => updateAnimationGroup(g.id,
          { lag_ratio: Math.max(0, Math.min(1, Math.round(v * 100) / 100)) }, `group:${g.id}:lag`);
        return (
          <div className="kf-group">
            <span className="field__label">Group · {members.length} animations</span>
            <label className="field">
              <span className="field__label">Stagger {lag > 0 ? `(each starts ${Math.round(lag * 100)}% into the previous)` : '(all together)'}</span>
              <div className="field-row">
                <input type="range" min={0} max={1} step={0.05} value={lag} onChange={e => setLag(parseFloat(e.target.value))} />
                <input className="field__input kf-group__num" type="number" min={0} max={1} step={0.05} value={lag}
                  onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setLag(v); }} />
              </div>
            </label>
            <span className="panel-hint">
              0 plays them in parallel, 1 one after another. Order follows the timeline; drag any member to move the whole group.
            </span>
            <button className="btn btn--ghost" onClick={() => ungroupKeyframes(members.map(k => k.id))}>Ungroup</button>
          </div>
        );
      })()}

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
      {verb === 'rotate' && (
        <>
          <Num label="Angle (°)" value={Number(params.angle_degrees ?? 90)} step={5} onChange={v => setParam({ angle_degrees: v })} />
          <label className="field">
            <span className="field__label">Pivot</span>
            <select className="field__input" value={params.about_point ? 'point' : 'center'} onChange={e => {
              if (e.target.value === 'center') { setParam({ about_point: undefined }); return; }
              // Start the custom pivot at the object's center as of this keyframe
              // (earlier moves included), i.e. where the ⊕ handle already sits.
              const c = transformAfter(scene, kf).before.pos;
              setParam({ about_point: { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 } });
            }}>
              <option value="center">Object center</option>
              <option value="point">Custom point</option>
            </select>
          </label>
          {params.about_point && (
            <>
              <Vec label="Pivot (x, y)" value={params.about_point as Point2D} onChange={v => setParam({ about_point: v })} />
              <span className="panel-hint">Drag the ⊕ handle on the canvas to place the pivot; drop it back on the object's center to reset.</span>
            </>
          )}
        </>
      )}

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
