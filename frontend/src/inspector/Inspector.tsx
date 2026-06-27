import { useProjectStore } from '../store/projectStore';
import type { SceneObject, Point2D } from '../types/ir';

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
            <label className="field field--check">
              <input type="checkbox" checked={!!props.include_numbers} onChange={e => setProp({ include_numbers: e.target.checked })} />
              <span>Show numbers</span>
            </label>
          )}
          <ColorField label="Color" value={(obj.style.stroke_color as string) || '#ffffff'} onChange={v => setStyle({ stroke_color: v })} />
        </>
      )}

      {/* ---- Graph / function plot ---- */}
      {obj.type === 'graph' && (
        <>
          <label className="field">
            <span className="field__label">Axes</span>
            <select className="field__input" value={String(props.axes_ref ?? '')} onChange={e => setProp({ axes_ref: e.target.value })}>
              <option value="">— pick axes —</option>
              {axesList.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </label>
          <TextField label="f(x) =" value={String(props.expression ?? 'sin(x)')} mono onChange={v => setProp({ expression: v })} />
          <RangeField label="X range" value={(props.x_range as number[]) || [-4, 4]} step={false} onChange={v => setProp({ x_range: v })} />
          <ColorField label="Color" value={(obj.style.stroke_color as string) || '#58c4dd'} onChange={v => setStyle({ stroke_color: v })} />
          <NumberField label="Stroke width" value={Number(obj.style.stroke_width ?? 4)} step={0.5} onChange={v => setStyle({ stroke_width: v })} />
        </>
      )}

      <button className="btn btn--danger-ghost inspector__delete" onClick={() => removeObject(obj.id)}>Delete object</button>
    </div>
  );
}

// --- sub-editors -----------------------------------------------------------

function ColorMapEditor({ map, onChange }: { map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const entries = Object.entries(map);
  const rebuild = (list: [string, string][]) => {
    const o: Record<string, string> = {};
    for (const [k, v] of list) if (k) o[k] = v;
    onChange(o);
  };
  return (
    <div className="field">
      <span className="field__label">Term colors</span>
      {entries.map(([term, color], i) => (
        <div className="field-row" key={i} style={{ marginBottom: 4 }}>
          <input className="field__input" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }} type="text" value={term}
            onChange={e => { const list = [...entries] as [string, string][]; list[i] = [e.target.value, color]; rebuild(list); }} />
          <input className="field__color" type="color" value={color}
            onChange={e => { const list = [...entries] as [string, string][]; list[i] = [term, e.target.value]; rebuild(list); }} />
          <button className="btn btn--ghost" onClick={() => rebuild(entries.filter((_, j) => j !== i) as [string, string][])}>✕</button>
        </div>
      ))}
      <button className="btn" onClick={() => rebuild([...entries as [string, string][], ['', '#ffff00']])}>+ term</button>
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
