import { useEffect, useRef, useState } from 'react';
import { Stage, Layer } from 'react-konva';
import type Konva from 'konva';
import { useProjectStore } from '../store/projectStore';
import type { SceneObject } from '../types/ir';
import { LatexOverlay } from './LatexOverlay';
import { SceneNodes } from './SceneNodes';
import { MIN_SCALE, MAX_SCALE, manimX, manimY, type View } from './coords';

export function CanvasStage() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const moveObject = useProjectStore(s => s.moveObject);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const centered = useRef(false);
  const pan = useRef<{ active: boolean; sx: number; sy: number; ox: number; oy: number; moved: boolean }>(
    { active: false, sx: 0, sy: 0, ox: 0, oy: 0, moved: false },
  );

  const scene = project?.scenes.find(s => s.id === selectedSceneId);

  // Preview on the same background the scene renders against (Manim default: black),
  // so white equations/strokes are visible just like in the final export.
  const bgColor = scene?.background_color || project?.settings.background_color || '#000000';

  // Measure container + keep Stage sized to it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Center the world origin once we know the size.
  useEffect(() => {
    if (!centered.current && size.w > 0 && size.h > 0) {
      setView(v => ({ ...v, offsetX: size.w / 2, offsetY: size.h / 2 }));
      centered.current = true;
    }
  }, [size]);

  // Wheel zoom (native, non-passive so preventDefault works).
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

  function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (e.target === e.target.getStage()) {
      const stage = e.target.getStage()!;
      const p = stage.getPointerPosition()!;
      pan.current = { active: true, sx: p.x, sy: p.y, ox: view.offsetX, oy: view.offsetY, moved: false };
    }
  }
  function onStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!pan.current.active) return;
    const stage = e.target.getStage()!;
    const p = stage.getPointerPosition()!;
    const dx = p.x - pan.current.sx;
    const dy = p.y - pan.current.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.current.moved = true;
    setView(v => ({ ...v, offsetX: pan.current.ox + dx, offsetY: pan.current.oy + dy }));
  }
  function onStageMouseUp() {
    if (pan.current.active && !pan.current.moved) {
      selectObject(null);
    }
    pan.current.active = false;
  }

  // Safety: end panning even if the mouse is released outside the stage.
  useEffect(() => {
    const stop = () => { pan.current.active = false; };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  function commitDrag(obj: SceneObject, node: Konva.Node) {
    moveObject(obj.id, manimX(node.x()), manimY(node.y()));
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
        onMouseMove={onStageMouseMove}
        onMouseUp={onStageMouseUp}
      >
        <Layer>
          <SceneNodes
            objects={scene?.objects ?? []}
            selectedIds={selectedIds}
            onSelect={selectObject}
            onCommitDrag={commitDrag}
          />
        </Layer>
      </Stage>

      <LatexOverlay objects={scene?.objects ?? []} view={view} />

      {(scene?.objects.length ?? 0) === 0 && (
        <div className="canvas-empty">
          Add an object from the left panel to begin.
        </div>
      )}
    </div>
  );
}
