import { THEMES, useTheme } from '../theme';

// Flips between the two UI themes (Chalkboard ↔ Paper & Ink). Shows the icon of
// the theme you'd switch *to*.
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = THEMES.find(t => t.id !== theme) ?? THEMES[0];
  return (
    <button type="button" className="btn btn--ghost theme-toggle"
      title={`Switch to ${next.label}`} aria-label={`Switch to ${next.label}`}
      onClick={() => setTheme(next.id)}>
      {next.icon}
    </button>
  );
}
