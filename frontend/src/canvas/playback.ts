// Playback preview: what the scene looks like at an arbitrary time `t`.
//
// Editor-only, like every other canvas preview — the backend codegen is the
// render truth. This mirrors its semantics closely enough to scrub/play in the
// editor:
//   - move / scale / rotate interpolate with the keyframe's easing (motion.ts);
//     a group's transforms carry its children along, pivoting about the group.
//   - an object whose first presence event is a creation verb (Write, Create,
//     Draw+Fill, Type On, Fade In) — or that is only ever a Transform target —
//     is hidden until that event, like the codegen's hide-until-creation pass.
//   - drawing verbs are approximated: strokes trace in (line-likes, plots,
//     vectors, closed-shape outlines, axes / number lines), equations/text wipe in left-to-right,
//     Type On reveals letters, everything else ramps opacity.
//   - fades ramp opacity (with their optional shift); transform / replace /
//     morph cross-fade the source into the target.
//   - Indicate pulses scale + colour; Circumscribe and Flash draw nothing extra.
//   - Update keyframes ease a histogram's bars / a number's value (data.ts).
//   - group opacity multiplies into every descendant.
// Never feed these baked clones back into the IR: they carry transient
// `__draw` / `__clip` props that only the canvas renderers understand.
import type { Keyframe, Point2D, Scene, SceneObject } from '../types/ir';
import { applyKf, kfAlpha, kfProgress, PREVIEW_VERBS, effectiveTransform, type Transform2D } from './motion';
import { bakeTransform } from '../store/finalState';
import { dataAt } from './data';
import { CAMERA_ID } from '../timeline/timelineStore';

const DRAW_VERBS = new Set(['write', 'create', 'draw_border_then_fill']);
const CREATION_VERBS = new Set(['write', 'create', 'draw_border_then_fill', 'type_on', 'fade_in']);
const XFORM_TO_TARGET = new Set(['transform', 'replacement_transform', 'morph_equation']);
const LINE_LIKE = new Set(['line', 'dashed_line', 'arrow', 'double_arrow']);
const CLOSED_SHAPES = new Set(['rectangle', 'circle', 'ellipse', 'polygon']);

export interface PlaybackFrame {
  objects: SceneObject[];             // baked clones at time t (all of them, in scene order)
  opacity: Record<string, number>;    // effective opacity per object id (group fades included)
  camera: { pan: Point2D; zoom: number } | null; // null when the scene doesn't use the camera
}

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const pt = (v: unknown): Point2D | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as { x?: unknown; y?: unknown };
  return { x: num(o.x, 0), y: num(o.y, 0) };
};

function targetOf(kf: Keyframe): string | undefined {
  const p = (kf.params ?? {}) as Record<string, unknown>;
  return (p.target_object_id ?? p.target_tex_id) as string | undefined;
}

function hexBlend(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const ca = parse(a), cb = parse(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const c = ca.map((x, i) => Math.round(x + (cb[i] - x) * t));
  return `#${c.map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

// Presence-affecting events for one object, in play order. On a start-time tie
// the creation counts first (matches the codegen's hide pass).
interface PresenceEv { kf: Keyframe; kind: 'create' | 'fade_out' | 'source_out' | 'target_in' }

function presenceEvents(objId: string, kfs: Keyframe[]): PresenceEv[] {
  const evs: PresenceEv[] = [];
  for (const k of kfs) {
    if (k.object_id === objId) {
      if (CREATION_VERBS.has(k.verb)) evs.push({ kf: k, kind: 'create' });
      else if (k.verb === 'fade_out') evs.push({ kf: k, kind: 'fade_out' });
      else if (XFORM_TO_TARGET.has(k.verb) && targetOf(k)) evs.push({ kf: k, kind: 'source_out' });
    } else if (XFORM_TO_TARGET.has(k.verb) && targetOf(k) === objId) {
      evs.push({ kf: k, kind: 'target_in' });
    }
  }
  const rank = (e: PresenceEv) => (e.kind === 'create' || e.kind === 'target_in' ? 0 : 1);
  return evs.sort((a, b) => a.kf.start_time - b.kf.start_time || rank(a) - rank(b));
}

interface OwnState {
  opacity: number;
  draw: number | null;       // stroke/wipe progress of an in-flight drawing verb
  drawVerb: string | null;
  typeOn: number | null;     // fraction of letters revealed by an in-flight Type On
}

function ownPresence(objId: string, kfs: Keyframe[], t: number): OwnState {
  const evs = presenceEvents(objId, kfs);
  const first = evs[0];
  let op = first && (first.kind === 'create' || first.kind === 'target_in') ? 0 : 1;
  const st: OwnState = { opacity: op, draw: null, drawVerb: null, typeOn: null };
  for (const e of evs) {
    if (e.kf.start_time >= t) break;
    const a = kfAlpha(e.kf, t);
    const running = kfProgress(e.kf, t) < 1;
    st.draw = null; st.drawVerb = null; st.typeOn = null;
    if (e.kind === 'create') {
      if (DRAW_VERBS.has(e.kf.verb)) {
        op = 1;
        if (running) { st.draw = a; st.drawVerb = e.kf.verb; }
      } else if (e.kf.verb === 'type_on') {
        op = 1;
        if (running) st.typeOn = kfProgress(e.kf, t); // letters arrive at a steady rate
      } else {
        op = a; // fade_in
      }
    } else if (e.kind === 'target_in') {
      op = a;
    } else {
      op = op * (1 - a); // fade_out / transform source handing over to its target
    }
  }
  st.opacity = op;
  return st;
}

// Own move/scale/rotate (+ fade shifts and Indicate's pulse) at time t.
function ownTransform(obj: SceneObject, kfs: Keyframe[], t: number): { T: Transform2D; indicate: { amt: number; color: string } | null } {
  const T: Transform2D = { pos: { ...obj.position }, scale: 1, rotationDeg: 0 };
  let indicate: { amt: number; color: string } | null = null;
  const own = kfs.filter(k => k.object_id === obj.id && k.start_time < t)
    .sort((a, b) => a.start_time - b.start_time);
  for (const k of own) {
    const a = kfAlpha(k, t);
    const p = (k.params ?? {}) as Record<string, unknown>;
    if (PREVIEW_VERBS.has(k.verb)) {
      applyKf(T, k, a);
    } else if (k.verb === 'fade_out' || k.verb === 'fade_in') {
      const sh = pt(p.shift);
      if (sh) {
        // LocusFade: fade-out drifts by `shift` (and stays there); fade-in slides
        // into place from the opposite offset.
        const f = k.verb === 'fade_out' ? a : a - 1;
        T.pos = { x: T.pos.x + sh.x * f, y: T.pos.y + sh.y * f };
      }
    } else if (k.verb === 'indicate') {
      const prog = kfProgress(k, t);
      if (prog < 1) {
        const bump = Math.sin(Math.PI * prog); // Indicate's there_and_back
        T.scale *= 1 + (num(p.scale_factor, 1.2) - 1) * bump;
        indicate = { amt: bump, color: String(p.color || '#ffff00') };
      }
    }
  }
  return { T, indicate };
}

// Where a group "is": the centroid of its leaf descendants' authored centers.
function groupPivot(g: SceneObject, byParent: Map<string, SceneObject[]>, seen = new Set<string>()): Point2D {
  if (seen.has(g.id)) return { ...g.position };
  seen.add(g.id);
  const pts: Point2D[] = [];
  for (const c of byParent.get(g.id) ?? []) {
    pts.push(c.type === 'group' ? groupPivot(c, byParent, seen) : c.position);
  }
  if (!pts.length) return { ...g.position };
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

// Carry a child along with every ancestor group's move/scale/rotate.
function composeAncestors(
  obj: SceneObject, T: Transform2D, kfs: Keyframe[], t: number,
  byId: Map<string, SceneObject>, byParent: Map<string, SceneObject[]>,
): void {
  const seen = new Set<string>();
  let cur: SceneObject | undefined = obj;
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const g = byId.get(cur.parent_id);
    if (!g) break;
    const gT: Transform2D = { pos: groupPivot(g, byParent), scale: 1, rotationDeg: 0 };
    const gkfs = kfs.filter(k => k.object_id === g.id && PREVIEW_VERBS.has(k.verb) && k.start_time < t)
      .sort((a, b) => a.start_time - b.start_time);
    for (const k of gkfs) {
      const before: Transform2D = { pos: { ...gT.pos }, scale: gT.scale, rotationDeg: gT.rotationDeg };
      applyKf(gT, k, kfAlpha(k, t));
      const ds = before.scale ? gT.scale / before.scale : 1;
      const dr = gT.rotationDeg - before.rotationDeg;
      const rad = (dr * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const rx = (T.pos.x - before.pos.x) * ds, ry = (T.pos.y - before.pos.y) * ds;
      T.pos = { x: gT.pos.x + rx * cos - ry * sin, y: gT.pos.y + rx * sin + ry * cos };
      T.scale *= ds;
      T.rotationDeg += dr;
    }
    cur = g;
  }
}

// Camera framing at t: initial framing, then each camera keyframe interpolates
// pan linearly and frame *width* linearly (what Manim's frame.set(width=…) does).
function cameraAt(scene: Scene, t: number): { pan: Point2D; zoom: number } | null {
  const kfs = scene.timeline.keyframes.filter(k => k.object_id === CAMERA_ID || k.verb === 'camera_move')
    .sort((a, b) => a.start_time - b.start_time);
  const ct = scene.camera_track;
  const initPan = ct?.initial_pan ?? { x: 0, y: 0 };
  const initZoom = num(ct?.initial_zoom, 1) > 0 ? num(ct?.initial_zoom, 1) : 1;
  const nonDefault = Math.abs(initPan.x) > 1e-6 || Math.abs(initPan.y) > 1e-6 || Math.abs(initZoom - 1) > 1e-6;
  if (!kfs.length && !nonDefault) return null;
  let pan = { x: num(initPan.x, 0), y: num(initPan.y, 0) };
  let width = 1 / initZoom; // in frame widths
  for (const k of kfs) {
    if (k.start_time >= t) break;
    const p = (k.params ?? {}) as Record<string, unknown>;
    const a = kfAlpha(k, t);
    let to: Point2D | null = null;
    if (p.focus_object_id) {
      // A tracking keyframe follows the object live; a one-shot focus frames
      // where it is when the move starts (both match the codegen).
      const at = p.track ? t : k.start_time;
      to = effectiveTransform(scene, String(p.focus_object_id), at).pos;
      if (p.track) { pan = to; to = null; }
    } else {
      to = pt(p.pan) ?? pt(p.target);
    }
    if (to) pan = { x: pan.x + (to.x - pan.x) * a, y: pan.y + (to.y - pan.y) * a };
    if (p.zoom != null && num(p.zoom, 0) > 0) {
      const w1 = 1 / num(p.zoom, 1);
      width = width + (w1 - width) * a;
    }
  }
  return { pan, zoom: 1 / Math.max(1e-3, width) };
}

export function frameAt(scene: Scene, t: number): PlaybackFrame {
  const kfs = scene.timeline.keyframes;
  const byId = new Map(scene.objects.map(o => [o.id, o]));
  const byParent = new Map<string, SceneObject[]>();
  for (const o of scene.objects) {
    if (o.parent_id) {
      const l = byParent.get(o.parent_id) ?? [];
      l.push(o);
      byParent.set(o.parent_id, l);
    }
  }

  const own = new Map(scene.objects.map(o => [o.id, ownPresence(o.id, kfs, t)]));
  const opacity: Record<string, number> = {};
  const effOpacity = (o: SceneObject): number => {
    if (opacity[o.id] != null) return opacity[o.id];
    let op = own.get(o.id)?.opacity ?? 1;
    const parent = o.parent_id ? byId.get(o.parent_id) : undefined;
    opacity[o.id] = op; // cycle guard before recursing
    if (parent) op *= effOpacity(parent);
    opacity[o.id] = op;
    return op;
  };

  const objects = scene.objects.map(o => {
    effOpacity(o);
    if (o.type === 'group') return o;
    const { T, indicate } = ownTransform(o, kfs, t);
    composeAncestors(o, T, kfs, t, byId, byParent);
    const c = bakeTransform(o, T);
    const p = c.props as Record<string, unknown>;
    // Histogram bars / number value as of t (Update keyframes, eased).
    const d = dataAt(o, kfs, t);
    if (Array.isArray(d)) p.values = d;
    else if (d != null) p.value = d;
    // A group being drawn (Write/Create on the group) draws its children.
    const st = { ...own.get(o.id)! };
    if (st.draw == null) {
      const seen = new Set<string>();
      for (let a = o.parent_id ? byId.get(o.parent_id) : undefined; a && !seen.has(a.id);
        a = a.parent_id ? byId.get(a.parent_id) : undefined) {
        seen.add(a.id);
        const ast = own.get(a.id);
        if (ast?.draw != null) { st.draw = ast.draw; st.drawVerb = ast.drawVerb; break; }
      }
    }

    if (st.draw != null) {
      const sub = String(p.subtype ?? '');
      if (o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix' || o.type === 'number') {
        p.__clip = st.draw; // left-to-right wipe
      } else if ((o.type === 'shape' && (LINE_LIKE.has(sub) || CLOSED_SHAPES.has(sub)))
        || o.type === 'graph' || (o.type === 'geometry' && sub === 'vector')
        || (o.type === 'coordinate_system' && sub !== 'number_plane')) {
        p.__draw = st.draw;
        // Draw+Fill outlines first, then fills; Create/Write bring the fill in as
        // the stroke goes round.
        if (o.type === 'shape' && CLOSED_SHAPES.has(sub)) {
          const f = st.drawVerb === 'draw_border_then_fill' ? Math.max(0, (st.draw - 0.5) * 2) : st.draw;
          c.style = { ...c.style, fill_opacity: num(c.style.fill_opacity, 0) * f };
        }
      } else {
        opacity[o.id] *= st.draw; // no tracing approximation for this type → fade it in
      }
    }
    if (st.typeOn != null && o.type === 'text') {
      const txt = String(p.text ?? '');
      p.text = txt.slice(0, Math.floor(txt.length * st.typeOn));
    }
    if (indicate) {
      const col = indicate.color;
      c.style = {
        ...c.style,
        stroke_color: hexBlend(String(c.style.stroke_color || '#ffffff'), col, indicate.amt),
        fill_color: c.style.fill_color ? hexBlend(String(c.style.fill_color), col, indicate.amt) : c.style.fill_color,
      };
      if ((o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix' || o.type === 'number') && !c.style.fill_color) {
        c.style.fill_color = hexBlend('#ffffff', col, indicate.amt);
      }
    }
    return c;
  });

  return { objects, opacity, camera: cameraAt(scene, t) };
}

