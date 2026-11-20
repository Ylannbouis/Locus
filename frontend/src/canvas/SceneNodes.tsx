import { useEffect, useRef, useState } from 'react';
import { Rect, Circle as KCircle, Ellipse, Line, Arrow, Group, Path, Text, Image as KImage, Transformer } from 'react-konva';
import type Konva from 'konva';
import type { ImageProps, Point2D, SceneObject } from '../types/ir';
import { PX_PER_UNIT, MANIM_EM_UNITS_PER_PT, SNAP_PX, worldX, worldY, manimX, manimY } from './coords';
import { samplePlot, sampleParametric, sampleVectorField, vectorFieldColor } from './plotting';
import { objectBounds, lineSegment, intersect, BRACE_BUFF, BRACE_DEPTH } from './geometry';
import { useCanvasStore } from '../store/canvasStore';
import { useProjectStore } from '../store/projectStore';
import { assetUrl } from '../api/client';

// Snap a node's drag onto the horizontal/vertical center lines when it lands
// within SNAP_PX of them. dragBoundFunc works in absolute (screen) pixels, and
// the Manim origin sits at the stage's own (x, y), so snapping each axis to the
// stage position pulls the object's drag reference onto that center line.
// Skipped while several objects are selected (a group move shouldn't snap on one
// member's edge, which would shift the whole group unexpectedly).
function snapDragBound(this: Konva.Node, pos: { x: number; y: number }) {
  if (!useCanvasStore.getState().snapToCenter) return pos;
  if (useProjectStore.getState().selectedObjectIds.length > 1) return pos;
  const stage = this.getStage();
  if (!stage) return pos;
  const cx = stage.x(), cy = stage.y();
  return {
    x: Math.abs(pos.x - cx) <= SNAP_PX ? cx : pos.x,
    y: Math.abs(pos.y - cy) <= SNAP_PX ? cy : pos.y,
  };
}

// Build an SVG path for a brace along a baseline (world px). axis 'h' or 'v';
// `sign` is the direction the tip points (away from the target).
function bracePath(a0: number, a1: number, base: number, depth: number, axis: 'h' | 'v', sign: number): string {
  const mid = (a0 + a1) / 2;
  const m = base + sign * depth * 0.5;
  const tip = base + sign * depth;
  if (axis === 'h') {
    return `M ${a0} ${base} Q ${a0} ${m} ${(a0 + mid) / 2} ${m} Q ${mid} ${m} ${mid} ${tip} Q ${mid} ${m} ${(mid + a1) / 2} ${m} Q ${a1} ${m} ${a1} ${base}`;
  }
  return `M ${base} ${a0} Q ${m} ${a0} ${m} ${(a0 + mid) / 2} Q ${m} ${mid} ${tip} ${mid} Q ${m} ${mid} ${m} ${(mid + a1) / 2} Q ${m} ${a1} ${base} ${a1}`;
}

function hexToRgba(hex: string | null | undefined, alpha: number): string {
  if (!hex) return 'rgba(0,0,0,0)';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex || 'rgba(0,0,0,0)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Decoded <img> elements by URL, shared across all canvas nodes (scene + ghost
// copies of the same asset reuse one decode).
const imageElementCache = new Map<string, HTMLImageElement>();

function useHtmlImage(src: string): HTMLImageElement | null {
  // The cache is read at render time; the effect only kicks off a load on a
  // miss and re-renders once the decode lands (no sync setState in the effect).
  const [, bump] = useState(0);
  useEffect(() => {
    if (!src || imageElementCache.has(src)) return;
    let cancelled = false;
    const el = new window.Image();
    el.onload = () => { imageElementCache.set(src, el); if (!cancelled) bump(n => n + 1); };
    el.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return (src && imageElementCache.get(src)) || null;
}

// An uploaded raster image. Renders a dashed placeholder box (same size, same
// handlers) until the asset finishes loading, so it stays selectable/draggable.
// When selected (and interactive), a Konva Transformer overlays resize handles on
// the corners/edges plus a rotate handle — corners keep the aspect ratio (Manim's
// ImageMobject is a single raster, so a proportional resize is the natural gesture),
// edges stretch one axis. The resulting scale/rotation are baked back into the
// width/height/rotation props on release (`onCommitTransform`).
function ImageNode({ o, common, interactive, selected, viewScale, onCommitTransform }: {
  o: SceneObject;
  common: Record<string, unknown>;
  interactive: boolean;
  selected: boolean;
  viewScale: number;
  onCommitTransform?: (o: SceneObject, node: Konva.Node) => void;
}) {
  const projectId = useProjectStore(s => s.project?.id);
  const p = o.props as Partial<ImageProps> & { rotation?: number };
  const src = projectId && p.asset ? assetUrl(projectId, String(p.asset)) : '';
  const el = useHtmlImage(src);
  const nodeRef = useRef<Konva.Node>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const showTransformer = interactive && selected;

  // Attach/detach the transformer to whichever node renders (placeholder → image
  // swaps the node identity, so re-run when `el` lands).
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    if (showTransformer && nodeRef.current) {
      tr.nodes([nodeRef.current]);
      tr.getLayer()?.batchDraw();
    } else {
      tr.nodes([]);
    }
  }, [showTransformer, el]);

  const w = Number(p.width ?? 4) * PXU, h = Number(p.height ?? 3) * PXU;
  // Baked rotation (Manim CCW degrees) → Konva CW screen rotation.
  const rot = -(Number(p.rotation) || 0);
  const opacity = Math.max(0, Math.min(1, Number(p.opacity ?? 1)));
  const size = { rotation: rot, width: w, height: h, offsetX: w / 2, offsetY: h / 2, opacity };

  const node = el
    ? <KImage ref={nodeRef as React.Ref<Konva.Image>} {...common} {...size} image={el} />
    : <Rect ref={nodeRef as React.Ref<Konva.Rect>} {...common} {...size} fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.6)" dash={[6, 4]} strokeWidth={1.5} />;

  if (!showTransformer) return node;

  const s = Math.max(1e-6, viewScale); // keep handles a constant on-screen size
  return (
    <>
      {node}
      <Transformer
        ref={trRef}
        keepRatio
        rotateEnabled
        flipEnabled={false}
        ignoreStroke
        anchorSize={9 / s}
        anchorStrokeWidth={1.5 / s}
        anchorCornerRadius={2 / s}
        borderStrokeWidth={1.5 / s}
        rotateAnchorOffset={26 / s}
        anchorStroke="#ffffff"
        anchorFill="#ea580c"
        borderStroke="#ea580c"
        rotationSnaps={[0, 90, 180, 270]}
        rotationSnapTolerance={4}
        // Don't let a resize collapse the image below ~4px on screen.
        boundBoxFunc={(oldBox, newBox) =>
          Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox}
        onTransformEnd={() => { if (nodeRef.current) onCommitTransform?.(o, nodeRef.current); }}
      />
    </>
  );
}

// Rotate-only gizmo: the image Transformer minus the resize anchors. Wraps a
// lone-selected rotatable node; releasing the rotate anchor hands the live node
// to `onEnd` (CanvasStage.commitObjectRotation), which bakes the rotation into
// the object's props.
function Rotatable({ show, viewScale, onEnd, children }: {
  show: boolean;
  viewScale: number;
  onEnd: (node: Konva.Node) => void;
  children: (ref: React.MutableRefObject<Konva.Node | null>) => React.ReactNode;
}) {
  const nodeRef = useRef<Konva.Node | null>(null);
  const trRef = useRef<Konva.Transformer>(null);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    if (show && nodeRef.current) {
      tr.nodes([nodeRef.current]);
      tr.getLayer()?.batchDraw();
    } else {
      tr.nodes([]);
    }
  }, [show]);

  if (!show) return <>{children(nodeRef)}</>;
  const s = Math.max(1e-6, viewScale); // keep the handle a constant on-screen size
  return (
    <>
      {children(nodeRef)}
      <Transformer
        ref={trRef}
        resizeEnabled={false}
        rotateEnabled
        flipEnabled={false}
        ignoreStroke
        anchorSize={9 / s}
        anchorStrokeWidth={1.5 / s}
        anchorCornerRadius={2 / s}
        borderStrokeWidth={1.5 / s}
        rotateAnchorOffset={26 / s}
        anchorStroke="#ffffff"
        anchorFill="#ea580c"
        borderStroke="#ea580c"
        rotationSnaps={[0, 90, 180, 270]}
        rotationSnapTolerance={4}
        onTransformEnd={() => { if (nodeRef.current) onEnd(nodeRef.current); }}
      />
    </>
  );
}

interface Props {
  objects: SceneObject[];
  selectedIds: string[];
  // `client` is where the click landed (viewport px) — the stage uses it to walk
  // down the stack when the same spot is clicked again.
  onSelect: (id: string, additive: boolean, client?: { x: number; y: number }) => void;
  onCommitDrag: (o: SceneObject, node: Konva.Node) => void;
  // Objects being edited via a move/scale/rotate keyframe preview must not steal
  // pointer events from the destination drag handle.
  nonInteractiveIds?: string[];
  // Current view scale, so on-canvas handles keep a constant screen size.
  viewScale?: number;
  // Live override + callbacks for dragging a selected line-like shape's endpoints.
  endpointDrag?: { id: string; which: 'start' | 'end'; point: Point2D } | null;
  onEndpointDrag?: (id: string, which: 'start' | 'end', point: Point2D) => void;
  onEndpointCommit?: (id: string, which: 'start' | 'end', point: Point2D) => void;
  // Live multi-select drag: while `anchorId` is being dragged, every *other*
  // selected object renders offset by (dx, dy) so the whole set moves together.
  groupDrag?: { anchorId: string; dx: number; dy: number } | null;
  onNodeDragMove?: (o: SceneObject, node: Konva.Node) => void;
  // Commit a resize/rotate of the selected image (Transformer released): reads the
  // node's final scale/rotation and bakes them into the width/height/rotation props.
  onCommitTransform?: (o: SceneObject, node: Konva.Node) => void;
  // Commit a rotate-gizmo release on a non-image object: bakes the node's rotation
  // into the `rotation` prop (center-based types) or the points (polygon/vector).
  onCommitRotate?: (o: SceneObject, node: Konva.Node) => void;
  // Playback preview (canvas/playback.ts): per-object opacity. When given, every
  // node is wrapped in a non-listening Group at that opacity.
  opacities?: Record<string, number>;
}

// Stroke trace for an in-flight drawing verb (playback preview only): the
// transient `__draw` prop ∈ (0,1) on a baked clone, or null when fully drawn.
function drawOf(p: Record<string, unknown>): number | null {
  const d = Number(p.__draw);
  return Number.isFinite(d) && d < 1 ? Math.max(0, d) : null;
}

// Dash pattern that shows the first `d` of a closed outline of length `len`.
function traceDash(len: number, d: number | null): number[] | undefined {
  return d == null ? undefined : [Math.max(0.001, len * d), len + 1];
}

const PXU = PX_PER_UNIT;
// Extra clickable padding (world px) around thin/open shapes so lines, arrows
// and curves are easy to grab even where they're only a couple of pixels wide.
const HIT = 16;

// Ramanujan's approximation — plenty for a dash-trace preview.
function ellipsePerimeter(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

function rng(v: unknown, fb: number[]): number[] {
  return Array.isArray(v) && v.length >= 2 ? (v as number[]) : fb;
}

// Format a tick value for display: trim floating-point fuzz and drop the
// decimal point entirely for whole numbers (so 2 shows as "2", not "2.0").
function fmtNum(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  if (Object.is(r, -0)) return '0';
  return String(r);
}

// Manim number font_size (points) -> world px, using the same em calibration
// as the KaTeX overlay so preview sizes track the render roughly.
function numberPx(fs: number): number {
  return fs * MANIM_EM_UNITS_PER_PT * PX_PER_UNIT;
}

// Tick values from min..max, guarding against non-positive steps (infinite
// loops) and absurdly dense ranges (capped at 500 lines for the preview).
function safeTicks(min: number, max: number, step: number): number[] {
  const s = Math.abs(step) || 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const out: number[] = [];
  let v = Math.ceil(min);
  let guard = 0;
  while (v <= max && guard < 500) { out.push(v); v += s; guard++; }
  return out;
}

// Local-space child lines for a coordinate system (group sits at its center).
function coordChildren(o: SceneObject, stroke: string, sw: number) {
  const p = o.props as any;
  const st = p.subtype;
  const els: React.ReactNode[] = [];
  const faint = hexToRgba(o.style.stroke_color, 0.25);
  const showNums = !!p.include_numbers;
  const fs = numberPx(Number(p.number_font_size ?? 36));

  if (st === 'number_line') {
    const len = Number(p.length ?? 8) * PXU;
    els.push(<Line key="axis" points={[-len / 2, 0, len / 2, 0]} stroke={stroke} strokeWidth={sw} />);
    const [xmin, xmax, xstep = 1] = rng(p.x_range, [-5, 5, 1]);
    const span = (xmax - xmin) || 1;
    for (const x of safeTicks(xmin, xmax, xstep)) {
      const px = ((x - (xmin + xmax) / 2) / span) * len;
      els.push(<Line key={`t${x}`} points={[px, -6, px, 6]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(x);
        els.push(<Text key={`n${x}`} text={label} x={px} y={10} fontSize={fs} fill={stroke}
          offsetX={(label.length * fs * 0.55) / 2} />);
      }
    }
    return els;
  }

  const xLen = Number(p.x_length ?? 6) * PXU;
  const yLen = Number(p.y_length ?? 4) * PXU;
  const [xmin, xmax, xstep = 1] = rng(p.x_range, [-5, 5, 1]);
  const [ymin, ymax, ystep = 1] = rng(p.y_range, [-3, 3, 1]);
  const xmid = (xmin + xmax) / 2, ymid = (ymin + ymax) / 2;
  const xSpan = (xmax - xmin) || 1, ySpan = (ymax - ymin) || 1;
  const dataXpx = (x: number) => ((x - xmid) / xSpan) * xLen;
  const dataYpx = (y: number) => -((y - ymid) / ySpan) * yLen; // world flip
  const axisYpx = dataYpx(0);
  const axisXpx = dataXpx(0);

  if (st === 'number_plane') {
    for (const x of safeTicks(xmin, xmax, xstep)) {
      const px = dataXpx(x);
      els.push(<Line key={`gx${x}`} points={[px, -yLen / 2, px, yLen / 2]} stroke={faint} strokeWidth={1} />);
    }
    for (const y of safeTicks(ymin, ymax, ystep)) {
      const py = dataYpx(y);
      els.push(<Line key={`gy${y}`} points={[-xLen / 2, py, xLen / 2, py]} stroke={faint} strokeWidth={1} />);
    }
  }

  // axes lines (with optional arrow tips at the positive ends, matching Manim)
  const tips = st === 'axes' && !!p.tips;
  if (tips) {
    const tip = 0.18 * PXU;
    els.push(<Arrow key="xaxis" points={[-xLen / 2, axisYpx, xLen / 2, axisYpx]} stroke={stroke} fill={stroke} strokeWidth={sw} pointerLength={tip} pointerWidth={tip} />);
    els.push(<Arrow key="yaxis" points={[axisXpx, yLen / 2, axisXpx, -yLen / 2]} stroke={stroke} fill={stroke} strokeWidth={sw} pointerLength={tip} pointerWidth={tip} />);
  } else {
    els.push(<Line key="xaxis" points={[-xLen / 2, axisYpx, xLen / 2, axisYpx]} stroke={stroke} strokeWidth={sw} />);
    els.push(<Line key="yaxis" points={[axisXpx, -yLen / 2, axisXpx, yLen / 2]} stroke={stroke} strokeWidth={sw} />);
  }

  if (st === 'axes') {
    for (const x of safeTicks(xmin, xmax, xstep)) {
      if (Math.abs(x) < 1e-9) continue;
      const px = dataXpx(x);
      els.push(<Line key={`tx${x}`} points={[px, axisYpx - 5, px, axisYpx + 5]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(x);
        els.push(<Text key={`nx${x}`} text={label} x={px} y={axisYpx + 8} fontSize={fs} fill={stroke}
          offsetX={(label.length * fs * 0.55) / 2} />);
      }
    }
    for (const y of safeTicks(ymin, ymax, ystep)) {
      if (Math.abs(y) < 1e-9) continue;
      const py = dataYpx(y);
      els.push(<Line key={`ty${y}`} points={[axisXpx - 5, py, axisXpx + 5, py]} stroke={stroke} strokeWidth={sw} />);
      if (showNums) {
        const label = fmtNum(y);
        els.push(<Text key={`ny${y}`} text={label} x={axisXpx - 8} y={py} fontSize={fs} fill={stroke}
          offsetX={label.length * fs * 0.55} offsetY={fs / 2} />);
      }
    }
  }
  return els;
}

export function SceneNodes({ objects, selectedIds, onSelect, onCommitDrag, nonInteractiveIds = [], viewScale = 1, endpointDrag = null, onEndpointDrag, onEndpointCommit, groupDrag = null, onNodeDragMove, onCommitTransform, onCommitRotate, opacities }: Props) {
  const frozen = new Set(nonInteractiveIds);

  const renderNode = (o: SceneObject): React.ReactNode => {
    if (!o.visible) return null;
    if (o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix') return null; // handled by overlay

    const isSel = selectedIds.includes(o.id);
    const isFrozen = frozen.has(o.id);
    const stroke = hexToRgba(o.style.stroke_color, o.style.stroke_opacity ?? 1);
    const strokeWidth = Number(o.style.stroke_width ?? 2);
    const fill = hexToRgba(o.style.fill_color, o.style.fill_opacity ?? 0);
    const sel = isSel ? { shadowColor: '#2563eb', shadowBlur: 10, shadowOpacity: 1 } : {};
    // During a multi-select drag, follow the anchor: offset every *other* selected
    // object by the live delta. The anchor keeps its stored position (Konva drives
    // it), so its `x`/`y` props don't change mid-drag and Konva doesn't reset it.
    const follow = groupDrag && groupDrag.anchorId !== o.id && isSel;
    const px = o.position.x + (follow ? groupDrag!.dx : 0);
    const py = o.position.y + (follow ? groupDrag!.dy : 0);
    const pos = { x: worldX(px), y: worldY(py) };
    // Show the move cursor over any selectable object (matches the equations).
    const hover = isFrozen ? {} : {
      onMouseEnter: (e: Konva.KonvaEventObject<MouseEvent>) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'move'; },
      onMouseLeave: (e: Konva.KonvaEventObject<MouseEvent>) => { const st = e.target.getStage(); if (st) st.container().style.cursor = 'default'; },
    };
    const drag = isFrozen ? { draggable: false, listening: false } : {
      draggable: true,
      dragBoundFunc: snapDragBound,
      ...hover,
      onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; },
      onClick: (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey, { x: e.evt.clientX, y: e.evt.clientY }); },
      onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => { if (!isSel) onSelect(o.id, false); void e; },
      onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onNodeDragMove?.(o, e.target),
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onCommitDrag(o, e.target),
    };
    const common = { key: o.id, ...pos, ...drag, ...sel };
    const p = o.props as any;
    const draw = drawOf(p);
    // Rotate gizmo only for a lone selection (same rule as the image Transformer
    // and endpoint handles — avoids clutter/conflicts during multi-select moves).
    const canRotate = isSel && selectedIds.length === 1 && !isFrozen && !!onCommitRotate;
    const rotEnd = (n: Konva.Node) => onCommitRotate!(o, n);

    if (o.type === 'image') {
      // Resize/rotate handles only for a lone selection (avoid clutter / conflicts
      // when several objects are selected and moved together).
      return <ImageNode key={o.id} o={o} common={common} interactive={!isFrozen}
        selected={isSel && selectedIds.length === 1} viewScale={viewScale} onCommitTransform={onCommitTransform} />;
    }

    if (o.type === 'shape') {
      const st = p.subtype;
      // Baked rotation (Manim CCW degrees). Konva rotation is CW on screen (y-down),
      // so negate; rect/ellipse pivot about their center (origin already centered).
      const rot = -(Number(p.rotation) || 0);
      if (st === 'circle') {
        const r = Number(p.radius ?? 1) * PXU;
        // Manim draws a circle CCW from 3 o'clock; Konva's dash runs clockwise on
        // screen, so mirror the (symmetric) circle while it traces.
        return <KCircle {...common} radius={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          dash={traceDash(2 * Math.PI * Math.abs(r), draw)} scaleY={draw == null ? 1 : -1} />;
      }
      if (st === 'ellipse') {
        return (
          <Rotatable key={o.id} show={canRotate} viewScale={viewScale} onEnd={rotEnd}>
            {ref => <Ellipse ref={ref as React.Ref<Konva.Ellipse>} {...common} rotation={rot} radiusX={(Number(p.width ?? 2) / 2) * PXU} radiusY={(Number(p.height ?? 1.2) / 2) * PXU} fill={fill} stroke={stroke} strokeWidth={strokeWidth}
              dash={traceDash(ellipsePerimeter(Number(p.width ?? 2) / 2 * PXU, Number(p.height ?? 1.2) / 2 * PXU), draw)} />}
          </Rotatable>
        );
      }
      if (st === 'polygon') {
        const pts: number[] = (p.vertices ?? []).flatMap((v: any) => [worldX(v.x), worldY(v.y)]);
        let per = 0;
        for (let i = 0; i < pts.length; i += 2) {
          const j = (i + 2) % pts.length;
          per += Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]);
        }
        return (
          <Rotatable key={o.id} show={canRotate} viewScale={viewScale} onEnd={rotEnd}>
            {ref => <Line ref={ref as React.Ref<Konva.Line>} {...common} points={pts} closed fill={fill} stroke={stroke} strokeWidth={strokeWidth} dash={traceDash(per, draw)} />}
          </Rotatable>
        );
      }
      if (st === 'line' || st === 'dashed_line' || st === 'arrow' || st === 'double_arrow') {
        // Line-likes render as a group at `position` so draggable endpoint handles
        // can share the translation (no lag when the whole shape moves). While an
        // endpoint is dragged, `endpointDrag` overrides it so the shape follows live.
        const arrowLike = st === 'arrow' || st === 'double_arrow';
        const live = (w: 'start' | 'end') =>
          endpointDrag && endpointDrag.id === o.id && endpointDrag.which === w ? endpointDrag.point : null;
        const startP = live('start') ?? (p.start_point ?? { x: 0, y: 0 });
        const fullEnd = live('end') ?? (p.end_point ?? { x: 0, y: 0 });
        // Playback preview: a Create/Write traces the line out from its start.
        const endP = draw == null ? fullEnd
          : { x: startP.x + (fullEnd.x - startP.x) * draw, y: startP.y + (fullEnd.y - startP.y) * draw };
        const sx = worldX(startP.x), sy = worldY(startP.y), ex = worldX(endP.x), ey = worldY(endP.y);
        const tip = Number(p.tip_length ?? 0.3) * PXU;
        const d = Number(p.dash_length ?? 0.15) * PXU;
        const shapeNode = arrowLike
          ? <Arrow points={[sx, sy, ex, ey]} stroke={stroke} fill={stroke} strokeWidth={strokeWidth} hitStrokeWidth={HIT}
              pointerLength={tip} pointerWidth={tip * 0.9} pointerAtBeginning={st === 'double_arrow'} {...sel} />
          : <Line points={[sx, sy, ex, ey]} stroke={stroke} strokeWidth={strokeWidth} hitStrokeWidth={HIT}
              dash={st === 'dashed_line' ? [d, d] : undefined} {...sel} />;
        if (isFrozen) return <Group key={o.id} {...pos} listening={false}>{shapeNode}</Group>;
        const hr = 8 / viewScale;
        // A single arrow exposes only its tip (end); everything else exposes both ends.
        const ends: [('start' | 'end'), number, number][] = st === 'arrow'
          ? [['end', ex, ey]]
          : [['start', sx, sy], ['end', ex, ey]];
        // Endpoint handles only for a lone selection (avoid clutter / drag conflicts
        // when several objects are selected and moved together).
        const canEdit = isSel && selectedIds.length === 1 && onEndpointDrag && onEndpointCommit;
        return (
          <Group key={o.id} {...pos} {...drag}>
            {shapeNode}
            {canEdit && ends.map(([which, hx, hy]) => (
              <KCircle key={which} x={hx} y={hy} radius={hr} fill="#ea580c" stroke="#ffffff" strokeWidth={1.5 / viewScale}
                hitStrokeWidth={20 / viewScale} draggable
                onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}
                onDragStart={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; }}
                onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; onEndpointDrag!(o.id, which, { x: manimX(e.target.x()), y: manimY(e.target.y()) }); }}
                onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => { e.cancelBubble = true; onEndpointCommit!(o.id, which, { x: manimX(e.target.x()), y: manimY(e.target.y()) }); }}
                onMouseEnter={(e: Konva.KonvaEventObject<MouseEvent>) => { const s = e.target.getStage(); if (s) s.container().style.cursor = 'grab'; }}
                onMouseLeave={(e: Konva.KonvaEventObject<MouseEvent>) => { const s = e.target.getStage(); if (s) s.container().style.cursor = 'default'; }} />
            ))}
          </Group>
        );
      }
      // rectangle (default)
      const w = Number(p.width ?? 2) * PXU, h = Number(p.height ?? 1.2) * PXU;
      // Optional rounded corners (`corner_radius`, Manim units, 0 = square).
      // Clamped to half the shorter side exactly as the codegen does, so the
      // preview matches Manim's RoundedRectangle.
      const cr = Math.max(0, Number(p.corner_radius ?? 0)) * PXU;
      return (
        <Rotatable key={o.id} show={canRotate} viewScale={viewScale} onEnd={rotEnd}>
          {ref => <Rect ref={ref as React.Ref<Konva.Rect>} {...common} rotation={rot} width={w} height={h} offsetX={w / 2} offsetY={h / 2}
            cornerRadius={cr > 0 ? Math.min(cr, Math.min(Math.abs(w), Math.abs(h)) / 2) : 0}
            fill={fill} stroke={stroke} strokeWidth={strokeWidth} dash={traceDash(2 * (Math.abs(w) + Math.abs(h)), draw)} />}
        </Rotatable>
      );
    }

    if (o.type === 'coordinate_system') {
      return (
        <Rotatable key={o.id} show={canRotate} viewScale={viewScale} onEnd={rotEnd}>
          {ref => <Group ref={ref as React.Ref<Konva.Group>} {...common} rotation={-(Number(p.rotation) || 0)}>{coordChildren(o, stroke, strokeWidth)}</Group>}
        </Rotatable>
      );
    }

    if (o.type === 'graph') {
      const st = p.subtype ?? 'function_plot';
      const pick = isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey, { x: e.evt.clientX, y: e.evt.clientY }); };

      if (st === 'vector_field') {
        const arrows = sampleVectorField(o);
        if (!arrows.length) return null;
        return (
          <Group key={o.id} listening={!isFrozen} onClick={pick} onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}>
            {arrows.map((a, i) => {
              const c = vectorFieldColor(a.mag); // matches Manim's [0,2] gradient
              return (
                <Arrow key={i} points={[worldX(a.x), worldY(a.y), worldX(a.x + a.dx), worldY(a.y + a.dy)]}
                  stroke={c} fill={c} strokeWidth={2} pointerLength={6} pointerWidth={5} listening={false} />
              );
            })}
          </Group>
        );
      }

      if (st === 'implicit') return null; // render-only (no canvas preview)

      const axes = objects.find(a => a.id === p.axes_ref && a.type === 'coordinate_system');
      if (!axes) return null;
      const allPts = st === 'parametric'
        ? sampleParametric(axes, String(p.x_expression ?? 'cos(t)'), String(p.y_expression ?? 'sin(t)'), p.t_range)
        : samplePlot(axes, String(p.expression ?? ''), p.x_range);
      // Playback preview: Create traces the curve from its first sample.
      const pts = draw == null ? allPts : allPts.slice(0, Math.max(4, Math.floor((allPts.length / 2) * draw) * 2));
      if (pts.length < 4) return null;
      return (
        <Line key={o.id} points={pts} stroke={stroke} strokeWidth={strokeWidth} lineJoin="round" lineCap="round"
          listening={!isFrozen} hitStrokeWidth={HIT}
          {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }}
          onClick={pick} />
      );
    }

    if (o.type === 'geometry') {
      const pick = isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; onSelect(o.id, e.evt.shiftKey, { x: e.evt.clientX, y: e.evt.clientY }); };

      if (p.subtype === 'vector') {
        const full = (p.direction as { x: number; y: number }) ?? { x: 1, y: 0 };
        const dir = draw == null ? full : { x: full.x * draw, y: full.y * draw };
        const tip = 0.25 * PXU;
        return (
          <Rotatable key={o.id} show={canRotate} viewScale={viewScale} onEnd={rotEnd}>
            {ref => <Arrow ref={ref as React.Ref<Konva.Arrow>} {...common} points={[0, 0, worldX(dir.x), worldY(dir.y)]} stroke={stroke} fill={stroke}
              strokeWidth={strokeWidth} hitStrokeWidth={HIT} pointerLength={tip} pointerWidth={tip * 0.9} />}
          </Rotatable>
        );
      }

      if (p.subtype === 'angle') {
        const s1 = lineSegment(objects.find(a => a.id === p.line1_id));
        const s2 = lineSegment(objects.find(a => a.id === p.line2_id));
        if (!s1 || !s2) return null;
        const v = intersect(s1, s2);
        if (!v) return null;
        // direction along each line toward the endpoint farther from the vertex
        const far = (seg: [[number, number], [number, number]]) => {
          const d0 = Math.hypot(seg[0][0] - v[0], seg[0][1] - v[1]);
          const d1 = Math.hypot(seg[1][0] - v[0], seg[1][1] - v[1]);
          const pt = d1 >= d0 ? seg[1] : seg[0];
          return Math.atan2(pt[1] - v[1], pt[0] - v[0]);
        };
        let a1 = far(s1), a2 = far(s2);
        let delta = a2 - a1;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const R = Number(p.radius ?? 0.6);
        const pts: number[] = [];
        const N = 28;
        for (let i = 0; i <= N; i++) {
          const ang = a1 + (delta * i) / N;
          pts.push(worldX(v[0] + R * Math.cos(ang)), worldY(v[1] + R * Math.sin(ang)));
        }
        return <Line key={o.id} points={pts} stroke={stroke} strokeWidth={strokeWidth} listening={!isFrozen} hitStrokeWidth={HIT} {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
      }

      if (p.subtype === 'brace') {
        const target = objects.find(a => a.id === p.target_id);
        if (!target) return null;
        const b = objectBounds(target);
        const buff = BRACE_BUFF, depth = BRACE_DEPTH * PXU;
        const dir = String(p.direction_str ?? 'DOWN').toUpperCase();
        let d: string;
        if (dir === 'DOWN') d = bracePath(worldX(b.cx - b.hw), worldX(b.cx + b.hw), worldY(b.cy - b.hh - buff), depth, 'h', +1);
        else if (dir === 'UP') d = bracePath(worldX(b.cx - b.hw), worldX(b.cx + b.hw), worldY(b.cy + b.hh + buff), depth, 'h', -1);
        else if (dir === 'LEFT') d = bracePath(worldY(b.cy - b.hh), worldY(b.cy + b.hh), worldX(b.cx - b.hw - buff), depth, 'v', -1);
        else d = bracePath(worldY(b.cy - b.hh), worldY(b.cy + b.hh), worldX(b.cx + b.hw + buff), depth, 'v', +1);
        return <Path key={o.id} data={d} stroke={stroke} strokeWidth={2} listening={!isFrozen} hitStrokeWidth={HIT} {...hover} {...sel}
          onMouseDown={isFrozen ? undefined : (e: Konva.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; }} onClick={pick} />;
      }

      return null;
    }
    return null;
  };

  // Render in z-order so higher z draws on top.
  const ordered = [...objects].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  if (!opacities) return <>{ordered.map(renderNode)}</>;
  return <>{ordered.map(o => {
    const op = opacities[o.id] ?? 1;
    if (op <= 0.001) return null;
    const node = renderNode(o);
    // No `listening` override: read-only callers freeze the nodes themselves, and
    // Record mode needs them draggable through the wrapper.
    return node && <Group key={o.id} opacity={op}>{node}</Group>;
  })}</>;
}
