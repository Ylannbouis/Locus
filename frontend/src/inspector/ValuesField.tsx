import { useState } from 'react';

// A comma-separated list of numbers (an Update's bar heights). Holds its own
// text while typing so a trailing comma or a half-typed "1." isn't reformatted
// away; re-syncs when a different keyframe (or an undo) changes the values.
export function ValuesField({ label, values, onChange }: { label: string; values: number[]; onChange: (v: number[]) => void }) {
  const fmt = (vs: number[]) => vs.map(v => String(Math.round(v * 1e4) / 1e4)).join(', ');
  const [text, setText] = useState(() => fmt(values));
  // Adjust-state-during-render (React's recommended alternative to an effect):
  // when the values change from outside and don't match what's typed, re-format.
  const key = values.join(',');
  const [syncedKey, setSyncedKey] = useState(key);
  if (key !== syncedKey) {
    setSyncedKey(key);
    if (text.split(',').map(x => parseFloat(x)).filter(Number.isFinite).join(',') !== key) setText(fmt(values));
  }
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <textarea className="field__textarea" rows={2} value={text} onChange={e => {
        setText(e.target.value);
        const vs = e.target.value.split(',').map(x => x.trim()).filter(x => x !== '').map(x => parseFloat(x));
        if (vs.every(Number.isFinite)) onChange(vs);
      }} />
    </label>
  );
}
