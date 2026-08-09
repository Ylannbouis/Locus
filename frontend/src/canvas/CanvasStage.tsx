import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Stage, Layer, Rect, Arrow, Circle, Group, Line } from 'react-konva';
import type Konva from 'konva';
import { useProjectStore } from '../store/projectStore';
import { useCanvasStore } from '../store/canvasStore';
import { useTimelineStore, CAMERA_ID } from '../timeline/timelineStore';
import type { Point2D, SceneObject } from '../types/ir';
import { LatexOverlay } from './LatexOverlay';
import { SceneNodes } from './SceneNodes';
import { effectivePosition, transformAfter, type Ghost } from './motion';
import {
  PX_PER_UNIT, FRAME_WIDTH, FRAME_HEIGHT, SNAP_PX,
  MIN_SCALE, MAX_SCALE, manimX, manimY, worldX, worldY, screenToWorld, type View,
} from './coords';
import { objectBounds } from './geometry';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Wheel/trackpad tuning. A discrete mouse-wheel notch reports |deltaY| ≈ 100 px in
// every browser that uses pixel deltaMode; trackpads report a stream of much
// smaller (often fractional) deltas on both axes.
// How far (screen px) two clicks may be apart and still count as "the same spot"
// for click-through selection (see pickCycle).
const CYCLE_PX = 4;

const WHEEL_NOTCH = 50;   // px: at or above this, a pixel-mode delta looks like a wheel notch
const NOTCH_ZOOM = 1.1;   // zoom step per wheel notch
const PINCH_RATE = 0.01;  // zoom exponent per px of pinch delta

// Polyline (world px) tracing the arc the object's center sweeps while rotating
// `deg` (Manim CCW degrees) about the fixed pivot `a`, starting at `from`.
function arcPoints(a: Point2D, from: Point2D, deg: number): number[] {
  const n = Math.min(64, Math.max(8, Math.ceil(Math.abs(deg) / 5)));
  const rx = from.x - a.x, ry = from.y - a.y;
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = ((deg * Math.PI) / 180) * (i / n);
    const c = Math.cos(t), s = Math.sin(t);
    pts.push(worldX(a.x + rx * c - ry * s), worldY(a.y + rx * s + ry * c));
  }
  return pts;
}

export function CanvasStage() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const toggleSelect = useProjectStore(s => s.toggleSelect);
  const moveObject = useProjectStore(s => s.moveObject);
  const moveObjectsBy = useProjectStore(s => s.moveObjectsBy);
  const updateObject = useProjectStore(s => s.updateObject);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const updateCameraTrack = useProjectStore(s => s.updateCameraTrack);
  const snapToCenter = useCanvasStore(s => s.snapToCenter);
  const setSnapToCenter = useCanvasStore(s => s.setSnapToCenter);
  const selectedKfIds = useTimelineStore(s => s.selectedKfIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Live endpoint while dragging a selected line-like shape's handle (committed on release).
  const [endpointDrag, setEndpointDrag] = useState<{ id: string; which: 'start' | 'end'; point: Point2D } | null>(null);
  // Live delta while dragging a multi-selection: the anchor is dragged, everything
  // else (Konva shapes + overlay equations) follows by (dx, dy) until release.
  const [groupDrag, setGroupDrag] = useState<{ anchorId: string; dx: number; dy: number } | null>(null);
  const [handleDrag, setHandleDrag] = useState<{ id: string; pos: Point2D } | null>(null);
  // Live pivot while dragging a rotate keyframe's ⊕ anchor handle (committed on release).
  const [anchorDrag, setAnchorDrag] = useState<{ id: string; pos: Point2D } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Drives the grabbing cursor while a drag-pan is in flight.
  const [panning, setPanning] = useState(false);

  // Hold Space (with a single object selected) to peek at every transform ghost
  // for that object. Only swallow Space then, so it stays usable elsewhere.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return;
      if (useProjectStore.getState().selectedObjectIds.length === 1) { e.preventDefault(); setSpaceHeld(true); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  const centered = useRef(false);
  const viewRef = useRef(view); viewRef.current = view;
  const pan = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  // Where the last click-through click landed and what it selected (see pickCycle).
  const cycleRef = useRef<{ sx: number; sy: number; id: string } | null>(null);
  // Latches once this session's pointing device looks like a trackpad (see onWheel).
  const trackpadSeen = useRef(false);
  const bandRef = useRef<{ active: boolean; sx: number; sy: number; x1: number; y1: number; moved: boolean }>(
    { active: false, sx: 0, sy: 0, x1: 0, y1: 0, moved: false });

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const bgColor = scene?.background_color || project?.settings.background_color || '#000000';

  // The keyframe shown in the inspector (drives the on-canvas previews below).
  const selKf = scene?.timeline.keyframes.find(k => k.id === selectedKfIds[0]);
  const previewKf = selKf && (selKf.verb === 'move' || selKf.verb === 'scale' || selKf.verb === 'rotate')
    ? selKf : undefined;
  const spacePreview = spaceHeld && selectedIds.length === 1;

  // ---- Camera viewport overlay -------------------------------------------
  // Shows the framing of the selected camera keyframe, or the scene's initial
  // camera framing when its pan/zoom is non-default. Dragging the rectangle
  // sets the pan target; zoom + reset live in the floating HUD.
  const camKf = scene?.timeline.keyframes.find(k => k.object_id === CAMERA_ID && selectedKfIds.includes(k.id));
  const camParams = (camKf?.params ?? {}) as { pan?: { x: number; y: number }; zoom?: number; focus_object_id?: string };
  const camTrack = scene?.camera_track;
  const trackActive = !!camTrack && (Math.abs(camTrack.initial_pan?.x ?? 0) > 1e-6
    || Math.abs(camTrack.initial_pan?.y ?? 0) > 1e-6 || Math.abs((camTrack.initial_zoom ?? 1) - 1) > 1e-6);
  // Visible once the camera is in use (any camera keyframe) or the initial
  // framing is non-default; with no camera keyframe selected it edits the
  // scene's initial framing, otherwise the selected keyframe's framing.
  const hasCameraKf = !!scene?.timeline.keyframes.some(k => k.object_id === CAMERA_ID);
  // Suppress the initial-framing overlay while previewing a move/scale/rotate so
  // the canvas isn't cluttered; a selected camera keyframe still shows it.
  const showCamera = !!camKf || ((trackActive || hasCameraKf) && !previewKf && !spacePreview);
  const focusObj = camKf && camParams.focus_object_id ? objects.find(o => o.id === camParams.focus_object_id) : undefined;
  const camZoom = camKf ? Number(camParams.zoom ?? 1) : (camTrack?.initial_zoom ?? 1);
  // For a focus keyframe, frame the object where it is at the keyframe's time
  // (after any earlier move animations), not its authored start position.
  const camCenter: Point2D = camKf
    ? (focusObj && scene ? effectivePosition(scene, focusObj.id, camKf.start_time) : (camParams.pan ?? { x: 0, y: 0 }))
    : (camTrack?.initial_pan ?? { x: 0, y: 0 });
  const camDraggable = showCamera && !focusObj;
  const camHalfWpx = (FRAME_WIDTH / Math.max(0.1, camZoom) / 2) * PX_PER_UNIT;
  const camHalfHpx = (FRAME_HEIGHT / Math.max(0.1, camZoom) / 2) * PX_PER_UNIT;

  const commitCameraPan = (cx: number, cy: number) => {
    if (camKf) updateKeyframe(camKf.id, { params: { ...camParams, pan: { x: round2(cx), y: round2(cy) }, focus_object_id: undefined } });
    else updateCameraTrack({ initial_pan: { x: round2(cx), y: round2(cy) } });
  };
  const setCamZoom = (z: number) => {
    const zoom = Math.max(0.1, z);
    if (camKf) updateKeyframe(camKf.id, { params: { ...camParams, zoom } });
    else updateCameraTrack({ initial_zoom: zoom });
  };
  const resetCamera = () => {
    if (camKf) updateKeyframe(camKf.id, { params: { pan: { x: 0, y: 0 }, zoom: 1 } });
    else updateCameraTrack({ initial_pan: { x: 0, y: 0 }, initial_zoom: 1 });
  };

  // ---- Move / scale / rotate previews ------------------------------------
  // Each previewed transform keyframe gets a faded ghost of its object at the
  // resulting transform (stacking earlier move/scale/rotate keyframes). Sources:
  //   - selecting transform keyframes (shift-click for several), or
  //   - holding Space with one object selected → all its transform keyframes.
  // Moves also get a direction arrow; a single selected move is draggable.
  const isLatexLike = (o: SceneObject) => o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix';
  const isXform = (v: string) => v === 'move' || v === 'scale' || v === 'rotate';

  const previewKfs = scene
    ? (spacePreview
        ? scene.timeline.keyframes.filter(k => k.object_id === selectedIds[0] && isXform(k.verb))
        : scene.timeline.keyframes.filter(k => selectedKfIds.includes(k.id) && isXform(k.verb)))
    : [];
  // A lone selected move keyframe is draggable; a lone selected rotate keyframe
  // gets a draggable pivot (⊕) handle; everything else is read-only.
  const dragKf = (!spacePreview && previewKfs.length === 1 && previewKfs[0].verb === 'move') ? previewKfs[0] : null;
  const anchorKf = (!spacePreview && previewKfs.length === 1 && previewKfs[0].verb === 'rotate') ? previewKfs[0] : null;

  const previewItems = scene ? previewKfs.flatMap(kf => {
    const obj = objects.find(o => o.id === kf.object_id);
    if (!obj) return [];
    // While the pivot handle is dragged, recompute the ghost against the live
    // pivot so the preview stays accurate mid-drag.
    const liveAnchor = kf.verb === 'rotate' && anchorDrag?.id === kf.id ? anchorDrag.pos : null;
    const kfEff = liveAnchor ? { ...kf, params: { ...kf.params, about_point: liveAnchor } } : kf;
    const { before, after } = transformAfter(scene, kfEff);
    const live = dragKf?.id === kf.id && handleDrag?.id === kf.id ? handleDrag.pos : null;
    const dest = kf.verb === 'move' ? (live ?? after.pos) : after.pos;
    const ghost: Ghost = { key: kf.id, obj: { ...obj, position: dest }, scale: after.scale, rotationDeg: after.rotationDeg };
    const p = kf.params as { about_point?: Point2D; angle_degrees?: number };
    const anchor: Point2D | null = kf.verb === 'rotate' ? (liveAnchor ?? p.about_point ?? null) : null;
    return [{
      kf, ghost, from: before.pos, to: dest, isMove: kf.verb === 'move',
      anchor, angleDeg: kf.verb === 'rotate' ? Number(p.angle_degrees ?? 90) : 0,
    }];
  }) : [];

  const ghostLatex = previewItems.filter(it => isLatexLike(it.ghost.obj)).map(it => it.ghost);
  const ghostShapes = previewItems.filter(it => !isLatexLike(it.ghost.obj)).map(it => it.ghost);
  const previewArrows = previewItems.filter(it => it.isMove);
  // Ghosted objects shouldn't be draggable themselves while previewing.
  const previewFrozenIds = [...new Set(previewItems.map(it => it.kf.object_id))];
  const dragItem = dragKf ? previewItems.find(it => it.kf.id === dragKf.id) : undefined;

  // Anchored-rotate previews: pivot marker + the arc the center sweeps.
  const rotatePreviews = previewItems.filter(it => it.anchor);
  const anchorItem = anchorKf ? previewItems.find(it => it.kf.id === anchorKf.id) : undefined;
  // The ⊕ handle sits at the live drag pos, else the stored pivot, else the
  // object's center as of the keyframe (= "rotate about center").
  const anchorPos: Point2D | null = anchorItem
    ? (anchorDrag?.id === anchorItem.kf.id ? anchorDrag.pos
      : ((anchorItem.kf.params as { about_point?: Point2D }).about_point ?? anchorItem.from))
    : null;

  // Snap the pivot back onto the object's center within SNAP_PX, so "rotate
  // about center" is easy to return to (committing there clears the param).
  const snapAnchor = (pos: Point2D): Point2D => {
    if (!anchorItem) return pos;
    const t = SNAP_PX / (view.scale * PX_PER_UNIT);
    const c = anchorItem.from;
    return Math.hypot(pos.x - c.x, pos.y - c.y) <= t ? { x: c.x, y: c.y } : pos;
  };

  const commitRotateAnchor = (posRaw: Point2D) => {
    if (!anchorKf || !scene) return;
    const pos = snapAnchor(posRaw);
    const center = transformAfter(scene, anchorKf).before.pos;
    const p = anchorKf.params as Record<string, unknown>;
    if (Math.hypot(pos.x - center.x, pos.y - center.y) < 1e-9) {
      updateKeyframe(anchorKf.id, { params: { ...p, about_point: undefined } });
    } else {
      updateKeyframe(anchorKf.id, { params: { ...p, about_point: { x: round2(pos.x), y: round2(pos.y) } } });
    }
  };

  const commitMoveDestination = (x: number, y: number) => {
    if (!dragKf || !scene) return;
    const before = transformAfter(scene, dragKf).before.pos;
    const p = dragKf.params as Record<string, unknown>;
    // Preserve the keyframe's mode: 'by' (delta) stays relative; otherwise 'to'.
    if (p.delta && !p.target_position) {
      updateKeyframe(dragKf.id, { params: { ...p, delta: { x: round2(x - before.x), y: round2(y - before.y) } } });
    } else {
      updateKeyframe(dragKf.id, { params: { ...p, target_position: { x: round2(x), y: round2(y) } } });
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Center the frame and scale it to fit — once on mount, and on demand from the
  // toolbar's Fit button (the way back when a pan has wandered off into space).
  const fitView = () => {
    if (size.w <= 0 || size.h <= 0) return;
    const fitW = size.w / (FRAME_WIDTH * PX_PER_UNIT);
    const fitH = size.h / (FRAME_HEIGHT * PX_PER_UNIT);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(fitW, fitH) * 0.92));
    setView({ scale, offsetX: size.w / 2, offsetY: size.h / 2 });
  };

  useEffect(() => {
    if (!centered.current && size.w > 0 && size.h > 0) {
      fitView();
      centered.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // Wheel gestures. Two-finger trackpad scroll pans; pinch-zoom (which both macOS
  // and Windows deliver as ctrl+wheel) zooms; a discrete mouse wheel keeps zooming
  // with no modifier, as it always did. Devices are told apart by the shape of the
  // deltas, and the verdict is sticky: once a trackpad-shaped event has been seen
  // we stop guessing and pan on every unmodified scroll, so a fast two-finger
  // flick can never be mistaken for a wheel notch and zoom instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // deltaMode 1 = lines, 2 = pages; normalize both to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      const notch = e.deltaMode !== 0 || (Number.isInteger(dy) && Math.abs(dy) >= WHEEL_NOTCH);
      if (e.deltaMode === 0 && (e.deltaX !== 0 || !notch)) trackpadSeen.current = true;

      if (e.ctrlKey || e.metaKey || !trackpadSeen.current) {
        const factor = notch
          ? (dy < 0 ? NOTCH_ZOOM : 1 / NOTCH_ZOOM)  // one wheel notch = one 10% step
          : Math.exp(-dy * PINCH_RATE);             // pinch: many small deltas, so scale smoothly
        setView(v => {
          const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
          const wx = (px - v.offsetX) / v.scale;
          const wy = (py - v.offsetY) / v.scale;
          return { scale: newScale, offsetX: px - wx * newScale, offsetY: py - wy * newScale };
        });
      } else {
        // Shift+scroll pans horizontally; macOS swaps the axes for us, Windows doesn't.
        if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
        setView(v => ({ ...v, offsetX: v.offsetX - dx, offsetY: v.offsetY - dy }));
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag-to-pan: middle button, or Alt+left for trackpads (which have no middle
  // button). Captured on the container so the gesture works over objects too —
  // neither Konva nor the LaTeX overlay sees the press, so nothing starts dragging.
  // Both event kinds are captured: the overlay drags on `pointerdown` (which fires
  // first), Konva on `mousedown`, so swallowing only one still lets the other through.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onDown(e: MouseEvent) {
      if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
      // Leave the floating controls clickable.
      if ((e.target as HTMLElement | null)?.closest('.camera-hud, .canvas-toolbar')) return;
      // Never preventDefault a pointerdown: that suppresses the compatibility mouse
      // events (mousedown/mousemove/mouseup) this gesture is driven by, so the release
      // would never arrive and the pan would stick to the cursor. Stopping propagation
      // is enough to keep Konva and the overlay out of it; the paired mousedown, which
      // we capture too, does the preventing (text selection, native drag).
      if (e.type !== 'pointerdown') e.preventDefault();
      e.stopPropagation();
      if (pan.current.active) return; // already started on the paired pointerdown
      const rect = el!.getBoundingClientRect();
      const v = viewRef.current;
      pan.current = { active: true, sx: e.clientX - rect.left, sy: e.clientY - rect.top, ox: v.offsetX, oy: v.offsetY };
      setPanning(true);
    }
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('mousedown', onDown, true);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('mousedown', onDown, true);
    };
  }, []);

  // Pan and rubber-band select (left drag on empty) are driven by window
  // listeners so a release anywhere reliably finalizes the gesture.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (pan.current.active) {
        setView(v => ({ ...v, offsetX: pan.current.ox + (px - pan.current.sx), offsetY: pan.current.oy + (py - pan.current.sy) }));
      } else if (bandRef.current.active) {
        if (Math.abs(px - bandRef.current.sx) > 3 || Math.abs(py - bandRef.current.sy) > 3) bandRef.current.moved = true;
        bandRef.current.x1 = px; bandRef.current.y1 = py;
        setBand({ x0: bandRef.current.sx, y0: bandRef.current.sy, x1: px, y1: py });
      }
    }
    function onUp() {
      if (pan.current.active) { pan.current.active = false; setPanning(false); return; }
      if (!bandRef.current.active) return;
      const b = bandRef.current;
      const st = useProjectStore.getState();
      const sc = st.project?.scenes.find(s => s.id === st.selectedSceneId);
      if (b.moved && sc) {
        const v = viewRef.current;
        const minX = Math.min(b.sx, b.x1), maxX = Math.max(b.sx, b.x1);
        const minY = Math.min(b.sy, b.y1), maxY = Math.max(b.sy, b.y1);
        const hits = sc.objects.filter(o => {
          const sx = v.offsetX + worldX(o.position.x) * v.scale;
          const sy = v.offsetY + worldY(o.position.y) * v.scale;
          return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
        }).map(o => o.id);
        st.selectMany(hits);
      } else {
        st.selectObject(null);
      }
      bandRef.current.active = false;
      setBand(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (e.target !== e.target.getStage()) return; // an object handles its own press
    const stage = e.target.getStage()!;
    const p = stage.getPointerPosition()!;
    // Middle / Alt+left never reach here — the container's capture listener pans instead.
    if (e.evt.button === 0) {
      bandRef.current = { active: true, sx: p.x, sy: p.y, x1: p.x, y1: p.y, moved: false };
      setBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
  }

  // ---- selection & click-through -----------------------------------------
  // Clicking again in the same spot walks *down* the stack, so an object covered
  // by another can be selected without moving anything: click 1 takes the object
  // the event landed on, each further click the next one below it, wrapping at
  // the bottom. Hit-testing uses the canvas' own approximate bounds
  // (geometry.objectBounds) rather than Konva's hit graph, so equations in the
  // HTML overlay are part of the same stack as Konva shapes.
  function pickCycle(id: string, client: { x: number; y: number }): string {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return id;
    const sx = client.x - rect.left, sy = client.y - rect.top;
    const w = screenToWorld(sx, sy, viewRef.current);
    const mx = manimX(w.x), my = manimY(w.y);
    const frozen = new Set(previewFrozenIds);
    const hits = objects
      .filter(o => o.visible && o.type !== 'group' && !frozen.has(o.id))
      .filter(o => {
        const b = objectBounds(o);
        return Math.abs(mx - b.cx) <= b.hw && Math.abs(my - b.cy) <= b.hh;
      })
      // Topmost first — the order Manim stacks them: z_index, then scene order.
      .sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0) || objects.indexOf(b) - objects.indexOf(a));
    if (hits.length < 2) return id;
    const c = cycleRef.current;
    const from = hits.findIndex(h => h.id === (cycleContinues(c, sx, sy) ? c!.id : id));
    if (from < 0) return id; // the clicked object isn't in the hit set — trust the event
    const next = cycleContinues(c, sx, sy) ? hits[(from + 1) % hits.length] : hits[from];
    cycleRef.current = { sx, sy, id: next.id };
    return next.id;
  }

  // The walk continues only while the clicks land on the same spot and the
  // selection is still what the last one made it; anything else restarts on top.
  function cycleContinues(c: { sx: number; sy: number; id: string } | null, sx: number, sy: number): boolean {
    return !!c && Math.abs(sx - c.sx) <= CYCLE_PX && Math.abs(sy - c.sy) <= CYCLE_PX
      && selectedIds.length === 1 && selectedIds[0] === c.id;
  }

  // Is a click-through walk currently parked on this spot? (A press there must
  // not reset the selection to the topmost object, or the walk can't continue.)
  function cycleHolds(client?: { x: number; y: number }): boolean {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!client || !rect) return false;
    return cycleContinues(cycleRef.current, client.x - rect.left, client.y - rect.top);
  }

  // `kind` distinguishes a press (which only makes sure something is selected so
  // it can be dragged) from a click (which does the stack-walking above).
  function handleSelect(id: string, additive: boolean, client?: { x: number; y: number }, kind: 'press' | 'click' = 'click') {
    if (additive) { toggleSelect(id); return; }
    if (selectedIds.length > 1 && selectedIds.includes(id)) return; // keep a multi-selection draggable
    if (kind === 'press') {
      if (!selectedIds.includes(id) && !cycleHolds(client)) selectObject(id);
      return;
    }
    const next = client ? pickCycle(id, client) : id;
    if (!selectedIds.includes(next) || selectedIds.length > 1) selectObject(next);
  }

  // While dragging one member of a multi-selection, publish the live delta so the
  // rest of the selection (Konva + overlay) follows in real time.
  function onNodeDragMove(obj: SceneObject, node: Konva.Node) {
    if (selectedIds.length > 1 && selectedIds.includes(obj.id)) {
      setGroupDrag({ anchorId: obj.id, dx: manimX(node.x()) - obj.position.x, dy: manimY(node.y()) - obj.position.y });
    }
  }

  // Commit a drag: if the dragged object is part of a multi-selection, move the
  // whole selection by the same delta; otherwise just move the one object.
  function commitDrag(obj: SceneObject, node: Konva.Node) {
    const nx = manimX(node.x()), ny = manimY(node.y());
    if (selectedIds.length > 1 && selectedIds.includes(obj.id)) {
      // Commit the positions and clear the live offset in one flush. Otherwise the
      // store update (via useSyncExternalStore) can re-render on its own before the
      // groupDrag clear lands, and each follower renders at (already-moved position)
      // + (stale drag delta) — a visible teleport in the drag direction.
      flushSync(() => {
        moveObjectsBy(selectedIds, nx - obj.position.x, ny - obj.position.y);
        setGroupDrag(null);
      });
    } else {
      moveObject(obj.id, nx, ny);
      setGroupDrag(null);
    }
  }

  // Commit an image resize/rotate: the Transformer changed the node's scale +
  // rotation, so bake them into width/height/rotation props and recenter the node
  // (keeping the fixed anchor put), all in one undo entry. Konva stores scale, not
  // size, so reset scale to 1 and fold it into the width/height we persist.
  function commitImageTransform(o: SceneObject, node: Konva.Node) {
    const wpx = Math.max(1, node.width() * node.scaleX());
    const hpx = Math.max(1, node.height() * node.scaleY());
    // Update the live node first (no flash before React re-renders from props):
    // new pixel size, centered offset, scale back to 1. Origin (x,y) stays the center.
    node.width(wpx); node.height(hpx);
    node.offsetX(wpx / 2); node.offsetY(hpx / 2);
    node.scaleX(1); node.scaleY(1);
    // Screen rotation is CW; Manim's baked `rotation` prop is CCW degrees → negate.
    const rotationProp = round2(-node.rotation());
    updateObject(o.id, {
      position: { x: round2(manimX(node.x())), y: round2(manimY(node.y())) },
      props: {
        ...o.props,
        width: round2(wpx / PX_PER_UNIT),
        height: round2(hpx / PX_PER_UNIT),
        rotation: rotationProp,
      },
    });
  }

  // Commit a rotate-gizmo release on a non-image object. Konva rotation is CW
  // screen degrees; the IR's baked `rotation` prop is Manim CCW degrees → negate.
  // Center-based types carry the prop (canvas + codegen rotate about the center);
  // point-based types (polygon, vector) bake the rotation into their own points
  // instead — mirroring finalState/codegen, which never put `rotation` on them.
  // The Transformer pivots about the node's bounding-box center by adjusting its
  // x/y, so the position is committed alongside.
  function commitObjectRotation(o: SceneObject, node: Konva.Node) {
    const theta = node.rotation();
    const pos = { x: round2(manimX(node.x())), y: round2(manimY(node.y())) };
    const p = o.props as Record<string, unknown>;
    const rad = (theta * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Rotate a Manim-space point by the node's screen rotation (about the node
    // origin) — the world-px round-trip handles the y flip.
    const rotPt = (v: { x?: number; y?: number } | undefined) => {
      const wx = worldX(Number(v?.x ?? 0)), wy = worldY(Number(v?.y ?? 0));
      return { x: round2(manimX(wx * cos - wy * sin)), y: round2(manimY(wx * sin + wy * cos)) };
    };
    if (o.type === 'shape' && p.subtype === 'polygon') {
      // Baked into the vertices below; reset the live node so react-konva (which
      // never sets rotation on this node) doesn't apply it twice.
      node.rotation(0);
      const verts = (Array.isArray(p.vertices) ? (p.vertices as { x?: number; y?: number }[]) : []).map(rotPt);
      updateObject(o.id, { position: pos, props: { ...p, vertices: verts } });
    } else if (o.type === 'geometry' && p.subtype === 'vector') {
      node.rotation(0);
      const dir = (p.direction ?? { x: 1, y: 0 }) as { x?: number; y?: number };
      updateObject(o.id, { position: pos, props: { ...p, direction: rotPt(dir) } });
    } else {
      updateObject(o.id, { position: pos, props: { ...p, rotation: round2(-theta) } });
    }
  }

  // Commit a dragged line-like endpoint (start/end point, in the shape's local coords).
  function commitEndpoint(id: string, which: 'start' | 'end', point: Point2D) {
    const o = objects.find(ob => ob.id === id);
    if (o) {
      const key = which === 'start' ? 'start_point' : 'end_point';
      updateObject(id, { props: { ...o.props, [key]: { x: round2(point.x), y: round2(point.y) } } });
    }
    setEndpointDrag(null);
  }

  return (
    <div ref={containerRef} className={`canvas-stage${panning ? ' canvas-stage--panning' : ''}`}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: bgColor }}>
      <Stage
        width={size.w}
        height={size.h}
        x={view.offsetX}
        y={view.offsetY}
        scaleX={view.scale}
        scaleY={view.scale}
        onMouseDown={onStageMouseDown}
        onMouseMove={e => {
          // Reset the cursor over empty canvas; shapes set 'move' on hover. This
          // also recovers if a hovered shape disappears (e.g. is deleted).
          const stage = e.target.getStage();
          if (stage && e.target === stage) stage.container().style.cursor = 'default';
        }}
      >
        <Layer>
          <Rect
            listening={false}
            x={-(FRAME_WIDTH / 2) * PX_PER_UNIT}
            y={-(FRAME_HEIGHT / 2) * PX_PER_UNIT}
            width={FRAME_WIDTH * PX_PER_UNIT}
            height={FRAME_HEIGHT * PX_PER_UNIT}
            stroke="rgba(255,255,255,0.28)"
            strokeWidth={1}
            dash={[8, 8]}
          />
          <SceneNodes
            objects={objects}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onCommitDrag={commitDrag}
            nonInteractiveIds={previewFrozenIds}
            viewScale={view.scale}
            endpointDrag={endpointDrag}
            onEndpointDrag={(id, which, point) => setEndpointDrag({ id, which, point })}
            onEndpointCommit={commitEndpoint}
            groupDrag={groupDrag}
            onNodeDragMove={onNodeDragMove}
            onCommitTransform={commitImageTransform}
            onCommitRotate={commitObjectRotation}
          />
          {showCamera && (
            <Rect
              x={worldX(camCenter.x) - camHalfWpx}
              y={worldY(camCenter.y) - camHalfHpx}
              width={camHalfWpx * 2}
              height={camHalfHpx * 2}
              fillEnabled={false}
              stroke="#0891b2"
              strokeWidth={2}
              dash={[10, 6]}
              draggable={camDraggable}
              listening={camDraggable}
              hitStrokeWidth={20}
              onDragEnd={e => commitCameraPan(manimX(e.target.x() + camHalfWpx), manimY(e.target.y() + camHalfHpx))}
            />
          )}
          {previewArrows.map(a => (
            <Arrow key={`arr-${a.kf.id}`}
              points={[worldX(a.from.x), worldY(a.from.y), worldX(a.to.x), worldY(a.to.y)]}
              stroke="#ea580c" fill="#ea580c" strokeWidth={2} dash={[9, 5]}
              pointerLength={11} pointerWidth={10} listening={false} opacity={0.9}
            />
          ))}
          {rotatePreviews.map(r => (
            // Pivot guides for an anchored rotate: radius lines to the start and
            // end centers, the swept arc, and (when not the draggable ⊕ handle,
            // which lives in the HTML overlay) a small pivot marker.
            <Group key={`rot-${r.kf.id}`} listening={false}>
              <Line points={[worldX(r.anchor!.x), worldY(r.anchor!.y), worldX(r.from.x), worldY(r.from.y)]}
                stroke="#a855f7" strokeWidth={1.5} dash={[4, 4]} opacity={0.65} />
              <Line points={[worldX(r.anchor!.x), worldY(r.anchor!.y), worldX(r.to.x), worldY(r.to.y)]}
                stroke="#a855f7" strokeWidth={1.5} dash={[4, 4]} opacity={0.65} />
              <Line points={arcPoints(r.anchor!, r.from, r.angleDeg)}
                stroke="#a855f7" strokeWidth={2} dash={[7, 5]} opacity={0.9} />
              {r.kf.id !== anchorKf?.id && (
                <Circle x={worldX(r.anchor!.x)} y={worldY(r.anchor!.y)}
                  radius={5 / view.scale} stroke="#a855f7" strokeWidth={1.5 / view.scale} />
              )}
            </Group>
          ))}
        </Layer>
        {ghostShapes.length > 0 && (
          <Layer listening={false} opacity={0.42}>
            {ghostShapes.map(g => {
              const cx = worldX(g.obj.position.x);
              const cy = worldY(g.obj.position.y);
              // Rotate/scale about the object's center; Konva rotation is CW on
              // screen, Manim degrees are CCW in math space → negate.
              return (
                <Group key={g.key} x={cx} y={cy} offsetX={cx} offsetY={cy}
                  scaleX={g.scale} scaleY={g.scale} rotation={-g.rotationDeg}>
                  <SceneNodes objects={[g.obj]} selectedIds={[]} onSelect={() => {}} onCommitDrag={() => {}} />
                </Group>
              );
            })}
          </Layer>
        )}
        {dragItem && !isLatexLike(dragItem.ghost.obj) && (
          <Layer>
            <Circle
              x={worldX(dragItem.to.x)} y={worldY(dragItem.to.y)}
              radius={9 / view.scale} fill="#ea580c" stroke="#ffffff" strokeWidth={1.5 / view.scale}
              hitStrokeWidth={24 / view.scale}
              draggable
              onMouseDown={e => { e.cancelBubble = true; }}
              onDragMove={e => setHandleDrag({ id: dragItem.kf.id, pos: { x: manimX(e.target.x()), y: manimY(e.target.y()) } })}
              onDragEnd={e => { commitMoveDestination(manimX(e.target.x()), manimY(e.target.y())); setHandleDrag(null); }}
            />
          </Layer>
        )}
      </Stage>

      {showCamera && (
        <div className="camera-hud">
          <span className="camera-hud__title">📷 {camKf ? `Camera @ ${camKf.start_time.toFixed(1)}s` : 'Initial camera'}</span>
          <label className="camera-hud__zoom">
            Zoom
            <input type="number" step={0.1} min={0.1} value={camZoom}
              onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setCamZoom(v); }} />
          </label>
          {focusObj
            ? <span className="camera-hud__hint">tracking {focusObj.name || focusObj.type}</span>
            : <span className="camera-hud__hint">drag the frame to pan</span>}
          <button className="btn btn--ghost" onClick={resetCamera}>Reset</button>
        </div>
      )}

      <LatexOverlay
        onSelect={handleSelect}
        objects={objects}
        view={view}
        ghosts={ghostLatex}
        nonInteractiveIds={previewFrozenIds}
        groupDrag={groupDrag}
        onGroupDrag={setGroupDrag}
        moveHandle={dragItem && isLatexLike(dragItem.ghost.obj) ? {
          pos: dragItem.to,
          onDragMove: pos => setHandleDrag({ id: dragItem.kf.id, pos }),
          onCommit: pos => { commitMoveDestination(pos.x, pos.y); setHandleDrag(null); },
        } : null}
        anchorHandle={anchorKf && anchorPos ? {
          pos: anchorPos,
          onDragMove: pos => setAnchorDrag({ id: anchorKf.id, pos: snapAnchor(pos) }),
          onCommit: pos => { commitRotateAnchor(pos); setAnchorDrag(null); },
        } : null}
      />

      {band && (
        <div style={{
          position: 'absolute', pointerEvents: 'none', border: '1px solid var(--accent)',
          background: 'rgba(37,99,235,0.12)',
          left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1),
          width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0),
        }} />
      )}

      <div className="canvas-toolbar">
        <label title="Snap objects to the center lines while dragging">
          <input type="checkbox" checked={snapToCenter} onChange={e => setSnapToCenter(e.target.checked)} />
          Snap to center
        </label>
        <button type="button" className="canvas-toolbar__btn" onClick={fitView}
          title="Fit the frame in view — scroll or Alt+drag to pan, pinch or Ctrl+scroll to zoom">
          Fit
        </button>
      </div>

      {objects.length === 0 && (
        <div className="canvas-empty">Add an object from the left panel to begin.</div>
      )}
    </div>
  );
}
