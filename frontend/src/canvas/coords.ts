// Shared world<->screen coordinate model for canvas + KaTeX overlay.
//
// World space: pixels, origin at the Manim origin, y already flipped (down+).
// Manim space: units, origin center, y up. Both the Konva Stage and the HTML
// overlay apply the same view transform (scale + offset), so they stay aligned.

export const PX_PER_UNIT = 80;

export interface View {
  scale: number;
  offsetX: number; // screen position (px) of world origin
  offsetY: number;
}

// Manim units -> world pixels
export const worldX = (manimX: number) => manimX * PX_PER_UNIT;
export const worldY = (manimY: number) => -manimY * PX_PER_UNIT;

// World pixels -> Manim units
export const manimX = (wx: number) => wx / PX_PER_UNIT;
export const manimY = (wy: number) => -wy / PX_PER_UNIT;

// Screen pixels -> world pixels (given the current view)
export const screenToWorld = (sx: number, sy: number, view: View) => ({
  x: (sx - view.offsetX) / view.scale,
  y: (sy - view.offsetY) / view.scale,
});

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 5;
