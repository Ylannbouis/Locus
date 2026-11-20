import type { Keyframe, Point2D, Scene, SceneObject } from '../types/ir';

// Accumulated 2D transform of an object: center position, uniform scale, and
// rotation (Manim CCW degrees). move/scale keyframes each touch one channel
// independently (Manim scales about the object's center, so it doesn't change
// the center; move only changes the center). A rotate pivots about the object's
// center by default — but with an `about_point` param it orbits that fixed
// scene point, so the center moves along the arc too (mirrors the codegen's
// `.rotate(angle, about_point=…)`).
export interface Transform2D {
  pos: Point2D;
  scale: number;
  rotationDeg: number;
}

// A faded preview copy of an object at a resulting transform.
export interface Ghost {
  key: string;         // unique per ghost (an object can have several at once)
  obj: SceneObject;    // clone positioned at the resulting center
  scale: number;       // cumulative scale, applied about the object's center
  rotationDeg: number; // cumulative rotation (Manim CCW degrees)
}

export const PREVIEW_VERBS = new Set(['move', 'scale', 'rotate']);

// Approximate Manim rate functions (editor-only: the easing preview in the
// keyframe inspector and the canvas playback preview).
export const RATE: Record<string, (t: number) => number> = {
  linear: t => t,
  smooth: t => t * t * t * (t * (t * 6 - 15) + 10),
  rush_from: t => t * (2 - t),
  rush_into: t => t * t,
  there_and_back: t => Math.sin(Math.PI * t),
  double_smooth: t => {
    const s = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
    return t < 0.5 ? s(t * 2) / 2 : 0.5 + s((t - 0.5) * 2) / 2;
  },
};

export function ease(easing: string | undefined, x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return (RATE[easing ?? 'smooth'] ?? RATE.smooth)(c);
}

// Linear progress of a keyframe at `time`, in [0, 1] (unclamped easing is the
// caller's business — see `kfAlpha`).
export function kfProgress(kf: Keyframe, time: number): number {
  const d = Number(kf.duration) || 0;
  if (time <= kf.start_time) return 0;
  if (d <= 0 || time >= kf.start_time + d) return 1;
  return (time - kf.start_time) / d;
}

// Eased progress, i.e. how far the animated property has travelled.
export function kfAlpha(kf: Keyframe, time: number): number {
  const p = kfProgress(kf, time);
  return p >= 1 ? 1 : ease(kf.easing, p);
}

// Apply a move/scale/rotate keyframe to `t`, `alpha` of the way (1 = complete).
// Partial application is what the playback preview interpolates with; the
// interpolation is the intuitive one (a rotate sweeps its angle), whereas Manim
// moves points in straight lines — so a large mid-rotation frame renders a
// little smaller than this shows. Start and end states match exactly.
export function applyKf(t: Transform2D, kf: Keyframe, alpha = 1): void {
  const p = (kf.params ?? {}) as {
    target_position?: Point2D; delta?: Point2D; factor?: number;
    angle_degrees?: number; about_point?: Point2D;
  };
  if (kf.verb === 'move') {
    let to: Point2D | null = null;
    if (p.target_position) {
      to = { x: Number(p.target_position.x ?? t.pos.x), y: Number(p.target_position.y ?? t.pos.y) };
    } else if (p.delta) {
      to = { x: t.pos.x + Number(p.delta.x ?? 0), y: t.pos.y + Number(p.delta.y ?? 0) };
    }
    if (to) t.pos = { x: t.pos.x + (to.x - t.pos.x) * alpha, y: t.pos.y + (to.y - t.pos.y) * alpha };
  } else if (kf.verb === 'scale') {
    t.scale *= 1 + (Number(p.factor ?? 1.5) - 1) * alpha;
  } else if (kf.verb === 'rotate') {
    const deg = Number(p.angle_degrees ?? 90) * alpha;
    t.rotationDeg += deg;
    if (p.about_point) {
      // Anchored pivot: the center orbits the anchor by the same angle.
      const ax = Number(p.about_point.x ?? 0), ay = Number(p.about_point.y ?? 0);
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const dx = t.pos.x - ax, dy = t.pos.y - ay;
      t.pos = { x: ax + dx * cos - dy * sin, y: ay + dx * sin + dy * cos };
    }
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
