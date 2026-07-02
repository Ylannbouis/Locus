import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newId } from '../store/objectFactory';
import type { SceneObject, Point2D, Scene, Relationship, RelationshipType } from '../types/ir';

function NumberField({ label, value, step = 0.1, onChange }: {
  label: string; value: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
      />
    </label>
  );
}

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="field__color" type="color" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function TextField({ label, value, onChange, mono }: {
  label: string; value: string; onChange: (v: string) => void; mono?: boolean;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="field__input" style={mono ? { fontFamily: 'ui-monospace, Consolas, monospace' } : undefined}
        type="text" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function Vec2Field({ label, value, onChange }: {
  label: string; value: Point2D; onChange: (v: Point2D) => void;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="field-row">
        <input className="field__input" type="number" step={0.1} value={value?.x ?? 0}
          onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange({ x: v, y: value?.y ?? 0 }); }} />
        <input className="field__input" type="number" step={0.1} value={value?.y ?? 0}
          onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange({ x: value?.x ?? 0, y: v }); }} />
      </div>
    </div>
  );
}

function RangeField({ label, value, step = true, onChange }: {
  label: string; value: number[]; step?: boolean; onChange: (v: number[]) => void;
}) {
  const v = value && value.length >= 2 ? value : [-5, 5, 1];
  const set = (i: number, n: number) => { const next = [...v]; next[i] = n; onChange(next); };
  return (
    <div className="field">
      <span className="field__label">{label} (min, max{step ? ', step' : ''})</span>
      <div className="field-row">
        <input className="field__input" type="number" step={0.5} value={v[0]} onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(0, n); }} />
        <input className="field__input" type="number" step={0.5} value={v[1]} onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(1, n); }} />
        {step && <input className="field__input" type="number" step={0.5} value={v[2] ?? 1} onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(2, n); }} />}
      </div>
    </div>
  );
}

export function Inspector() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const updateObject = useProjectStore(s => s.updateObject);
  const removeObject = useProjectStore(s => s.removeObject);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const obj = scene?.objects.find(o => o.id === selectedIds[0]);

  if (!obj) {
    return (
      <div className="inspector">
        <h3 className="panel-title">Properties</h3>
        <p className="panel-hint">Select an object to edit its properties.</p>
      </div>
    );
  }

  const props = obj.props as Record<string, any>;
  const setProp = (patch: Record<string, any>) => updateObject(obj.id, { props: { ...props, ...patch } });
  const setStyle = (patch: Partial<SceneObject['style']>) => updateObject(obj.id, { style: { ...obj.style, ...patch } });
  const setPos = (patch: { x?: number; y?: number }) => updateObject(obj.id, { position: { ...obj.position, ...patch } });

  const subtype = props.subtype as string | undefined;
  const isClosedShape = obj.type === 'shape' && ['rectangle', 'circle', 'ellipse', 'polygon'].includes(subtype || '');
  const isOpenShape = obj.type === 'shape' && ['line', 'arrow', 'double_arrow', 'dashed_line'].includes(subtype || '');
  const axesList = (scene?.objects ?? []).filter(o => o.type === 'coordinate_system');

  return (
    <div className="inspector">
      <h3 className="panel-title">Properties</h3>

      <TextField label="Name" value={obj.name} onChange={v => updateObject(obj.id, { name: v })} />

      <div className="field-row">
        <NumberField label="X" value={obj.position.x} onChange={v => setPos({ x: v })} />
        <NumberField label="Y" value={obj.position.y} onChange={v => setPos({ y: v })} />
      </div>
      <NumberField label="Layer (z)" value={obj.z_index} step={1} onChange={v => updateObject(obj.id, { z_index: Math.round(v) })} />

      {/* ---- LaTeX ---- */}
      {obj.type === 'latex_text' && (
        <>
          <label className="field">
            <span className="field__label">LaTeX</span>
            <textarea className="field__textarea" rows={3} value={String(props.tex_string ?? '')}
              onChange={e => setProp({ tex_string: e.target.value })} />
          </label>
          <NumberField label="Font size" value={Number(props.font_size ?? 48)} step={1} onChange={v => setProp({ font_size: Math.round(v) })} />
          <ColorField label="Color" value={(obj.style.fill_color as string) || '#ffffff'} onChange={v => setStyle({ fill_color: v, fill_opacity: 1 })} />
          <ColorMapEditor map={(props.color_map as Record<string, string>) || {}} onChange={m => setProp({ color_map: m })} />
        </>
      )}

      {/* ---- Matrix ---- */}
      {obj.type === 'matrix' && (
        <>
          <MatrixEditor entries={(props.entries as string[][]) || [['1', '0'], ['0', '1']]} onChange={e => setProp({ entries: e })} />
          <ColorField label="Color" value={(obj.style.fill_color as string) || '#ffffff'} onChange={v => setStyle({ fill_color: v, fill_opacity: 1 })} />
        </>
      )}

      {/* ---- Closed shapes sizing ---- */}
      {obj.type === 'shape' && (subtype === 'rectangle' || subtype === 'ellipse') && (
        <div className="field-row">
          <NumberField label="Width" value={Number(props.width ?? 2)} onChange={v => setProp({ width: v })} />
          <NumberField label="Height" value={Number(props.height ?? 1.2)} onChange={v => setProp({ height: v })} />
        </div>
      )}
      {obj.type === 'shape' && subtype === 'circle' && (
        <NumberField label="Radius" value={Number(props.radius ?? 1)} onChange={v => setProp({ radius: v })} />
      )}
      {obj.type === 'shape' && subtype === 'polygon' && (
        <VerticesEditor vertices={(props.vertices as Point2D[]) || []} onChange={vs => setProp({ vertices: vs })} />
      )}

      {/* ---- Open shapes (endpoints) ---- */}
      {isOpenShape && (
        <>
          <Vec2Field label="Start" value={props.start_point as Point2D} onChange={v => setProp({ start_point: v })} />
          <Vec2Field label="End" value={props.end_point as Point2D} onChange={v => setProp({ end_point: v })} />
          {subtype === 'arrow' && <NumberField label="Tip length" value={Number(props.tip_length ?? 0.3)} step={0.05} onChange={v => setProp({ tip_length: v })} />}
          {subtype === 'dashed_line' && (
            <div className="field-row">
              <NumberField label="Dash len" value={Number(props.dash_length ?? 0.15)} step={0.05} onChange={v => setProp({ dash_length: v })} />
              <NumberField label="Dash ratio" value={Number(props.dashed_ratio ?? 0.5)} step={0.05} onChange={v => setProp({ dashed_ratio: v })} />
            </div>
          )}
        </>
      )}

      {/* ---- Shape styling ---- */}
      {obj.type === 'shape' && (
        <>
          <ColorField label="Stroke" value={(obj.style.stroke_color as string) || '#ffffff'} onChange={v => setStyle({ stroke_color: v })} />
          <NumberField label="Stroke width" value={Number(obj.style.stroke_width ?? 3)} step={0.5} onChange={v => setStyle({ stroke_width: v })} />
          {isClosedShape && (
            <>
              <ColorField label="Fill" value={(obj.style.fill_color as string) || '#2563eb'} onChange={v => setStyle({ fill_color: v })} />
              <NumberField label="Fill opacity" value={Number(obj.style.fill_opacity ?? 0)} step={0.05} onChange={v => setStyle({ fill_opacity: Math.max(0, Math.min(1, v)) })} />
            </>
          )}
        </>
      )}

      {/* ---- Coordinate systems ---- */}
      {obj.type === 'coordinate_system' && (
        <>
          <RangeField label="X range" value={props.x_range as number[]} onChange={v => setProp({ x_range: v })} />
          {subtype !== 'number_line' && <RangeField label="Y range" value={props.y_range as number[]} onChange={v => setProp({ y_range: v })} />}
          {subtype === 'number_line'
            ? <NumberField label="Length" value={Number(props.length ?? 8)} onChange={v => setProp({ length: v })} />
            : (
              <div className="field-row">
                <NumberField label="X length" value={Number(props.x_length ?? 6)} onChange={v => setProp({ x_length: v })} />
                <NumberField label="Y length" value={Number(props.y_length ?? 4)} onChange={v => setProp({ y_length: v })} />
              </div>
            )}
          {subtype !== 'number_plane' && (
            <>
              <label className="field field--check">
                <input type="checkbox" checked={!!props.include_numbers} onChange={e => setProp({ include_numbers: e.target.checked })} />
                <span>Show numbers</span>
              </label>
              {props.include_numbers && (
                <NumberField label="Number size" value={Number(props.number_font_size ?? 36)} step={1}
                  onChange={v => setProp({ number_font_size: Math.max(1, Math.round(v)) })} />
              )}
            </>
          )}
          {subtype === 'axes' && (
            <>
              <label className="field field--check">
                <input type="checkbox" checked={!!props.tips} onChange={e => setProp({ tips: e.target.checked })} />
                <span>Axis arrows</span>
              </label>
              <div className="field-row">
                <TextField label="X axis label" value={String(props.x_axis_label ?? '')} mono onChange={v => setProp({ x_axis_label: v })} />
                <TextField label="Y axis label" value={String(props.y_axis_label ?? '')} mono onChange={v => setProp({ y_axis_label: v })} />
              </div>
            </>
          )}
          <ColorField label="Color" value={(obj.style.stroke_color as string) || '#ffffff'} onChange={v => setStyle({ stroke_color: v })} />
        </>
      )}

      {/* ---- Graph (function plot / parametric / implicit / vector field) ---- */}
      {obj.type === 'graph' && (
        <>
          {subtype !== 'vector_field' && (
            <label className="field">
              <span className="field__label">Axes</span>
              <select className="field__input" value={String(props.axes_ref ?? '')} onChange={e => setProp({ axes_ref: e.target.value })}>
                <option value="">— pick axes —</option>
                {axesList.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </label>
          )}

          {subtype === 'function_plot' && (
            <>
              <TextField label="f(x) =" value={String(props.expression ?? 'sin(x)')} mono onChange={v => setProp({ expression: v })} />
              <RangeField label="X range" value={(props.x_range as number[]) || [-4, 4]} step={false} onChange={v => setProp({ x_range: v })} />
              <SweepEditor props={props} setProp={setProp} />
            </>
          )}

          {subtype === 'parametric' && (
            <>
              <TextField label="x(t) =" value={String(props.x_expression ?? 'cos(t)')} mono onChange={v => setProp({ x_expression: v })} />
              <TextField label="y(t) =" value={String(props.y_expression ?? 'sin(2*t)')} mono onChange={v => setProp({ y_expression: v })} />
              <RangeField label="t range" value={(props.t_range as number[]) || [0, 6.2832, 0.05]} onChange={v => setProp({ t_range: v })} />
            </>
          )}

          {subtype === 'implicit' && (
            <>
              <TextField label="F(x, y) = 0" value={String(props.expression ?? 'x**2 + y**2 - 4')} mono onChange={v => setProp({ expression: v })} />
              <p className="panel-hint">Curve where the expression equals zero (no canvas preview).</p>
            </>
          )}

          {subtype === 'vector_field' && (
            <>
              <TextField label="dx/dt (x, y) =" value={String(props.x_func ?? '-y')} mono onChange={v => setProp({ x_func: v })} />
              <TextField label="dy/dt (x, y) =" value={String(props.y_func ?? 'x')} mono onChange={v => setProp({ y_func: v })} />
              <RangeField label="X range" value={(props.x_range as number[]) || [-5, 5, 1]} onChange={v => setProp({ x_range: v })} />
              <RangeField label="Y range" value={(props.y_range as number[]) || [-3, 3, 1]} onChange={v => setProp({ y_range: v })} />
              <p className="panel-hint">Arrows are colored by magnitude automatically.</p>
            </>
          )}

          {subtype !== 'vector_field' && (
            <>
              <ColorField label="Color" value={(obj.style.stroke_color as string) || '#58c4dd'} onChange={v => setStyle({ stroke_color: v })} />
              <NumberField label="Stroke width" value={Number(obj.style.stroke_width ?? 4)} step={0.5} onChange={v => setStyle({ stroke_width: v })} />
            </>
          )}
        </>
      )}

      {/* ---- Geometry (vector / angle / brace) ---- */}
      {obj.type === 'geometry' && (
        <>
          {subtype === 'vector' && (
            <>
              <Vec2Field label="Direction" value={props.direction as Point2D} onChange={v => setProp({ direction: v })} />
              <TextField label="Label (LaTeX)" value={String(props.label ?? '')} mono onChange={v => setProp({ label: v })} />
            </>
          )}
          {subtype === 'angle' && (
            <>
              <ObjectPicker label="Line 1" scene={scene!} value={String(props.line1_id ?? '')} filter={o => o.type === 'shape'} exclude={obj.id} onChange={v => setProp({ line1_id: v })} />
              <ObjectPicker label="Line 2" scene={scene!} value={String(props.line2_id ?? '')} filter={o => o.type === 'shape'} exclude={obj.id} onChange={v => setProp({ line2_id: v })} />
              <NumberField label="Radius" value={Number(props.radius ?? 0.6)} step={0.1} onChange={v => setProp({ radius: v })} />
            </>
          )}
          {subtype === 'brace' && (
            <>
              <ObjectPicker label="Target" scene={scene!} value={String(props.target_id ?? '')} filter={o => o.type !== 'geometry'} exclude={obj.id} onChange={v => setProp({ target_id: v })} />
              <label className="field">
                <span className="field__label">Direction</span>
                <select className="field__input" value={String(props.direction_str ?? 'DOWN')} onChange={e => setProp({ direction_str: e.target.value })}>
                  {['UP', 'DOWN', 'LEFT', 'RIGHT'].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <TextField label="Label" value={String(props.label ?? '')} onChange={v => setProp({ label: v })} />
            </>
          )}
          <ColorField label="Color" value={(obj.style.stroke_color as string) || '#ffffff'} onChange={v => setStyle({ stroke_color: v })} />
        </>
      )}

      <div className="sidebar-divider" />
      <RelationshipEditor objId={obj.id} scene={scene!} />

      <button className="btn btn--danger-ghost inspector__delete" onClick={() => removeObject(obj.id)}>Delete object</button>
    </div>
  );
}

// --- parameter sweep (ValueTracker) ---------------------------------------

function SweepEditor({ props, setProp }: { props: Record<string, any>; setProp: (p: Record<string, any>) => void }) {
  const sweep = (props.sweep as Record<string, any>) || {};
  const set = (patch: Record<string, any>) => setProp({ sweep: { ...sweep, ...patch } });
  const num = (k: string, v: number) => set({ [k]: v });
  return (
    <div className="field">
      <label className="field field--check" style={{ marginBottom: sweep.enabled ? 6 : 0 }}>
        <input type="checkbox" checked={!!sweep.enabled} onChange={e => set({ enabled: e.target.checked, param: sweep.param ?? 'a', from: sweep.from ?? 0, to: sweep.to ?? 6.2832, start_time: sweep.start_time ?? 0, duration: sweep.duration ?? 3 })} />
        <span>Animate a parameter</span>
      </label>
      {sweep.enabled && (
        <>
          <p className="panel-hint" style={{ margin: '0 0 4px' }}>Use the parameter name in f(x), e.g. <code>sin(x + a)</code>.</p>
          <div className="field-row">
            <label className="field"><span className="field__label">Param</span>
              <input className="field__input" style={{ fontFamily: 'ui-monospace, monospace' }} type="text" value={String(sweep.param ?? 'a')} onChange={e => set({ param: e.target.value })} /></label>
            <label className="field"><span className="field__label">From</span>
              <input className="field__input" type="number" step={0.1} value={Number(sweep.from ?? 0)} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) num('from', v); }} /></label>
            <label className="field"><span className="field__label">To</span>
              <input className="field__input" type="number" step={0.1} value={Number(sweep.to ?? 6.2832)} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) num('to', v); }} /></label>
          </div>
          <div className="field-row">
            <label className="field"><span className="field__label">Start (s)</span>
              <input className="field__input" type="number" step={0.1} value={Number(sweep.start_time ?? 0)} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) num('start_time', Math.max(0, v)); }} /></label>
            <label className="field"><span className="field__label">Duration (s)</span>
              <input className="field__input" type="number" step={0.1} value={Number(sweep.duration ?? 3)} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) num('duration', Math.max(0.1, v)); }} /></label>
          </div>
        </>
      )}
    </div>
  );
}

function ObjectPicker({ label, scene, value, filter, exclude, onChange }: {
  label: string; scene: Scene; value: string; filter: (o: SceneObject) => boolean; exclude: string; onChange: (v: string) => void;
}) {
  const opts = scene.objects.filter(o => o.id !== exclude && filter(o));
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="field__input" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— pick —</option>
        {opts.map(o => <option key={o.id} value={o.id}>{o.name || o.type}</option>)}
      </select>
    </label>
  );
}

// --- relative positioning --------------------------------------------------

const REL_TYPES: { value: RelationshipType; label: string }[] = [
  { value: 'next_to', label: 'Next to' },
  { value: 'align_to', label: 'Align to' },
  { value: 'center_on', label: 'Center on' },
  { value: 'move_to_point', label: 'Move to point' },
];
const DIRECTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'UL', 'UR', 'DL', 'DR'];

function RelationshipEditor({ objId, scene }: { objId: string; scene: Scene }) {
  const addRelationship = useProjectStore(s => s.addRelationship);
  const updateRelationship = useProjectStore(s => s.updateRelationship);
  const removeRelationship = useProjectStore(s => s.removeRelationship);

  const rels = scene.relationships.filter(r => r.subject_id === objId);
  const others = scene.objects.filter(o => o.id !== objId);

  const add = () => {
    const rel: Relationship = {
      id: newId('rel'), type: 'next_to', subject_id: objId,
      anchor_id: others[0]?.id ?? '', direction: 'RIGHT', buff: 0.5, target_point: null,
    };
    addRelationship(rel);
  };

  return (
    <div className="field">
      <span className="field__label">Relative positioning</span>
      {rels.length === 0 && <p className="panel-hint" style={{ margin: '2px 0' }}>None. Position is absolute.</p>}
      {rels.map(r => (
        <div key={r.id} className="rel-row">
          <select className="field__input" value={r.type} onChange={e => updateRelationship(r.id, { type: e.target.value as RelationshipType })}>
            {REL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {r.type !== 'move_to_point' && (
            <select className="field__input" value={r.anchor_id} onChange={e => updateRelationship(r.id, { anchor_id: e.target.value })}>
              <option value="">— anchor —</option>
              {others.map(o => <option key={o.id} value={o.id}>{o.name || o.type}</option>)}
            </select>
          )}
          {(r.type === 'next_to' || r.type === 'align_to') && (
            <select className="field__input" value={r.direction} onChange={e => updateRelationship(r.id, { direction: e.target.value })}>
              {DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {r.type === 'next_to' && (
            <input className="field__input" type="number" step={0.1} value={r.buff}
              title="buffer" onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) updateRelationship(r.id, { buff: v }); }} />
          )}
          {r.type === 'move_to_point' && (
            <div className="field-row" style={{ flex: 1 }}>
              <input className="field__input" type="number" step={0.1} value={r.target_point?.x ?? 0}
                onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) updateRelationship(r.id, { target_point: { x: v, y: r.target_point?.y ?? 0 } }); }} />
              <input className="field__input" type="number" step={0.1} value={r.target_point?.y ?? 0}
                onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) updateRelationship(r.id, { target_point: { x: r.target_point?.x ?? 0, y: v } }); }} />
            </div>
          )}
          <button className="btn btn--ghost" title="Remove" onClick={() => removeRelationship(r.id)}>✕</button>
        </div>
      ))}
      <button className="btn" disabled={others.length === 0} onClick={add} style={{ marginTop: 4 }}>+ relationship</button>
    </div>
  );
}

// --- sub-editors -----------------------------------------------------------

function ColorMapEditor({ map, onChange }: { map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  // Local rows so an in-progress blank term can exist before it's typed (the map
  // can't hold an empty key). Only non-empty rows are serialized back to the map.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(map));

  // Resync when the map changes from outside this editor (object switch / undo).
  useEffect(() => {
    const serialized: Record<string, string> = {};
    for (const [k, v] of rows) if (k) serialized[k] = v;
    if (JSON.stringify(serialized) !== JSON.stringify(map)) setRows(Object.entries(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const commit = (next: [string, string][]) => {
    setRows(next);
    const o: Record<string, string> = {};
    for (const [k, v] of next) if (k) o[k] = v;
    onChange(o);
  };

  return (
    <div className="field">
      <span className="field__label">Term colors</span>
      {rows.map(([term, color], i) => (
        <div className="field-row" key={i} style={{ marginBottom: 4 }}>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }} type="text" value={term}
            placeholder="TeX substring" onChange={e => commit(rows.map((r, j) => j === i ? [e.target.value, r[1]] : r))} />
          <input className="field__color" type="color" value={color}
            onChange={e => commit(rows.map((r, j) => j === i ? [r[0], e.target.value] : r))} />
          <button className="btn btn--ghost" onClick={() => commit(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {/* Add a blank row locally; it serializes to the map once a term is typed. */}
      <button className="btn" onClick={() => setRows([...rows, ['', '#ffff00']])}>+ term</button>
    </div>
  );
}

function VerticesEditor({ vertices, onChange }: { vertices: Point2D[]; onChange: (v: Point2D[]) => void }) {
  return (
    <div className="field">
      <span className="field__label">Vertices</span>
      {vertices.map((vtx, i) => (
        <div className="field-row" key={i} style={{ marginBottom: 4 }}>
          <input className="field__input" type="number" step={0.1} value={vtx.x}
            onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) { const next = [...vertices]; next[i] = { x: n, y: vtx.y }; onChange(next); } }} />
          <input className="field__input" type="number" step={0.1} value={vtx.y}
            onChange={e => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) { const next = [...vertices]; next[i] = { x: vtx.x, y: n }; onChange(next); } }} />
          <button className="btn btn--ghost" disabled={vertices.length <= 3} onClick={() => onChange(vertices.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn" onClick={() => onChange([...vertices, { x: 0, y: 0 }])}>+ vertex</button>
    </div>
  );
}

function MatrixEditor({ entries, onChange }: { entries: string[][]; onChange: (e: string[][]) => void }) {
  const rows = entries.length;
  const cols = entries[0]?.length ?? 0;
  const setCell = (r: number, c: number, val: string) => {
    const next = entries.map(row => [...row]);
    next[r][c] = val;
    onChange(next);
  };
  const addRow = () => onChange([...entries, Array(cols).fill('0')]);
  const addCol = () => onChange(entries.map(row => [...row, '0']));
  const delRow = () => rows > 1 && onChange(entries.slice(0, -1));
  const delCol = () => cols > 1 && onChange(entries.map(row => row.slice(0, -1)));
  return (
    <div className="field">
      <span className="field__label">Entries ({rows}×{cols})</span>
      <div className="matrix-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {entries.map((row, r) => row.map((cell, c) => (
          <input key={`${r}-${c}`} className="field__input" type="text" value={cell} onChange={e => setCell(r, c, e.target.value)} />
        )))}
      </div>
      <div className="field-row" style={{ marginTop: 6 }}>
        <button className="btn" onClick={addRow}>+ row</button>
        <button className="btn" onClick={delRow} disabled={rows <= 1}>− row</button>
        <button className="btn" onClick={addCol}>+ col</button>
        <button className="btn" onClick={delCol} disabled={cols <= 1}>− col</button>
      </div>
    </div>
  );
}
