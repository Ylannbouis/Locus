import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import type { View } from './coords';
import {
  PX_PER_UNIT, MANIM_EM_UNITS_PER_PT,
  MATRIX_H_PITCH, MATRIX_V_PITCH, MATRIX_BRACKET_BUFF,
  worldX, worldY,
} from './coords';
import { useProjectStore } from '../store/projectStore';
import { objectBounds, braceLabelPoint, vectorLabelPoint } from './geometry';
import type { Ghost } from './motion';
import type { Point2D, SceneObject } from '../types/ir';

interface MoveHandle {
  pos: Point2D;
  onDragMove: (pos: Point2D) => void;
  onCommit: (pos: Point2D) => void;
}

interface Props {
  objects: SceneObject[];
  view: View;
  // Faded, non-interactive transform previews (move/scale/rotate destinations).
  ghosts?: Ghost[];
  // Objects being edited via a move/scale/rotate keyframe preview.
  nonInteractiveIds?: string[];
  // Draggable destination handle for move keyframes on LaTeX/matrix objects.
  moveHandle?: MoveHandle | null;
}

function renderTex(tex: string, displayMode = true): string {
  try {
    return katex.renderToString(tex || '\\;', { throwOnError: false, displayMode });
  } catch {
    return '<span style="color:#dc2626">LaTeX error</span>';
  }
}

// Draw a matrix bracket as SVG so its height and vertical centering are exact
// (KaTeX \left..\right delimiters center on the math axis and round up in size,
// which makes them too tall and visually offset). `h`/`w` are world px.
function bracketSvg(ch: string, h: number, w: number, t: number, color: string): string {
  const p = t;                       // keep the stroke inside the viewBox
  const x0 = p, x1 = w - p, y0 = p, y1 = h - p, mid = w / 2;
  let d: string;
  if (ch === '|') {
    d = `M ${mid} ${y0} L ${mid} ${y1}`;
  } else if (ch === '(' || ch === '{') {
    d = `M ${x1} ${y0} Q ${x0} ${h / 2} ${x1} ${y1}`;
  } else if (ch === ')' || ch === '}') {
    d = `M ${x0} ${y0} Q ${x1} ${h / 2} ${x0} ${y1}`;
  } else if (ch === ']') {
    d = `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1}`;
  } else { // '[' and default
    d = `M ${x1} ${y0} L ${x0} ${y0} L ${x0} ${y1} L ${x1} ${y1}`;
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible">`
    + `<path d="${d}" fill="none" stroke="${color}" stroke-width="${t}" stroke-linecap="square" stroke-linejoin="miter"/></svg>`;
}

function texFor(o: SceneObject): string {
  return String((o.props as any).tex_string ?? '');
}

// The inner KaTeX/matrix content for a latex_text or matrix object (without the
// positioning/interaction wrapper). Shared by the live objects and the faded
// move-preview "ghosts".
function latexInner(o: SceneObject, fontSize: number, color: string): React.ReactNode {
  if (o.type === 'matrix') {
    const p = o.props as any;
    const entries: string[][] = Array.isArray(p.entries) && p.entries.length
      ? p.entries
      : [['1', '0'], ['0', '1']];
    const rows = entries.length;
    const cols = entries.reduce((m, r) => Math.max(m, r.length), 1);

    // World-pixel pitch from Manim's fixed grid (independent of glyph width).
    const colPitch = MATRIX_H_PITCH * PX_PER_UNIT;
    const rowPitch = MATRIX_V_PITCH * PX_PER_UNIT;
    const spanX = (cols - 1) * colPitch;
    const spanY = (rows - 1) * rowPitch;

    // Bracket geometry (world px): span the entries' height + a small buff.
    const bracketH = spanY + 0.62 * fontSize + 2 * MATRIX_BRACKET_BUFF * PX_PER_UNIT;
    const bracketW = Math.max(7, bracketH * 0.16);
    const bracketT = Math.max(2, fontSize * 0.06);
    const bracketX = spanX / 2 + 0.18 * PX_PER_UNIT + MATRIX_BRACKET_BUFF * PX_PER_UNIT;

    const containerW = (bracketX + bracketW) * 2;
    const containerH = bracketH;

    return (
      <div style={{ position: 'relative', width: containerW, height: containerH }}>
        {entries.flatMap((row, i) =>
          row.map((cell, j) => {
            const cx = (j - (cols - 1) / 2) * colPitch;
            const cy = (i - (rows - 1) / 2) * rowPitch;
            return (
              <div
                key={`${i}-${j}`}
                style={{
                  position: 'absolute', left: '50%', top: '50%',
                  transform: `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`,
                  whiteSpace: 'nowrap',
                }}
                dangerouslySetInnerHTML={{ __html: renderTex(cell, false) }}
              />
            );
          }),
        )}
        <div
          style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(calc(-100% + ${-bracketX}px), -50%)` }}
          dangerouslySetInnerHTML={{ __html: bracketSvg(p.left_bracket ?? '[', bracketH, bracketW, bracketT, color) }}
        />
        <div
          style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(${bracketX}px, -50%)` }}
          dangerouslySetInnerHTML={{ __html: bracketSvg(p.right_bracket ?? ']', bracketH, bracketW, bracketT, color) }}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '4px', whiteSpace: 'nowrap' }}
      dangerouslySetInnerHTML={{ __html: renderTex(texFor(o)) }} />
  );
}

function latexFontPx(o: SceneObject): number {
  return Number((o.props as any).font_size ?? 48) * MANIM_EM_UNITS_PER_PT * PX_PER_UNIT;
}

export function LatexOverlay({ objects, view, ghosts = [], nonInteractiveIds = [], moveHandle = null }: Props) {
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const toggleSelect = useProjectStore(s => s.toggleSelect);
  const moveObject = useProjectStore(s => s.moveObject);
  const frozen = new Set(nonInteractiveIds);

  // Local drag state so we commit a single history entry on pointer-up.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startSX: number; startSY: number; startX: number; startY: number } | null>(null);
  const moveHandleRef = useRef<{ startSX: number; startSY: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    // Cursor position (scene units, y flipped) relative to a drag's start.
    const handlePos = (mh: { startSX: number; startSY: number; startX: number; startY: number }, e: PointerEvent): Point2D => ({
      x: mh.startX + (e.clientX - mh.startSX) / (view.scale * PX_PER_UNIT),
      y: mh.startY - (e.clientY - mh.startSY) / (view.scale * PX_PER_UNIT),
    });

    function onMove(e: PointerEvent) {
      const mh = moveHandleRef.current;
      if (mh && moveHandle) {
        moveHandle.onDragMove(handlePos(mh, e));
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dxUnits = (e.clientX - d.startSX) / (view.scale * PX_PER_UNIT);
      const dyUnits = -(e.clientY - d.startSY) / (view.scale * PX_PER_UNIT);
      setDrag({ id: d.id, x: d.startX + dxUnits, y: d.startY + dyUnits });
    }
    function onUp(e: PointerEvent) {
      const mh = moveHandleRef.current;
      if (mh && moveHandle) {
        // Commit the final cursor position straight from the pointer-up event so
        // the keyframe (and the inspector) always reflect where the handle landed.
        moveHandle.onCommit(handlePos(mh, e));
        moveHandleRef.current = null;
        return;
      }
      const d = dragRef.current;
      if (d) {
        setDrag(cur => {
          if (cur && cur.id === d.id) {
            const st = useProjectStore.getState();
            const sel = st.selectedObjectIds;
            if (sel.length > 1 && sel.includes(d.id)) {
              st.moveObjectsBy(sel, cur.x - d.startX, cur.y - d.startY);
            } else {
              st.moveObject(d.id, cur.x, cur.y);
            }
          }
          return null;
        });
        dragRef.current = null;
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [view.scale, moveObject, moveHandle]);

  const latexObjects = objects.filter(o => (o.type === 'latex_text' || o.type === 'matrix') && o.visible);

  // Geometry labels (vector / brace) are LaTeX, so they're rendered here by
  // KaTeX rather than in Konva. Position matches the codegen anchor points.
  const labelFontPx = 40 * MANIM_EM_UNITS_PER_PT * PX_PER_UNIT;
  const geometryLabels = objects.flatMap(o => {
    if (o.type !== 'geometry' || !o.visible) return [];
    const p = o.props as any;
    const text = String(p.label ?? '').trim();
    if (!text) return [];
    let pt: { x: number; y: number } | null = null;
    // Vector labels are MathTex (italic); brace labels are Tex/text (upright).
    let math = true;
    if (p.subtype === 'vector') pt = vectorLabelPoint(o);
    else if (p.subtype === 'brace') {
      math = false;
      const target = objects.find(t => t.id === p.target_id);
      if (target) pt = braceLabelPoint(objectBounds(target), String(p.direction_str ?? 'DOWN'));
    }
    if (!pt) return [];
    return [{ id: o.id, text, pt, math, color: (o.style.stroke_color as string) || '#ffffff' }];
  });

  return (
    <div
      className="latex-overlay"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
        }}
      >
        {latexObjects.map(o => {
          // KaTeX font-size (world px) calibrated so 1em matches Manim's em.
          const fontSize = latexFontPx(o);
          const color = (o.style.fill_color as string) || '#ffffff';
          const isSel = selectedIds.includes(o.id);
          const isFrozen = frozen.has(o.id);
          const px = drag && drag.id === o.id ? drag.x : o.position.x;
          const py = drag && drag.id === o.id ? drag.y : o.position.y;

          const wrapperBase: React.CSSProperties = {
            position: 'absolute',
            left: worldX(px),
            top: worldY(py),
            transform: 'translate(-50%, -50%)',
            fontSize: `${fontSize}px`,
            color,
            cursor: isFrozen ? 'default' : 'move',
            pointerEvents: isFrozen ? 'none' : 'auto',
            userSelect: 'none',
            outline: isSel ? '2px solid #2563eb' : 'none',
            outlineOffset: '2px',
            borderRadius: '4px',
          };

          const onDown = isFrozen ? undefined : (e: React.PointerEvent) => {
            e.stopPropagation();
            if (e.shiftKey) toggleSelect(o.id);
            else if (!selectedIds.includes(o.id)) selectObject(o.id);
            dragRef.current = { id: o.id, startSX: e.clientX, startSY: e.clientY, startX: o.position.x, startY: o.position.y };
          };

          return (
            <div key={o.id} onPointerDown={onDown} style={wrapperBase}>
              {latexInner(o, fontSize, color)}
            </div>
          );
        })}

        {/* Faded preview of a selected move/scale/rotate animation's result. */}
        {ghosts.filter(g => g.obj.type === 'latex_text' || g.obj.type === 'matrix').map(g => {
          const o = g.obj;
          const fontSize = latexFontPx(o);
          const color = (o.style.fill_color as string) || '#ffffff';
          // CSS rotate is clockwise on screen; Manim degrees are CCW in math
          // space (y-up), which reads as clockwise once y is flipped → negate.
          return (
            <div
              key={`ghost-${o.id}`}
              style={{
                position: 'absolute',
                left: worldX(o.position.x),
                top: worldY(o.position.y),
                transform: `translate(-50%, -50%) rotate(${-g.rotationDeg}deg) scale(${g.scale})`,
                fontSize: `${fontSize}px`,
                color,
                opacity: 0.4,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {latexInner(o, fontSize, color)}
            </div>
          );
        })}

        {geometryLabels.map(l => (
          <div
            key={`lbl-${l.id}`}
            style={{
              position: 'absolute',
              left: worldX(l.pt.x),
              top: worldY(l.pt.y),
              transform: 'translate(-50%, -50%)',
              fontSize: `${labelFontPx}px`,
              color: l.color,
              pointerEvents: 'none',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
            dangerouslySetInnerHTML={{ __html: renderTex(l.math ? l.text : `\\text{${l.text}}`, false) }}
          />
        ))}

        {moveHandle && (
          <div
            style={{
              position: 'absolute',
              left: worldX(moveHandle.pos.x),
              top: worldY(moveHandle.pos.y),
              transform: 'translate(-50%, -50%)',
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#ea580c',
              border: '2px solid #ffffff',
              boxSizing: 'border-box',
              cursor: 'grab',
              pointerEvents: 'auto',
              touchAction: 'none',
              zIndex: 20,
            }}
            onPointerDown={e => {
              e.stopPropagation();
              e.preventDefault();
              moveHandleRef.current = {
                startSX: e.clientX,
                startSY: e.clientY,
                startX: moveHandle.pos.x,
                startY: moveHandle.pos.y,
              };
            }}
          />
        )}
      </div>
    </div>
  );
}
