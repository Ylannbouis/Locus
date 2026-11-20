// Compute the "final state" of a scene: what it looks like after every animation
// has played. Used by "Duplicate final state" — the new scene has no timeline,
// so each object must carry its end-of-animation transform baked into its own
// geometry (position, size, rotation) rather than into keyframes.
//
// Rules mirror the codegen/animation semantics:
//   - fade_out  -> the object is gone at the end (dropped).
//   - transform / replacement_transform / morph_equation -> the source is gone
//     and looks like the target, so we drop the source and keep the target
//     (showing the target statically reproduces the final frame).
//   - move / scale / rotate -> accumulated into position + geometry (via
//     `effectiveTransform`, the same math the canvas ghost previews use).
//   - creation verbs / indicate / circumscribe / flash -> object stays as-is.
import type { CameraTrack, Keyframe, Point2D, Scene, SceneObject } from '../types/ir';
import { effectivePosition, effectiveTransform, type Transform2D } from '../canvas/motion';

// Sentinel object id for camera keyframes (mirrors the backend CAMERA_ID).
const CAMERA_ID = '__camera__';

const CREATION_VERBS = new Set(['write', 'create', 'draw_border_then_fill', 'fade_in']);
const XFORM_VERBS = new Set(['transform', 'replacement_transform', 'morph_equation']);
const LINE_SUBTYPES = new Set(['line', 'arrow', 'dashed_line', 'double_arrow']);

// A time past the end of any timeline, so `effectiveTransform` folds in every
// move/scale/rotate keyframe.
const END_TIME = 1e12;

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// True if the object's last presence-affecting keyframe is a fade_out (i.e. it
// has been faded away by the end and never re-created afterwards).
function endsFadedOut(objId: string, kfs: Keyframe[]): boolean {
  const rel = kfs
    .filter(k => k.object_id === objId && (k.verb === 'fade_out' || CREATION_VERBS.has(k.verb)))
    .sort((a, b) => a.start_time - b.start_time);
  return rel.length > 0 && rel[rel.length - 1].verb === 'fade_out';
}

// Rotate a point about a center by `deg` (Manim CCW degrees, math y-up space).
function rotatePt(pt: Point2D, c: Point2D, deg: number): Point2D {
  if (!deg) return { x: pt.x, y: pt.y };
  const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const dx = pt.x - c.x, dy = pt.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function centroid(pts: Point2D[]): Point2D {
  if (!pts.length) return { x: 0, y: 0 };
  const s = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length };
}

// Scale (about centroid) then rotate (about centroid) a set of local points —
// matching Manim's scale/rotate which pivot about the mobject's own center.
function scaleRotatePts(pts: Point2D[], s: number, r: number): Point2D[] {
  const c = centroid(pts);
  return pts.map(p => rotatePt({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s }, c, r));
}

// Return a deep clone of `obj` with a transform baked into concrete geometry
// props (so both the canvas and the codegen render it statically). Also used per
// frame by the canvas playback preview (`canvas/playback.ts`).
export function bakeTransform(obj: SceneObject, T: Transform2D): SceneObject {
  const c = JSON.parse(JSON.stringify(obj)) as SceneObject;
  c.position = { x: T.pos.x, y: T.pos.y };
  const s = T.scale, r = T.rotationDeg;
  if (s === 1 && !r) return c;
  const p = c.props as Record<string, unknown>;
  // Rotation for center-based types is carried on a generic `rotation` prop that
  // the canvas + codegen apply about the object's center; point-based types
  // (polygon, lines) instead rotate their own vertices, so they need no prop.
  const addRot = () => { if (r) p.rotation = num(p.rotation, 0) + r; };
  const pt = (v: unknown): Point2D => {
    const o = (v ?? {}) as { x?: unknown; y?: unknown };
    return { x: num(o.x, 0), y: num(o.y, 0) };
  };

  if (obj.type === 'shape') {
    const st = p.subtype;
    if (st === 'circle') {
      p.radius = num(p.radius, 1) * s;
    } else if (st === 'rectangle' || st === 'ellipse') {
      p.width = num(p.width, 2) * s;
      p.height = num(p.height, 1.2) * s;
      // Rounded corners grow with the shape (Manim's .scale() scales the arcs too).
      if (p.corner_radius != null) p.corner_radius = num(p.corner_radius, 0) * s;
      addRot();
    } else if (st === 'polygon') {
      const verts = (Array.isArray(p.vertices) ? p.vertices : []).map(pt);
      p.vertices = scaleRotatePts(verts, s, r);
    } else if (typeof st === 'string' && LINE_SUBTYPES.has(st)) {
      const [start, end] = scaleRotatePts([pt(p.start_point), pt(p.end_point)], s, r);
      p.start_point = start;
      p.end_point = end;
    }
  } else if (obj.type === 'latex_text' || obj.type === 'text' || obj.type === 'matrix') {
    p.font_size = num(p.font_size, 48) * s;
    addRot();
  } else if (obj.type === 'image') {
    p.width = num(p.width, 4) * s;
    p.height = num(p.height, 3) * s;
    addRot();
  } else if (obj.type === 'coordinate_system') {
    if (p.x_length != null) p.x_length = num(p.x_length, 6) * s;
    if (p.y_length != null) p.y_length = num(p.y_length, 4) * s;
    if (p.length != null) p.length = num(p.length, 8) * s;
    addRot();
  } else if (obj.type === 'geometry' && p.subtype === 'vector') {
    // Scale + rotate the direction vector about its tail (Vector starts at the
    // origin, then is shifted to `position`).
    p.direction = rotatePt({ x: num(pt(p.direction).x, 1) * s, y: pt(p.direction).y * s }, { x: 0, y: 0 }, r);
  }
  // graphs follow their axes; angle/brace are anchored to referenced objects —
  // both reproduce the final look via those refs, so no per-object bake.
  return c;
}

// The objects of a scene as they appear after all animations, plus the camera
// framing at the end (so a static snapshot is framed like the final frame).
export function computeFinalState(scene: Scene): { objects: SceneObject[]; cameraTrack: CameraTrack } {
  const kfs = scene.timeline.keyframes;

  const sourceRemoved = new Set<string>();
  const targets = new Set<string>();
  for (const k of kfs) {
    if (!XFORM_VERBS.has(k.verb)) continue;
    sourceRemoved.add(k.object_id);
    const params = (k.params ?? {}) as Record<string, unknown>;
    const t = (params.target_object_id ?? params.target_tex_id) as string | undefined;
    if (t) targets.add(t);
  }

  const objects: SceneObject[] = [];
  for (const obj of scene.objects) {
    if (sourceRemoved.has(obj.id)) continue;              // replaced by its target
    if (!targets.has(obj.id) && endsFadedOut(obj.id, kfs)) continue; // faded away
    objects.push(bakeTransform(obj, effectiveTransform(scene, obj.id, END_TIME)));
  }

  // Camera framing after all camera moves (the scene has no camera timeline, so
  // this becomes its initial — and only — framing).
  const ct = scene.camera_track;
  let pan: Point2D = ct ? { ...ct.initial_pan } : { x: 0, y: 0 };
  let zoom = ct ? num(ct.initial_zoom, 1) : 1;
  const camKfs = kfs
    .filter(k => k.verb === 'camera_move' || k.object_id === CAMERA_ID)
    .sort((a, b) => a.start_time - b.start_time);
  for (const k of camKfs) {
    const p = (k.params ?? {}) as Record<string, unknown>;
    if (p.focus_object_id) pan = effectivePosition(scene, String(p.focus_object_id), END_TIME);
    else if (p.pan) pan = { x: num((p.pan as Point2D).x, pan.x), y: num((p.pan as Point2D).y, pan.y) };
    else if (p.target) pan = { x: num((p.target as Point2D).x, pan.x), y: num((p.target as Point2D).y, pan.y) };
    if (p.zoom != null) zoom = num(p.zoom, zoom);
  }

  return { objects, cameraTrack: { initial_pan: pan, initial_zoom: zoom } };
}
