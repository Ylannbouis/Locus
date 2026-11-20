// Record mode: turn a direct manipulation on the canvas (drag / rotate / resize)
// at the timeline playhead into a move / rotate / scale keyframe.
//
// The rule is "the object is where you put it *at the playhead*": a recorded
// keyframe ENDS at the playhead t. It starts when the object's previous keyframe
// of the same verb ended (so it animates from the last pose), but lasts at most
// REC_DURATION. Re-recording at the end of an existing keyframe of the same verb
// adjusts that keyframe instead of stacking another. If a same-verb keyframe is
// still running at t, the new one is queued right after it (the caller then
// moves the playhead to its end, so the dropped pose stays on screen).
//
// Moves are recorded as `delta` (relative), which composes correctly with group
// motion and survives later edits to the base position. Placement is computed
// against the live playback model (`frameAt`), so it accounts for everything
// else animating the object.
import type { Keyframe, Point2D, Scene } from '../types/ir';
import { newId } from '../store/objectFactory';
import { frameAt } from './playback';

export const REC_DURATION = 1;
// Below this playhead time, record mode edits the starting layout instead.
export const REC_MIN_TIME = 0.05;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type RecVerb = 'move' | 'scale' | 'rotate';

export interface Recorded {
  kf: Keyframe;   // new or updated keyframe (upsert by id)
  end: number;    // when it completes — where the playhead should sit afterwards
}

function placement(scene: Scene, objId: string, verb: RecVerb, t: number):
  { existing: Keyframe } | { start: number; duration: number } {
  const same = scene.timeline.keyframes.filter(k => k.object_id === objId && k.verb === verb);
  const existing = same.find(k => Math.abs(k.start_time + k.duration - t) < 0.05);
  if (existing) return { existing };
  const lastEnd = Math.max(0, ...same.filter(k => k.start_time < t - 1e-6).map(k => k.start_time + k.duration));
  if (lastEnd > t - 0.1) return { start: r2(lastEnd), duration: REC_DURATION }; // queue after the running one
  const duration = r2(Math.min(REC_DURATION, t - lastEnd));
  return { start: r2(t - duration), duration };
}

function posAt(scene: Scene, objId: string, time: number): Point2D {
  const o = frameAt(scene, time).objects.find(x => x.id === objId);
  return o ? { ...o.position } : { x: 0, y: 0 };
}

function fresh(objId: string, verb: RecVerb, start: number, duration: number, params: Record<string, unknown>): Keyframe {
  return { id: newId('kf'), object_id: objId, verb, start_time: start, duration, easing: 'smooth', group_id: null, params };
}

// The object should be at `target` (scene units) at time t.
export function recordMove(scene: Scene, objId: string, t: number, target: Point2D): Recorded | null {
  const pl = placement(scene, objId, 'move', t);
  if ('existing' in pl) {
    const k = pl.existing;
    const cur = posAt(scene, objId, t);
    const dx = target.x - cur.x, dy = target.y - cur.y;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return null;
    const p = { ...(k.params ?? {}) } as Record<string, unknown>;
    const tp = p.target_position as Point2D | undefined;
    if (tp) p.target_position = { x: r2(Number(tp.x) + dx), y: r2(Number(tp.y) + dy) };
    else {
      const d = (p.delta as Point2D | undefined) ?? { x: 0, y: 0 };
      p.delta = { x: r2(Number(d.x) + dx), y: r2(Number(d.y) + dy) };
    }
    return { kf: { ...k, params: p }, end: k.start_time + k.duration };
  }
  const end = pl.start + pl.duration;
  const cur = posAt(scene, objId, end); // where it would be without the new keyframe
  const dx = r2(target.x - cur.x), dy = r2(target.y - cur.y);
  if (!dx && !dy) return null;
  return { kf: fresh(objId, 'move', pl.start, pl.duration, { delta: { x: dx, y: dy } }), end };
}

// Rotate by `deg` (Manim CCW degrees) relative to how the object looks at t.
export function recordRotate(scene: Scene, objId: string, t: number, deg: number): Recorded | null {
  if (Math.abs(deg) < 0.05) return null;
  const pl = placement(scene, objId, 'rotate', t);
  if ('existing' in pl) {
    const k = pl.existing;
    const p = { ...(k.params ?? {}) } as Record<string, unknown>;
    p.angle_degrees = r2(Number(p.angle_degrees ?? 90) + deg);
    return { kf: { ...k, params: p }, end: k.start_time + k.duration };
  }
  return { kf: fresh(objId, 'rotate', pl.start, pl.duration, { angle_degrees: r2(deg) }), end: pl.start + pl.duration };
}

// Scale by `factor` relative to how the object looks at t.
export function recordScale(scene: Scene, objId: string, t: number, factor: number): Recorded | null {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-3) return null;
  const pl = placement(scene, objId, 'scale', t);
  if ('existing' in pl) {
    const k = pl.existing;
    const p = { ...(k.params ?? {}) } as Record<string, unknown>;
    p.factor = r3(Number(p.factor ?? 1.5) * factor);
    return { kf: { ...k, params: p }, end: k.start_time + k.duration };
  }
  return { kf: fresh(objId, 'scale', pl.start, pl.duration, { factor: r3(factor) }), end: pl.start + pl.duration };
}

// Normalize degrees into (-180, 180] — a gizmo drop should take the short way round.
export function normDeg(d: number): number {
  const m = ((d % 360) + 360) % 360;
  return m > 180 ? m - 360 : m;
}
