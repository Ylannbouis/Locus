// UI theme: a per-browser preference (not part of the project IR), applied as
// <html data-theme="…"> — App.css defines both palettes as CSS tokens.
// `initTheme()` runs in main.tsx before React mounts, so there's no flash of
// the wrong theme on load.
import { useSyncExternalStore } from 'react';

export type Theme = 'chalkboard' | 'paper';
export const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: 'chalkboard', label: 'Chalkboard (dark)', icon: '☾' },
  { id: 'paper', label: 'Paper & Ink (light)', icon: '☀' },
];

const KEY = 'locus.theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'paper' || v === 'chalkboard' ? v : 'chalkboard';
  } catch {
    return 'chalkboard';
  }
}

let current: Theme = stored();

export function initTheme(): void {
  document.documentElement.dataset.theme = current;
}

export function setTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* private mode: session-only */ }
  listeners.forEach(l => l());
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
  return [t, setTheme];
}
