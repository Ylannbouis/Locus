import { useMemo, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { FontField } from './FontField';
import {
  defaultsByCategory, fieldValue, builtinValue,
  type DefaultField, type ObjectDefaultSpec,
} from '../store/objectDefaults';

/** Does this entry override anything at all? (drives the "edited" dot + Reset) */
function isOverridden(o: { style?: Record<string, unknown>; props?: Record<string, unknown> } | undefined): boolean {
  return !!o && (Object.keys(o.style ?? {}).length > 0 || Object.keys(o.props ?? {}).length > 0);
}

function FieldEditor({ spec, field, sample }: {
  spec: ObjectDefaultSpec;
  field: DefaultField;
  sample: ReturnType<ObjectDefaultSpec['sample']>;
}) {
  const overrides = useProjectStore(s => s.project?.settings.object_defaults?.[spec.key]);
  const setObjectDefault = useProjectStore(s => s.setObjectDefault);

  const value = fieldValue(sample, field, overrides);
  const set = (v: unknown) => setObjectDefault(spec.key, field.scope, field.key, v);
  // A field the factory never sets (e.g. corner_radius) has no built-in to show.
  const changed = overrides?.[field.scope]?.[field.key] !== undefined
    && overrides[field.scope][field.key] !== builtinValue(sample, field);

  if (field.kind === 'font') {
    // "LaTeX (default)" is the built-in, so choosing it clears the override
    // rather than pinning a redundant one (which would show a stale • dot).
    return (
      <FontField
        label={`${field.label}${changed ? ' •' : ''}`}
        value={typeof value === 'string' ? value : ''}
        onChange={v => set(v || undefined)}
      />
    );
  }

  if (field.kind === 'check') {
    return (
      <label className="field field--check">
        <input type="checkbox" checked={value === true} onChange={e => set(e.target.checked)} />
        <span className="field__label" style={{ margin: 0 }}>{field.label}{changed && ' •'}</span>
      </label>
    );
  }

  if (field.kind === 'color') {
    return (
      <label className="field">
        <span className="field__label">{field.label}{changed && ' •'}</span>
        <input className="field__color" type="color"
          value={typeof value === 'string' ? value : '#ffffff'}
          onChange={e => set(e.target.value)} />
      </label>
    );
  }

  return (
    <label className="field">
      <span className="field__label">{field.label}{changed && ' •'}</span>
      <input className="field__input" type="number"
        min={field.min} max={field.max} step={field.step ?? 1}
        value={typeof value === 'number' ? value : ''}
        placeholder="—"
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) set(v);
        }} />
    </label>
  );
}

export function ObjectDefaultsTab() {
  const cats = useMemo(() => defaultsByCategory(), []);
  const [selKey, setSelKey] = useState(cats[0].specs[0].key);
  const allDefaults = useProjectStore(s => s.project?.settings.object_defaults);
  const resetObjectDefault = useProjectStore(s => s.resetObjectDefault);
  const resetAllObjectDefaults = useProjectStore(s => s.resetAllObjectDefaults);

  const spec = cats.flatMap(c => c.specs).find(s => s.key === selKey)!;
  // One freshly built object per entry gives every field its built-in baseline.
  const sample = useMemo(() => spec.sample(), [spec]);
  const editedCount = Object.values(allDefaults ?? {}).filter(isOverridden).length;

  return (
    <div className="settings-section">
      <p className="panel-hint">
        What each Add Object button starts from. Changes apply to objects you add from now on —
        anything already in a scene keeps the properties it was created with.
      </p>

      <div className="objdef">
        <nav className="objdef__list" aria-label="Object types">
          {cats.map(c => (
            <div key={c.cat} className="objdef__group">
              <span className="add-panel__cat">{c.cat}</span>
              {c.specs.map(s => (
                <button key={s.key} type="button"
                  className={`objdef__item${s.key === selKey ? ' is-active' : ''}`}
                  aria-current={s.key === selKey}
                  onClick={() => setSelKey(s.key)}>
                  <span className="objdef__item-label">{s.label}</span>
                  {isOverridden(allDefaults?.[s.key]) && <span className="objdef__dot" title="Customised">•</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="objdef__pane">
          <div className="objdef__pane-head">
            <h4 className="objdef__pane-title">{spec.label}</h4>
            <button className="btn btn--ghost"
              disabled={!isOverridden(allDefaults?.[spec.key])}
              onClick={() => resetObjectDefault(spec.key)}>
              Reset to built-in
            </button>
          </div>
          <div className="objdef__fields">
            {spec.fields.map(f => (
              <FieldEditor key={`${f.scope}.${f.key}`} spec={spec} field={f} sample={sample} />
            ))}
          </div>
        </div>
      </div>

      <div className="objdef__foot">
        <span className="panel-hint">
          {editedCount === 0 ? 'All entries are at their built-in defaults.'
            : `${editedCount} ${editedCount === 1 ? 'entry is' : 'entries are'} customised.`}
        </span>
        <button className="btn" disabled={editedCount === 0} onClick={resetAllObjectDefaults}>
          Reset all
        </button>
      </div>
    </div>
  );
}
