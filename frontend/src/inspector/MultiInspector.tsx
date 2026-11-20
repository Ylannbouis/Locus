// The right sidebar when several objects are selected: arrange them (align /
// distribute) and edit what they share — stroke, fill / text colour, stroke
// width, fill opacity, font size, layer. Every edit applies to all the objects it
// makes sense for, as ONE undo step (`updateObjects`); a field whose values differ
// shows "mixed" until you set it.
import { useProjectStore } from '../store/projectStore';
import { objectBounds } from '../canvas/geometry';
import type { SceneObject } from '../types/ir';

const TEXT_LIKE = new Set(['latex_text', 'text', 'matrix', 'number']);
const CLOSED = new Set(['rectangle', 'circle', 'ellipse', 'polygon']);
const STROKED = new Set(['shape', 'coordinate_system', 'graph', 'geometry']);

const sub = (o: SceneObject) => String((o.props as Record<string, unknown>).subtype ?? '');
const isClosed = (o: SceneObject) => o.type === 'shape' && CLOSED.has(sub(o));
// Objects whose `position` really places them: graphs follow their axes, and
// angle / brace hang off the objects they reference.
const movable = (o: SceneObject) => o.type !== 'group' && o.type !== 'graph'
  && !(o.type === 'geometry' && (sub(o) === 'angle' || sub(o) === 'brace'));

const r2 = (n: number) => Math.round(n * 100) / 100;

// The shared value, or null when the objects disagree.
function shared<T>(vals: T[]): T | null {
  return vals.length && vals.every(v => v === vals[0]) ? vals[0] : null;
}

function MixedNumber({ label, value, step = 0.1, onChange }: {
  label: string; value: number | null; step?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}{value === null && <span className="multi-insp__mixed"> · mixed</span>}</span>
      <input className="field__input" type="number" step={step} placeholder="mixed"
        value={value === null ? '' : value}
        onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} />
    </label>
  );
}

function MixedColor({ label, value, fallback, onChange }: {
  label: string; value: string | null; fallback: string; onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}{value === null && <span className="multi-insp__mixed"> · mixed</span>}</span>
      <input className={`field__color${value === null ? ' field__color--mixed' : ''}`} type="color"
        value={value ?? fallback} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function MultiInspector({ objects }: { objects: SceneObject[] }) {
  const updateObjects = useProjectStore(s => s.updateObjects);
  const removeSelected = useProjectStore(s => s.removeSelected);
  const groupSelected = useProjectStore(s => s.groupSelected);
  const pasteKeyframes = useProjectStore(s => s.pasteKeyframes);
  const kfClipCount = useProjectStore(s => (s.lastCopy === 'keyframes' ? s.kfClipboard?.length ?? 0 : 0));

  const ids = objects.map(o => o.id);
  const key = (field: string) => `multi:${ids.join(',')}:${field}`;

  // ---- arrange --------------------------------------------------------------
  const arrangeable = objects.filter(movable);
  const boxes = arrangeable.map(o => ({ o, b: objectBounds(o) }));
  const moveBy = (moves: { o: SceneObject; dx: number; dy: number }[], what: string) => updateObjects(
    moves.filter(m => Math.abs(m.dx) > 1e-9 || Math.abs(m.dy) > 1e-9)
      .map(({ o, dx, dy }) => ({ id: o.id, patch: { position: { x: r2(o.position.x + dx), y: r2(o.position.y + dy) } } })),
    key(what),
  );

  const align = (k: AlignKind) => {
    const L = Math.min(...boxes.map(({ b }) => b.cx - b.hw)), R = Math.max(...boxes.map(({ b }) => b.cx + b.hw));
    const B = Math.min(...boxes.map(({ b }) => b.cy - b.hh)), T = Math.max(...boxes.map(({ b }) => b.cy + b.hh));
    moveBy(boxes.map(({ o, b }) => {
      switch (k) {
        case 'left': return { o, dx: L - (b.cx - b.hw), dy: 0 };
        case 'hcenter': return { o, dx: (L + R) / 2 - b.cx, dy: 0 };
        case 'right': return { o, dx: R - (b.cx + b.hw), dy: 0 };
        case 'top': return { o, dx: 0, dy: T - (b.cy + b.hh) };
        case 'vcenter': return { o, dx: 0, dy: (B + T) / 2 - b.cy };
        case 'bottom': return { o, dx: 0, dy: B - (b.cy - b.hh) };
      }
    }), `align-${k}`);
  };

  // Equal *gaps* between neighbours; the two outermost objects stay put.
  const distribute = (axis: 'x' | 'y') => {
    const lo = (b: ReturnType<typeof objectBounds>) => axis === 'x' ? b.cx - b.hw : b.cy - b.hh;
    const size = (b: ReturnType<typeof objectBounds>) => axis === 'x' ? 2 * b.hw : 2 * b.hh;
    const sorted = [...boxes].sort((a, c) => lo(a.b) - lo(c.b));
    const first = sorted[0].b, last = sorted[sorted.length - 1].b;
    const span = lo(last) + size(last) - lo(first);
    const gap = (span - sorted.reduce((s, { b }) => s + size(b), 0)) / (sorted.length - 1);
    let at = lo(first);
    moveBy(sorted.map(({ o, b }) => {
      const d = at - lo(b);
      at += size(b) + gap;
      return axis === 'x' ? { o, dx: d, dy: 0 } : { o, dx: 0, dy: d };
    }), `distribute-${axis}`);
  };

  // ---- shared style ---------------------------------------------------------
  const stroked = objects.filter(o => STROKED.has(o.type));
  const filled = objects.filter(o => isClosed(o) || TEXT_LIKE.has(o.type));
  const closed = objects.filter(isClosed);
  const texts = objects.filter(o => TEXT_LIKE.has(o.type));
  const layered = objects.filter(o => o.type !== 'group');

  const setStyle = (targets: SceneObject[], field: string, patchFor: (o: SceneObject) => Partial<SceneObject['style']>) =>
    updateObjects(targets.map(o => ({ id: o.id, patch: { style: { ...o.style, ...patchFor(o) } } })), key(field));

  const counts = objects.reduce<Record<string, number>>((m, o) => { m[o.type] = (m[o.type] ?? 0) + 1; return m; }, {});
  const summary = Object.entries(counts).map(([t, n]) => `${n} ${t.replace('_', ' ')}`).join(' · ');

  const alignBtn = (k: AlignKind, glyph: string, title: string) => (
    <button key={k} type="button" className="btn btn--ghost multi-insp__icon-btn" title={title} aria-label={title}
      disabled={boxes.length < 2} onClick={() => align(k)}>{glyph}</button>
  );

  return (
    <div className="inspector multi-insp">
      <h3 className="panel-title">{objects.length} objects selected</h3>
      <p className="panel-hint">{summary}</p>

      {kfClipCount > 0 && (
        <button type="button" className="btn btn--secondary inspector__paste-anim"
          title="Give every selected object the copied animation, starting at the playhead (Ctrl+V). Group the result and add a stagger for a cascade."
          onClick={() => pasteKeyframes(ids)}>
          ⧉ Paste animation onto all {objects.length}
        </button>
      )}

      <div className="field">
        <span className="field__label">Align</span>
        <div className="multi-insp__btns">
          {alignBtn('left', '⇤', 'Align left edges')}
          {alignBtn('hcenter', '↔', 'Align horizontal centres')}
          {alignBtn('right', '⇥', 'Align right edges')}
          {alignBtn('top', '⤒', 'Align top edges')}
          {alignBtn('vcenter', '↕', 'Align vertical centres')}
          {alignBtn('bottom', '⤓', 'Align bottom edges')}
        </div>
      </div>
      <div className="field">
        <span className="field__label">Distribute (equal gaps)</span>
        <div className="multi-insp__btns">
          <button type="button" className="btn btn--ghost" disabled={boxes.length < 3}
            title="Space horizontally with equal gaps (needs 3+)" onClick={() => distribute('x')}>⟷ Horizontally</button>
          <button type="button" className="btn btn--ghost" disabled={boxes.length < 3}
            title="Space vertically with equal gaps (needs 3+)" onClick={() => distribute('y')}>↕ Vertically</button>
        </div>
      </div>
      {arrangeable.length < objects.filter(o => o.type !== 'group').length && (
        <p className="panel-hint">Graphs, angles and braces follow the objects they're attached to, so arranging skips them.</p>
      )}

      {stroked.length > 0 && (
        <>
          <MixedColor label={`Stroke (${stroked.length})`} fallback="#ffffff"
            value={shared(stroked.map(o => String(o.style.stroke_color || '#ffffff').toLowerCase()))}
            onChange={v => setStyle(stroked, 'stroke', () => ({ stroke_color: v }))} />
          <MixedNumber label="Stroke width" step={0.5}
            value={shared(stroked.map(o => Number(o.style.stroke_width ?? 3)))}
            onChange={v => setStyle(stroked, 'stroke_width', () => ({ stroke_width: Math.max(0, v) }))} />
        </>
      )}
      {filled.length > 0 && (
        <MixedColor label={texts.length && closed.length ? `Fill / text colour (${filled.length})` : texts.length ? `Text colour (${filled.length})` : `Fill (${filled.length})`}
          fallback="#ffffff"
          value={shared(filled.map(o => String(o.style.fill_color || '#ffffff').toLowerCase()))}
          // Text renders in its fill colour at full opacity (as the single Inspector sets it).
          onChange={v => setStyle(filled, 'fill', o => (TEXT_LIKE.has(o.type) ? { fill_color: v, fill_opacity: 1 } : { fill_color: v }))} />
      )}
      {closed.length > 0 && (
        <MixedNumber label="Fill opacity" step={0.05}
          value={shared(closed.map(o => Number(o.style.fill_opacity ?? 0)))}
          onChange={v => setStyle(closed, 'fill_opacity', () => ({ fill_opacity: Math.max(0, Math.min(1, v)) }))} />
      )}
      {texts.length > 0 && (
        <MixedNumber label={`Font size (${texts.length})`} step={1}
          value={shared(texts.map(o => Number((o.props as Record<string, unknown>).font_size ?? 48)))}
          onChange={v => updateObjects(texts.map(o => ({
            id: o.id, patch: { props: { ...o.props, font_size: Math.max(1, Math.round(v)) } },
          })), key('font_size'))} />
      )}
      {layered.length > 0 && (
        <MixedNumber label="Layer (z)" step={1}
          value={shared(layered.map(o => o.z_index ?? 0))}
          onChange={v => updateObjects(layered.map(o => ({ id: o.id, patch: { z_index: Math.round(v) } })), key('z'))} />
      )}

      <div className="multi-insp__btns" style={{ marginTop: 6 }}>
        <button type="button" className="btn" onClick={groupSelected} title="Group (Ctrl+G)">Group</button>
        <button type="button" className="btn btn--danger-ghost" style={{ marginTop: 0 }} onClick={removeSelected}>
          Delete {objects.length}
        </button>
      </div>
    </div>
  );
}
