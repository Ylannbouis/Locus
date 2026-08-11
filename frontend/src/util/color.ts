// Small colour helpers shared by the canvas and the settings UI.

/** `#rgb` / `#rrggbb` → `[r, g, b]` (0–255), or null if it isn't a hex colour. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Relative luminance (WCAG), 0 = black … 1 = white. Unparseable colours read as
 * black, which is Manim's default background.
 */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Whether UI drawn *on* this colour should be dark rather than light. The 0.45
 * threshold sits above mid-grey so only genuinely bright backgrounds (white,
 * cream, pastels) flip — a dark chalkboard green keeps light overlays.
 */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.45;
}
