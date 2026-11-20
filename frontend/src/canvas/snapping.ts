// Smart guides: while one object is dragged, its left / centre / right (and
// bottom / centre / top) snap onto the same features of every other object on
// screen and onto the frame's centre lines and edges, within SNAP_PX screen px.
// Shared by the Konva drag (SceneNodes.snapDragBound, absolute px) and the HTML
// overlay drag (LatexOverlay, scene units) so both behave identically.
//
// `CanvasStage` publishes what's on screen each render (`setSnapObjects`) — the
// authored layout, or the animated frame in Record mode — so guides line up with
// what you see, not with stale positions. The guide lines themselves live in
// `canvasStore.guides` and are drawn by CanvasStage; a pointer release clears them.
import type { Point2D, SceneObject } from '../types/ir';
import { objectBounds, type Bounds } from './geometry';
import { FRAME_WIDTH, FRAME_HEIGHT } from './coords';

export interface Guide { axis: 'x' | 'y'; at: number } // a vertical (x) or horizontal (y) line, scene units

let onScreen: SceneObject[] = [];
export function setSnapObjects(objs: SceneObject[]): void { onScreen = objs; }

// Things whose `position` + objectBounds describe where they really are. Graphs
// follow their axes and angle/brace hang off other objects, so they neither snap
// nor act as targets.
function snappable(o: SceneObject): boolean {
  const sub = String((o.props as Record<string, unknown>).subtype ?? '');
  return o.visible && o.type !== 'group' && o.type !== 'graph'
    && !(o.type === 'geometry' && (sub === 'angle' || sub === 'brace'));
}

const features = (lo: number, c: number, hi: number) => [lo, c, hi];

// Snap a proposed position (scene units) of object `id`. `tol` is in scene units.
export function snapPosition(id: string, pos: Point2D, tol: number): { pos: Point2D; guides: Guide[] } {
  const me = onScreen.find(o => o.id === id);
  if (!me || !snappable(me)) return { pos, guides: [] };
  const b: Bounds = objectBounds(me);
  // objectBounds' centre isn't always `position` (lines, polygons): keep the offset.
  const cx = pos.x + (b.cx - me.position.x), cy = pos.y + (b.cy - me.position.y);
  const fx = features(cx - b.hw, cx, cx + b.hw);
  const fy = features(cy - b.hh, cy, cy + b.hh);

  const tx = [0, -FRAME_WIDTH / 2, FRAME_WIDTH / 2];
  const ty = [0, -FRAME_HEIGHT / 2, FRAME_HEIGHT / 2];
  for (const o of onScreen) {
    if (o.id === id || !snappable(o)) continue;
    const ob = objectBounds(o);
    tx.push(...features(ob.cx - ob.hw, ob.cx, ob.cx + ob.hw));
    ty.push(...features(ob.cy - ob.hh, ob.cy, ob.cy + ob.hh));
  }

  const best = (fs: number[], ts: number[]) => {
    let hit: { d: number; at: number } | null = null;
    for (const f of fs) for (const t of ts) {
      const d = t - f;
      if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: t };
    }
    return hit;
  };
  const bx = best(fx, tx), by = best(fy, ty);
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: 'x', at: bx.at });
  if (by) guides.push({ axis: 'y', at: by.at });
  return { pos: { x: pos.x + (bx?.d ?? 0), y: pos.y + (by?.d ?? 0) }, guides };
}
