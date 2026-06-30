import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Rect } from 'react-konva';
import type Konva from 'konva';
import { useProjectStore } from '../store/projectStore';
import { useTimelineStore, CAMERA_ID } from '../timeline/timelineStore';
import type { SceneObject } from '../types/ir';
import { LatexOverlay } from './LatexOverlay';
import { SceneNodes } from './SceneNodes';
import {
  PX_PER_UNIT, FRAME_WIDTH, FRAME_HEIGHT,
  MIN_SCALE, MAX_SCALE, manimX, manimY, worldX, worldY, type View,
} from './coords';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function CanvasStage() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const toggleSelect = useProjectStore(s => s.toggleSelect);
  const moveObject = useProjectStore(s => s.moveObject);
  const moveObjectsBy = useProjectStore(s => s.moveObjectsBy);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const updateCameraTrack = useProjectStore(s => s.updateCameraTrack);
  const selectedKfIds = useTimelineStore(s => s.selectedKfIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const centered = useRef(false);
  const viewRef = useRef(view); viewRef.current = view;
  const pan = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  const bandRef = useRef<{ active: boolean; sx: number; sy: number; x1: number; y1: number; moved: boolean }>(
    { active: false, sx: 0, sy: 0, x1: 0, y1: 0, moved: false });

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const bgColor = scene?.background_color || project?.settings.background_color || '#000000';

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
  const showCamera = !!camKf || trackActive || hasCameraKf;
  const focusObj = camKf && camParams.focus_object_id ? objects.find(o => o.id === camParams.focus_object_id) : undefined;
  const camZoom = camKf ? Number(camParams.zoom ?? 1) : (camTrack?.initial_zoom ?? 1);
  const camCenter = camKf
    ? (focusObj ? focusObj.position : (camParams.pan ?? { x: 0, y: 0 }))
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!centered.current && size.w > 0 && size.h > 0) {
      const fitW = size.w / (FRAME_WIDTH * PX_PER_UNIT);
      const fitH = size.h / (FRAME_HEIGHT * PX_PER_UNIT);
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(fitW, fitH) * 0.92));
      setView({ scale, offsetX: size.w / 2, offsetY: size.h / 2 });
      centered.current = true;
    }
  }, [size]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView(v => {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
        const wx = (px - v.offsetX) / v.scale;
        const wy = (py - v.offsetY) / v.scale;
        return { scale: newScale, offsetX: px - wx * newScale, offsetY: py - wy * newScale };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pan (middle mouse) and rubber-band select (left drag on empty) are driven by
  // window listeners so a release anywhere reliably finalizes the gesture.
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
      if (pan.current.active) { pan.current.active = false; return; }
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
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      pan.current = { active: true, sx: p.x, sy: p.y, ox: view.offsetX, oy: view.offsetY };
    } else if (e.evt.button === 0) {
      bandRef.current = { active: true, sx: p.x, sy: p.y, x1: p.x, y1: p.y, moved: false };
      setBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
  }

  function handleSelect(id: string, additive: boolean) {
    if (additive) toggleSelect(id);
    else if (!selectedIds.includes(id)) selectObject(id);
  }

  // Commit a drag: if the dragged object is part of a multi-selection, move the
  // whole selection by the same delta; otherwise just move the one object.
  function commitDrag(obj: SceneObject, node: Konva.Node) {
    const nx = manimX(node.x()), ny = manimY(node.y());
    if (selectedIds.length > 1 && selectedIds.includes(obj.id)) {
      moveObjectsBy(selectedIds, nx - obj.position.x, ny - obj.position.y);
    } else {
      moveObject(obj.id, nx, ny);
    }
  }

  return (
    <div ref={containerRef} className="canvas-stage" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: bgColor }}>
      <Stage
        width={size.w}
        height={size.h}
        x={view.offsetX}
        y={view.offsetY}
        scaleX={view.scale}
        scaleY={view.scale}
        onMouseDown={onStageMouseDown}
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
        </Layer>
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

      <LatexOverlay objects={objects} view={view} />

      {band && (
        <div style={{
          position: 'absolute', pointerEvents: 'none', border: '1px solid var(--accent)',
          background: 'rgba(37,99,235,0.12)',
          left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1),
          width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0),
        }} />
      )}

      {objects.length === 0 && (
        <div className="canvas-empty">Add an object from the left panel to begin.</div>
      )}
    </div>
  );
}
