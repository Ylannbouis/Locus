// Shared world<->screen coordinate model for canvas + KaTeX overlay.
//
// World space: pixels, origin at the Manim origin, y already flipped (down+).
// Manim space: units, origin center, y up. Both the Konva Stage and the HTML
// overlay apply the same view transform (scale + offset), so they stay aligned.

export const PX_PER_UNIT = 80;

// Manim's default camera frame (16:9, frame_height = 8 units). The canvas draws
// this as a guide so what you compose matches what gets rendered.
export const FRAME_WIDTH = 14.2222;
export const FRAME_HEIGHT = 8;

// KaTeX em size (scene units per font_size point) calibrated so a KaTeX-rendered
// formula has the same *width* as Manim's. Measured: Manim renders
// "a^2+b^2=c^2" at 2.5688 units; KaTeX lays it out at 5.7741 em -> Manim packs
// 0.4449 units/em at font_size 48, i.e. 0.4449/48 per point. (Width is matched
// rather than glyph height because Manim's ink is horizontally tighter than
// KaTeX's advances, and overflowing a bounding box is the visible artifact.)
export const MANIM_EM_UNITS_PER_PT = 0.009268;

// Em size of Manim's Pango-backed `Text` (a `text` object with a `font` prop),
// which is a different scale from the LaTeX one above. Measured against
// monospace faces, whose advance width is an exact fraction of the em: at
// font_size 48 a 0.6-em-advance glyph steps 0.4 units, so 1 em = font_size/72
// units. The browser lays out the *same* system font file as Pango, so matching
// the em is enough to match the glyph advances — no width fudge needed.
export const MANIM_TEXT_EM_UNITS_PER_PT = 1 / 72;

// Manim Matrix() layout defaults (scene units, center-to-center). Manim places
// entries on a fixed-pitch grid independent of glyph width, so the canvas must
// replicate the pitch rather than use KaTeX's (much tighter) matrix spacing.
export const MATRIX_H_PITCH = 1.3; // h_buff
export const MATRIX_V_PITCH = 0.8; // v_buff
export const MATRIX_BRACKET_BUFF = 0.25; // gap from entries to bracket

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

// Snap distance (screen pixels) for pulling a dragged object onto a center line.
export const SNAP_PX = 8;
