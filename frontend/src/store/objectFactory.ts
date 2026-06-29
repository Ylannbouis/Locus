import type { SceneObject } from '../types/ir';

export function newId(prefix = 'obj'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function base(partial: Partial<SceneObject>): SceneObject {
  return {
    id: newId(),
    type: 'shape',
    name: '',
    position: { x: 0, y: 0 },
    anchor: 'center',
    z_index: 0,
    style_ref: null,
    style: {},
    props: {},
    parent_id: null,
    visible: true,
    ...partial,
  };
}

// --- Text / matrix ---------------------------------------------------------
export function createLatex(): SceneObject {
  return base({
    type: 'latex_text', name: 'Equation',
    style: { fill_color: '#ffffff', fill_opacity: 1 },
    props: { tex_string: 'x^2 + y^2 = r^2', font_size: 48, use_mathtex: true, color_map: {} },
  });
}

export function createMatrix(): SceneObject {
  return base({
    type: 'matrix', name: 'Matrix',
    style: { fill_color: '#ffffff', fill_opacity: 1 },
    props: { entries: [['1', '0'], ['0', '1']], left_bracket: '[', right_bracket: ']' },
  });
}

// --- Closed shapes ---------------------------------------------------------
export function createRectangle(): SceneObject {
  return base({
    type: 'shape', name: 'Rectangle',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1, fill_color: '#2563eb', fill_opacity: 0 },
    props: { subtype: 'rectangle', width: 2, height: 1.2 },
  });
}

export function createCircle(): SceneObject {
  return base({
    type: 'shape', name: 'Circle',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1, fill_color: '#22c55e', fill_opacity: 0 },
    props: { subtype: 'circle', radius: 1 },
  });
}

export function createEllipse(): SceneObject {
  return base({
    type: 'shape', name: 'Ellipse',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1, fill_color: '#a855f7', fill_opacity: 0 },
    props: { subtype: 'ellipse', width: 2.4, height: 1.4 },
  });
}

export function createPolygon(): SceneObject {
  return base({
    type: 'shape', name: 'Triangle',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1, fill_color: '#f59e0b', fill_opacity: 0 },
    props: { subtype: 'polygon', vertices: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 }] },
  });
}

// --- Open shapes (points are local; position translates) -------------------
export function createLine(): SceneObject {
  return base({
    type: 'shape', name: 'Line',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1 },
    props: { subtype: 'line', start_point: { x: -1.5, y: 0 }, end_point: { x: 1.5, y: 0 } },
  });
}

export function createArrow(): SceneObject {
  return base({
    type: 'shape', name: 'Arrow',
    style: { stroke_color: '#ffffff', stroke_width: 4, stroke_opacity: 1 },
    props: { subtype: 'arrow', start_point: { x: -1.5, y: 0 }, end_point: { x: 1.5, y: 0 }, tip_length: 0.3 },
  });
}

export function createDoubleArrow(): SceneObject {
  return base({
    type: 'shape', name: 'Double Arrow',
    style: { stroke_color: '#ffffff', stroke_width: 4, stroke_opacity: 1 },
    props: { subtype: 'double_arrow', start_point: { x: -1.5, y: 0 }, end_point: { x: 1.5, y: 0 } },
  });
}

export function createDashedLine(): SceneObject {
  return base({
    type: 'shape', name: 'Dashed Line',
    style: { stroke_color: '#ffffff', stroke_width: 3, stroke_opacity: 1 },
    props: { subtype: 'dashed_line', start_point: { x: -1.5, y: 0 }, end_point: { x: 1.5, y: 0 }, dash_length: 0.15, dashed_ratio: 0.5 },
  });
}

// --- Coordinate systems ----------------------------------------------------
export function createAxes(): SceneObject {
  return base({
    type: 'coordinate_system', name: 'Axes',
    style: { stroke_color: '#ffffff', stroke_width: 2 },
    props: { subtype: 'axes', x_range: [-4, 4, 1], y_range: [-3, 3, 1], x_length: 6, y_length: 4.5, include_numbers: true, tips: false },
  });
}

export function createNumberLine(): SceneObject {
  return base({
    type: 'coordinate_system', name: 'Number Line',
    style: { stroke_color: '#ffffff', stroke_width: 2 },
    props: { subtype: 'number_line', x_range: [-5, 5, 1], length: 8, include_numbers: true },
  });
}

export function createNumberPlane(): SceneObject {
  return base({
    type: 'coordinate_system', name: 'Number Plane',
    style: { stroke_color: '#3b82f6', stroke_width: 2 },
    props: { subtype: 'number_plane', x_range: [-5, 5, 1], y_range: [-3, 3, 1], x_length: 8, y_length: 5 },
  });
}

// --- Graph (needs an axes_ref) --------------------------------------------
export function createFunctionPlot(axesId: string): SceneObject {
  return base({
    type: 'graph', name: 'f(x)',
    style: { stroke_color: '#58c4dd', stroke_width: 4 },
    props: { subtype: 'function_plot', axes_ref: axesId, expression: 'sin(x)', x_range: [-4, 4], use_smoothing: true },
  });
}

export function createParametric(axesId: string): SceneObject {
  return base({
    type: 'graph', name: 'parametric',
    style: { stroke_color: '#58c4dd', stroke_width: 4 },
    props: { subtype: 'parametric', axes_ref: axesId, x_expression: 'cos(t)', y_expression: 'sin(2*t)', t_range: [0, 6.2832, 0.05] },
  });
}

export function createImplicit(axesId: string): SceneObject {
  return base({
    type: 'graph', name: 'implicit',
    style: { stroke_color: '#ff6699', stroke_width: 4 },
    props: { subtype: 'implicit', axes_ref: axesId, expression: 'x**2 + y**2 - 4' },
  });
}

// --- Vector field (standalone, scene coords) ------------------------------
export function createVectorField(): SceneObject {
  return base({
    type: 'graph', name: 'vector field',
    style: { stroke_color: '#ffffff' },
    props: { subtype: 'vector_field', x_func: '-y', y_func: 'x', x_range: [-5, 5, 1], y_range: [-3, 3, 1] },
  });
}

// --- Geometry --------------------------------------------------------------
export function createVector(): SceneObject {
  return base({
    type: 'geometry', name: 'Vector',
    style: { stroke_color: '#22c55e', stroke_width: 4 },
    props: { subtype: 'vector', direction: { x: 2, y: 1 }, label: '' },
  });
}

export function createAngle(line1Id = '', line2Id = ''): SceneObject {
  return base({
    type: 'geometry', name: 'Angle',
    style: { stroke_color: '#ffff00', stroke_width: 3 },
    props: { subtype: 'angle', line1_id: line1Id, line2_id: line2Id, radius: 0.6 },
  });
}

export function createBrace(targetId = ''): SceneObject {
  return base({
    type: 'geometry', name: 'Brace',
    style: { stroke_color: '#ffffff' },
    props: { subtype: 'brace', target_id: targetId, direction_str: 'DOWN', label: '' },
  });
}
