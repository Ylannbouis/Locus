// Registry backing the Settings → Object Defaults tab.
//
// One entry per Add-panel button, in the same order and with the same labels, so
// the settings list reads as a mirror of the panel it configures. Each entry
// names the properties worth defaulting; anything not listed here stays with the
// factory (subtypes, point geometry, tex content, …) and can't be overridden.
//
// `sample()` is the built-in factory output — the baseline a field falls back to
// when there's no override, and the target of "Reset to built-in".
import type { SceneObject } from '../types/ir';
import {
  createLatex, createText, createMatrix, createRectangle, createCircle, createEllipse,
  createPolygon, createLine, createArrow, createDoubleArrow, createDashedLine,
  createAxes, createNumberLine, createNumberPlane, createFunctionPlot,
  createParametric, createImplicit, createVectorField,
  createVector, createAngle, createBrace, createImage, createNumber, createHistogram,
} from './objectFactory';

// 'font' is the `text` object's system-font picker — empty means the LaTeX
// (`Tex`) path, anything else switches the codegen to Pango `Text`.
export type DefaultFieldKind = 'color' | 'number' | 'check' | 'font';

export interface DefaultField {
  scope: 'style' | 'props';
  key: string;
  label: string;
  kind: DefaultFieldKind;
  min?: number;
  max?: number;
  step?: number;
}

export interface ObjectDefaultSpec {
  key: string;   // the object_defaults key — stable, don't rename
  label: string; // matches the Add-panel button
  cat: string;   // matches the Add-panel group
  sample: () => SceneObject;
  fields: DefaultField[];
}

// --- reusable field specs ---------------------------------------------------
const strokeColor: DefaultField = { scope: 'style', key: 'stroke_color', label: 'Stroke', kind: 'color' };
const strokeWidth: DefaultField = { scope: 'style', key: 'stroke_width', label: 'Stroke width', kind: 'number', min: 0, max: 30, step: 0.5 };
const fillColor: DefaultField = { scope: 'style', key: 'fill_color', label: 'Fill', kind: 'color' };
const fillOpacity: DefaultField = { scope: 'style', key: 'fill_opacity', label: 'Fill opacity', kind: 'number', min: 0, max: 1, step: 0.05 };
const textColor: DefaultField = { scope: 'style', key: 'fill_color', label: 'Colour', kind: 'color' };
const fontSize: DefaultField = { scope: 'props', key: 'font_size', label: 'Font size', kind: 'number', min: 8, max: 200, step: 1 };
const num = (key: string, label: string, min: number, max: number, step = 0.1): DefaultField =>
  ({ scope: 'props', key, label, kind: 'number', min, max, step });

const outlined = [strokeColor, strokeWidth, fillColor, fillOpacity];
const stroked = [strokeColor, strokeWidth];

export const OBJECT_DEFAULTS: ObjectDefaultSpec[] = [
  // --- Text & Math ---
  { key: 'latex_text', label: '∑ Expression', cat: 'Text & Math', sample: createLatex, fields: [textColor, fontSize] },
  {
    key: 'text', label: 'T Text', cat: 'Text & Math', sample: createText,
    fields: [textColor, fontSize,
      { scope: 'props', key: 'font', label: 'Font', kind: 'font' },
      { scope: 'props', key: 'bold', label: 'Bold', kind: 'check' },
      { scope: 'props', key: 'italic', label: 'Italic', kind: 'check' }],
  },
  { key: 'matrix', label: '⊞ Matrix', cat: 'Text & Math', sample: createMatrix, fields: [textColor, fontSize] },
  {
    key: 'number', label: '# Number', cat: 'Text & Math', sample: createNumber,
    fields: [textColor, fontSize, num('decimals', 'Decimals', 0, 10, 1)],
  },

  // --- Shapes ---
  {
    key: 'rectangle', label: '▭ Rectangle', cat: 'Shapes', sample: createRectangle,
    fields: [...outlined, num('width', 'Width', 0.1, 30), num('height', 'Height', 0.1, 30),
      num('corner_radius', 'Corner radius', 0, 5, 0.05)],
  },
  { key: 'circle', label: '◯ Circle', cat: 'Shapes', sample: createCircle, fields: [...outlined, num('radius', 'Radius', 0.1, 15)] },
  {
    key: 'ellipse', label: '⬭ Ellipse', cat: 'Shapes', sample: createEllipse,
    fields: [...outlined, num('width', 'Width', 0.1, 30), num('height', 'Height', 0.1, 30)],
  },
  { key: 'polygon', label: '△ Polygon', cat: 'Shapes', sample: createPolygon, fields: outlined },
  { key: 'line', label: '╱ Line', cat: 'Shapes', sample: createLine, fields: stroked },
  { key: 'arrow', label: '→ Arrow', cat: 'Shapes', sample: createArrow, fields: [...stroked, num('tip_length', 'Tip length', 0.05, 2, 0.05)] },
  { key: 'double_arrow', label: '↔ Double Arrow', cat: 'Shapes', sample: createDoubleArrow, fields: stroked },
  {
    key: 'dashed_line', label: '┄ Dashed Line', cat: 'Shapes', sample: createDashedLine,
    fields: [...stroked, num('dash_length', 'Dash length', 0.02, 2, 0.01), num('dashed_ratio', 'Dashed ratio', 0.05, 1, 0.05)],
  },

  // --- Coordinates ---
  {
    key: 'axes', label: '✛ Axes', cat: 'Coordinates', sample: createAxes,
    fields: [...stroked, num('x_length', 'X length', 1, 20), num('y_length', 'Y length', 1, 20),
      { scope: 'props', key: 'include_numbers', label: 'Tick numbers', kind: 'check' }],
  },
  {
    key: 'number_line', label: '⊢ Number Line', cat: 'Coordinates', sample: createNumberLine,
    fields: [...stroked, num('length', 'Length', 1, 25),
      { scope: 'props', key: 'include_numbers', label: 'Tick numbers', kind: 'check' }],
  },
  {
    key: 'number_plane', label: '▦ Number Plane', cat: 'Coordinates', sample: createNumberPlane,
    fields: [...stroked, num('x_length', 'X length', 1, 25), num('y_length', 'Y length', 1, 25)],
  },

  // --- Graph ---
  { key: 'function_plot', label: '∿ Function Plot', cat: 'Graph', sample: () => createFunctionPlot(''), fields: stroked },
  { key: 'parametric', label: '⟳ Parametric', cat: 'Graph', sample: () => createParametric(''), fields: stroked },
  { key: 'implicit', label: '◔ Implicit', cat: 'Graph', sample: () => createImplicit(''), fields: stroked },
  { key: 'histogram', label: '▥ Histogram', cat: 'Graph', sample: () => createHistogram(''), fields: [...outlined, num('gap', 'Bar gap', 0, 0.9, 0.05)] },
  { key: 'vector_field', label: '⇶ Vector Field', cat: 'Graph', sample: createVectorField, fields: [strokeColor] },

  // --- Geometry ---
  { key: 'vector', label: '↗ Vector', cat: 'Geometry', sample: createVector, fields: stroked },
  { key: 'angle', label: '∠ Angle', cat: 'Geometry', sample: () => createAngle(), fields: [...stroked, num('radius', 'Radius', 0.1, 5, 0.05)] },
  { key: 'brace', label: '⏟ Brace', cat: 'Geometry', sample: () => createBrace(), fields: [strokeColor] },

  // --- Media ---
  // An image's height follows the file's aspect ratio, so only the width is
  // offered — `createImage` derives the height from whatever width applies.
  {
    key: 'image', label: '🖼 Image', cat: 'Media', sample: () => createImage('', 'Image', 4 / 3),
    fields: [num('width', 'Width', 0.1, 30), num('opacity', 'Opacity', 0, 1, 0.05)],
  },
];

export const SPEC_BY_KEY: Record<string, ObjectDefaultSpec> =
  Object.fromEntries(OBJECT_DEFAULTS.map(s => [s.key, s]));

/** Add-panel categories in panel order, each with its entries. */
export function defaultsByCategory(): { cat: string; specs: ObjectDefaultSpec[] }[] {
  const out: { cat: string; specs: ObjectDefaultSpec[] }[] = [];
  for (const spec of OBJECT_DEFAULTS) {
    const last = out[out.length - 1];
    if (last && last.cat === spec.cat) last.specs.push(spec);
    else out.push({ cat: spec.cat, specs: [spec] });
  }
  return out;
}

/** What a field reads on a freshly built object (no overrides applied). */
export function builtinValue(sample: SceneObject, field: DefaultField): unknown {
  const bag = (field.scope === 'style' ? sample.style : sample.props) as Record<string, unknown>;
  return bag?.[field.key];
}

/**
 * The value a field currently resolves to: the project's override if it sets one,
 * otherwise the factory's built-in. `undefined` when neither does (e.g. a
 * rectangle's `corner_radius`, which the factory leaves off entirely).
 */
export function fieldValue(
  sample: SceneObject,
  field: DefaultField,
  override: { style?: Record<string, unknown>; props?: Record<string, unknown> } | undefined,
): unknown {
  const fromOverride = override?.[field.scope]?.[field.key];
  return fromOverride !== undefined ? fromOverride : builtinValue(sample, field);
}
