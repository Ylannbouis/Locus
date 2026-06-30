import type { Keyframe, Point2D, Scene, SceneObject } from '../types/ir';

// Accumulated 2D transform of an object: center position, uniform scale, and
// rotation (Manim CCW degrees). move/scale/rotate keyframes each touch one
// channel independently (Manim scales/rotates about the object's center, so
// neither changes the center; move only changes the center).
export interface Transform2D {
  pos: Point2D;
  scale: number;
  rotationDeg: number;
}

// A faded preview copy of an object at a resulting transform.
export interface Ghost {
  obj: SceneObject;    // clone positioned at the resulting center
  scale: number;       // cumulative scale, applied about the object's center
  rotationDeg: number; // cumulative rotation (Manim CCW degrees)
}

export const PREVIEW_VERBS = new Set(['move', 'scale', 'rotate']);

function applyKf(t: Transform2D, kf: Keyframe): void {
  const p = (kf.params ?? {}) as {
    target_position?: Point2D; delta?: Point2D; factor?: number; angle_degrees?: number;
  };
  if (kf.verb === 'move') {
    if (p.target_position) {
      t.pos = { x: Number(p.target_position.x ?? t.pos.x), y: Number(p.target_position.y ?? t.pos.y) };
    } else if (p.delta) {
      t.pos = { x: t.pos.x + Number(p.delta.x ?? 0), y: t.pos.y + Number(p.delta.y ?? 0) };
    }
  } else if (kf.verb === 'scale') {
    t.scale *= Number(p.factor ?? 1.5);
  } else if (kf.verb === 'rotate') {
    t.rotationDeg += Number(p.angle_degrees ?? 90);
  }
}

// The object's transform from every move/scale/rotate keyframe that has started
// before `time`, applied in start_time order (matching Manim's sequential play).
export function effectiveTransform(scene: Scene, objectId: string, time: number): Transform2D {
  const obj = scene.objects.find(o => o.id === objectId);
  const t: Transform2D = {
    pos: obj ? { ...obj.position } : { x: 0, y: 0 },
    scale: 1,
    rotationDeg: 0,
  };
  scene.timeline.keyframes
    .filter(k => k.object_id === objectId && PREVIEW_VERBS.has(k.verb) && k.start_time < time - 1e-6)
    .sort((a, b) => a.start_time - b.start_time)
    .forEach(k => applyKf(t, k));
  return t;
}

// The transform just before a keyframe and the transform after it completes —
// i.e. all earlier keyframes stacked, then this one applied on top.
export function transformAfter(scene: Scene, kf: Keyframe): { before: Transform2D; after: Transform2D } {
  const before = effectiveTransform(scene, kf.object_id, kf.start_time);
  const after: Transform2D = { pos: { ...before.pos }, scale: before.scale, rotationDeg: before.rotationDeg };
  applyKf(after, kf);
  return { before, after };
}

// Convenience: only the resulting position (used by the camera focus preview).
export function effectivePosition(scene: Scene, objectId: string, time: number): Point2D {
  return effectiveTransform(scene, objectId, time).pos;
}
