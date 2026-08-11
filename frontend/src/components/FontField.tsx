import { useEffect, useState } from 'react';
import { listFonts } from '../api/client';

// Installed system fonts, fetched once per session and shared by every picker
// (the backend scan is slow-ish and the list never changes while running).
let fontsCache: string[] | null = null;
let fontsPromise: Promise<string[]> | null = null;

/**
 * Font picker for `text` objects, used by the Inspector (one object) and by
 * Settings → Object Defaults (what new ones start as). The empty value keeps the
 * object on the LaTeX (`Tex`) path; any other value switches the codegen to
 * Pango `Text`.
 */
export function FontField({ value, label = 'Font', onChange }: {
  value: string;
  label?: string;
  onChange: (v: string) => void;
}) {
  const [fonts, setFonts] = useState<string[]>(fontsCache ?? []);
  useEffect(() => {
    if (fontsCache) return;
    let alive = true;
    fontsPromise = fontsPromise ?? listFonts().catch(() => [] as string[]);
    fontsPromise.then(f => { fontsCache = f; if (alive) setFonts(f); });
    return () => { alive = false; };
  }, []);
  // A project authored on another machine can name a font that isn't installed
  // here; keep it in the list so opening it doesn't silently reset the object.
  const options = value && !fonts.includes(value) ? [value, ...fonts] : fonts;
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="field__input" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">LaTeX (default)</option>
        {options.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
    </label>
  );
}
