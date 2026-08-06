import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import katex from 'katex';
import type { View } from './coords';
import {
  PX_PER_UNIT, MANIM_EM_UNITS_PER_PT, MANIM_TEXT_EM_UNITS_PER_PT, SNAP_PX,
  MATRIX_H_PITCH, MATRIX_V_PITCH, MATRIX_BRACKET_BUFF,
  worldX, worldY,
} from './coords';
import { useProjectStore } from '../store/projectStore';
import { useCanvasStore } from '../store/canvasStore';
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
  // Draggable rotation-pivot (⊕) handle for a selected rotate keyframe. Lives
  // here (HTML, above the Konva stage) for every object type, so it stays
  // grabbable even when the pivot sits on top of an equation.
  anchorHandle?: MoveHandle | null;
  // Live multi-select drag shared with the Konva layer: while `anchorId` is being
  // dragged, other selected equations follow by (dx, dy). `onGroupDrag` is the
  // shared state setter (stable) so a dragged equation publishes/clears the delta
  // and the Konva shapes follow it too.
  groupDrag?: { anchorId: string; dx: number; dy: number } | null;
  onGroupDrag?: (v: { anchorId: string; dx: number; dy: number } | null) => void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
// Normalize degrees into (-180, 180].
const normDeg = (d: number) => { const m = ((d % 360) + 360) % 360; return m > 180 ? m - 360 : m; };

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

// Manim's MathTex defaults to the align* environment, which right-aligns lines
// that lack an '&'. Mirror the codegen (objects.py): wrap a *multi-line* equation
// in a LaTeX `array` of the chosen column type (l/c/r) so lines are left/center/
// right justified exactly like the render — or `aligned` when it uses '&' for
// explicit column alignment. Single-line equations are left untouched.
function equationTex(o: SceneObject): string {
  const tex = texFor(o);
  if (!tex.includes('\\\\')) return tex; // no LaTeX line break -> single line
  if (tex.includes('&')) return `\\begin{aligned}${tex}\\end{aligned}`;
  const align = String((o.props as any).align ?? 'center');
  const col = align === 'left' ? 'l' : align === 'right' ? 'r' : 'c';
  return `\\begin{array}{${col}}${tex}\\end{array}`;
}

// LaTeX-escape a plain string so a `text` object renders literally (single pass,
// so a replacement's own braces aren't re-escaped). Mirrors `_tex_escape` /
// `_TEX_ESCAPE_MAP` in backend/app/codegen/objects.py.
const TEX_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};
function texEscape(s: string): string {
  let out = '';
  for (const ch of s) out += TEX_ESCAPE_MAP[ch] ?? ch;
  return out;
}

// KaTeX source for a `text` object: escaped prose in \text{}, wrapped in
// \textbf/\textit to match the codegen (Tex(...) with the same wrappers).
function textKatex(o: SceneObject): string {
  const p = o.props as any;
  const cell = (s: string) => {
    let body = texEscape(s);
    if (p.italic) body = `\\textit{${body}}`;
    if (p.bold) body = `\\textbf{${body}}`;
    return `\\text{${body}}`;
  };
  const lines = String(p.text ?? '').split('\n');
  if (lines.length === 1) return cell(lines[0]);
  // Multi-line mirrors the codegen's left-aligned `tabular{l}`; KaTeX has no
  // tabular, so use the math-mode `array` twin. An empty line needs a phantom
  // or KaTeX collapses the row, where LaTeX's row strut keeps it open.
  const rows = lines.map(l => (l === '' ? '\\phantom{X}' : cell(l))).join(' \\\\ ');
  return `\\begin{array}{l}${rows}\\end{array}`;
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

    // Overall scale from the matrix font size. The pitch/bracket constants below
    // are Manim's Matrix defaults at font_size 48 (its default); a Matrix scaled
    // by k grows glyphs + spacing + brackets together, so scale every fixed
    // world-px term by k to mirror the codegen's `.scale(font_size/48)`.
    const k = (Number((o.props as any).font_size ?? 48) || 48) / 48;

    // World-pixel pitch from Manim's fixed grid (independent of glyph width).
    const colPitch = MATRIX_H_PITCH * PX_PER_UNIT * k;
    const rowPitch = MATRIX_V_PITCH * PX_PER_UNIT * k;
    const spanX = (cols - 1) * colPitch;
    const spanY = (rows - 1) * rowPitch;

    // Bracket geometry (world px): span the entries' height + a small buff.
    const bracketH = spanY + 0.62 * fontSize + 2 * MATRIX_BRACKET_BUFF * PX_PER_UNIT * k;
    const bracketW = Math.max(7, bracketH * 0.16);
    const bracketT = Math.max(2, fontSize * 0.06);
    const bracketX = spanX / 2 + (0.18 + MATRIX_BRACKET_BUFF) * PX_PER_UNIT * k;

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

  if (o.type === 'text') {
    const p = o.props as any;
    const font = textFont(o);
    if (font) {
      // Pango path (codegen emits `Text(font=…)`): the browser has the very same
      // system font, so plain styled HTML at the matched em size is a closer
      // preview than KaTeX could ever be. `pre` keeps newlines, and line-height
      // 1.3 mirrors Manim's DEFAULT_LINE_SPACING_SCALE of 0.3.
      return (
        <div style={{
          padding: '4px',
          whiteSpace: 'pre',
          lineHeight: 1.3,
          fontFamily: `"${font.replace(/"/g, '')}", sans-serif`,
          fontWeight: p.bold ? 700 : 400,
          fontStyle: p.italic ? 'italic' : 'normal',
        }}>{String(p.text ?? '')}</div>
      );
    }
    return (
      <div style={{ padding: '4px', whiteSpace: 'nowrap' }}
        dangerouslySetInnerHTML={{ __html: renderTex(textKatex(o)) }} />
    );
  }

  return (
    <div style={{ padding: '4px', whiteSpace: 'nowrap' }}
      dangerouslySetInnerHTML={{ __html: renderTex(equationTex(o)) }} />
  );
}

// The system font a `text` object renders in, or '' when it takes the LaTeX path.
function textFont(o: SceneObject): string {
  return o.type === 'text' ? String((o.props as any).font ?? '').trim() : '';
}

function latexFontPx(o: SceneObject): number {
  // A Pango `Text` and a LaTeX `Tex` pack a different number of scene units per
  // font_size point, so the two paths calibrate against different constants.
  const em = textFont(o) ? MANIM_TEXT_EM_UNITS_PER_PT : MANIM_EM_UNITS_PER_PT;
  return Number((o.props as any).font_size ?? 48) * em * PX_PER_UNIT;
}

export function LatexOverlay({ objects, view, ghosts = [], nonInteractiveIds = [], moveHandle = null, anchorHandle = null, groupDrag = null, onGroupDrag }: Props) {
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const toggleSelect = useProjectStore(s => s.toggleSelect);
  const moveObject = useProjectStore(s => s.moveObject);
  const frozen = new Set(nonInteractiveIds);

  // Local drag state so we commit a single history entry on pointer-up.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startSX: number; startSY: number; startX: number; startY: number } | null>(null);
  const moveHandleRef = useRef<{ startSX: number; startSY: number; startX: number; startY: number } | null>(null);
  const anchorHandleRef = useRef<{ startSX: number; startSY: number; startX: number; startY: number } | null>(null);
  // Live rotation (Manim CCW degrees) while the rotate handle of a lone-selected
  // equation/text/matrix is dragged; committed to the `rotation` prop on release.
  const [rotDrag, setRotDrag] = useState<{ id: string; deg: number } | null>(null);
  const rotHandleRef = useRef<{ id: string; cx: number; cy: number } | null>(null);

  useEffect(() => {
    // Cursor position (scene units, y flipped) relative to a drag's start.
    const handlePos = (mh: { startSX: number; startSY: number; startX: number; startY: number }, e: PointerEvent): Point2D => ({
      x: mh.startX + (e.clientX - mh.startSX) / (view.scale * PX_PER_UNIT),
      y: mh.startY - (e.clientY - mh.startSY) / (view.scale * PX_PER_UNIT),
    });

    // Rotation from the pointer's angle about the element center: the handle
    // points "up" from the center, screen angles are CW (y-down) while the
    // `rotation` prop is Manim CCW degrees → negate. Snaps to the quarter turns
    // within 4°, mirroring the Konva Transformer's rotationSnaps.
    const rotFromPointer = (r: { cx: number; cy: number }, e: PointerEvent): number => {
      const screenDeg = (Math.atan2(e.clientY - r.cy, e.clientX - r.cx) * 180) / Math.PI + 90;
      const deg = normDeg(-screenDeg);
      const snap = Math.round(deg / 90) * 90;
      return Math.abs(deg - snap) <= 4 ? normDeg(snap) : deg;
    };

    function onMove(e: PointerEvent) {
      const rh = rotHandleRef.current;
      if (rh) {
        setRotDrag({ id: rh.id, deg: rotFromPointer(rh, e) });
        return;
      }
      const ah = anchorHandleRef.current;
      if (ah && anchorHandle) {
        anchorHandle.onDragMove(handlePos(ah, e));
        return;
      }
      const mh = moveHandleRef.current;
      if (mh && moveHandle) {
        moveHandle.onDragMove(handlePos(mh, e));
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dxUnits = (e.clientX - d.startSX) / (view.scale * PX_PER_UNIT);
      const dyUnits = -(e.clientY - d.startSY) / (view.scale * PX_PER_UNIT);
      const sel = useProjectStore.getState().selectedObjectIds;
      const isMulti = sel.length > 1 && sel.includes(d.id);
      let nx = d.startX + dxUnits, ny = d.startY + dyUnits;
      // Snap onto the center lines (x=0 / y=0) within SNAP_PX (screen px) — but not
      // during a multi-select drag (snapping one member would shift the whole set).
      if (!isMulti && useCanvasStore.getState().snapToCenter) {
        const t = SNAP_PX / (view.scale * PX_PER_UNIT);
        if (Math.abs(nx) <= t) nx = 0;
        if (Math.abs(ny) <= t) ny = 0;
      }
      setDrag({ id: d.id, x: nx, y: ny });
      // Drag the rest of the selection along live.
      if (isMulti) onGroupDrag?.({ anchorId: d.id, dx: nx - d.startX, dy: ny - d.startY });
    }
    function onUp(e: PointerEvent) {
      const rh = rotHandleRef.current;
      if (rh) {
        // Commit straight from the pointer-up event (matches onMove) as one
        // history entry, then clear the live override.
        const st = useProjectStore.getState();
        const sc = st.project?.scenes.find(s => s.id === st.selectedSceneId);
        const o = sc?.objects.find(x => x.id === rh.id);
        if (o) st.updateObject(o.id, { props: { ...o.props, rotation: round2(rotFromPointer(rh, e)) } });
        rotHandleRef.current = null;
        setRotDrag(null);
        return;
      }
      const ah = anchorHandleRef.current;
      if (ah && anchorHandle) {
        anchorHandle.onCommit(handlePos(ah, e));
        anchorHandleRef.current = null;
        return;
      }
      const mh = moveHandleRef.current;
      if (mh && moveHandle) {
        // Commit the final cursor position straight from the pointer-up event so
        // the keyframe (and the inspector) always reflect where the handle landed.
        moveHandle.onCommit(handlePos(mh, e));
        moveHandleRef.current = null;
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      // Final position straight from the pointer-up event (matches onMove; avoids
      // depending on the `drag` state, which isn't in this effect's deps).
      const st = useProjectStore.getState();
      const sel = st.selectedObjectIds;
      const isMulti = sel.length > 1 && sel.includes(d.id);
      let nx = d.startX + (e.clientX - d.startSX) / (view.scale * PX_PER_UNIT);
      let ny = d.startY - (e.clientY - d.startSY) / (view.scale * PX_PER_UNIT);
      if (!isMulti && useCanvasStore.getState().snapToCenter) {
        const t = SNAP_PX / (view.scale * PX_PER_UNIT);
        if (Math.abs(nx) <= t) nx = 0;
        if (Math.abs(ny) <= t) ny = 0;
      }
      if (isMulti) {
        // Commit the move and clear both live offsets together, so followers never
        // render at (already-moved position) + (stale drag delta) — a teleport in
        // the drag direction (see CanvasStage.commitDrag).
        flushSync(() => {
          st.moveObjectsBy(sel, nx - d.startX, ny - d.startY);
          setDrag(null);
          onGroupDrag?.(null);
        });
      } else {
        st.moveObject(d.id, nx, ny);
        setDrag(null);
        onGroupDrag?.(null);
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [view.scale, moveObject, moveHandle, anchorHandle, onGroupDrag]);

  const latexObjects = objects.filter(o => (o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix') && o.visible);

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
          // This equation is the drag anchor → use its live pos; otherwise if it's a
          // non-anchor member of a live multi-drag, follow by the group delta.
          const gd = groupDrag && groupDrag.anchorId !== o.id && isSel ? groupDrag : null;
          const px = drag && drag.id === o.id ? drag.x : o.position.x + (gd ? gd.dx : 0);
          const py = drag && drag.id === o.id ? drag.y : o.position.y + (gd ? gd.dy : 0);

          // Baked rotation (Manim CCW degrees); CSS rotate is CW on screen, negate.
          // While the rotate handle is dragged, the live angle overrides the prop.
          const rot = rotDrag?.id === o.id ? rotDrag.deg : (Number((o.props as any).rotation) || 0);
          const wrapperBase: React.CSSProperties = {
            position: 'absolute',
            left: worldX(px),
            top: worldY(py),
            transform: `translate(-50%, -50%)${rot ? ` rotate(${-rot}deg)` : ''}`,
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

          // Rotate handle only for a lone selection (same rule as the Konva rotate
          // gizmo). It's a child of the rotating wrapper, so it orbits with the
          // element — like Konva's rotate anchor. Rotation pivots on the element
          // center (translate(-50%,-50%) puts it at the CSS transform-origin),
          // which is also where Manim's .rotate() pivots.
          const showRotate = isSel && selectedIds.length === 1 && !isFrozen;

          return (
            <div key={o.id} onPointerDown={onDown} style={wrapperBase}>
              {latexInner(o, fontSize, color)}
              {showRotate && (
                <div
                  title="Rotate"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: -26,
                    transform: 'translate(-50%, -50%)',
                    width: 13,
                    height: 13,
                    borderRadius: '50%',
                    background: '#ea580c',
                    border: '1.5px solid #ffffff',
                    boxSizing: 'border-box',
                    cursor: 'grab',
                    pointerEvents: 'auto',
                    touchAction: 'none',
                    zIndex: 20,
                  }}
                  onPointerDown={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    // The wrapper rotates about its center, so its bounding-box
                    // center is rotation-invariant — a stable pivot for the drag.
                    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                    rotHandleRef.current = { id: o.id, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                  }}
                />
              )}
            </div>
          );
        })}

        {/* Faded preview of a selected move/scale/rotate animation's result. */}
        {ghosts.filter(g => g.obj.type === 'latex_text' || g.obj.type === 'text' || g.obj.type === 'matrix').map(g => {
          const o = g.obj;
          const fontSize = latexFontPx(o);
          const color = (o.style.fill_color as string) || '#ffffff';
          // CSS rotate is clockwise on screen; Manim degrees are CCW in math
          // space (y-up), which reads as clockwise once y is flipped → negate.
          return (
            <div
              key={`ghost-${g.key}`}
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

        {/* Rotation-pivot handle: a ⊕ crosshair the user drags to re-anchor a
            rotate keyframe. Same drag mechanics as the move handle above. */}
        {anchorHandle && (
          <div
            style={{
              position: 'absolute',
              left: worldX(anchorHandle.pos.x),
              top: worldY(anchorHandle.pos.y),
              transform: 'translate(-50%, -50%)',
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: '2px solid #a855f7',
              background: 'rgba(168,85,247,0.25)',
              boxSizing: 'border-box',
              cursor: 'grab',
              pointerEvents: 'auto',
              touchAction: 'none',
              zIndex: 21,
            }}
            onPointerDown={e => {
              e.stopPropagation();
              e.preventDefault();
              anchorHandleRef.current = {
                startSX: e.clientX,
                startSY: e.clientY,
                startX: anchorHandle.pos.x,
                startY: anchorHandle.pos.y,
              };
            }}
          >
            <div style={{ position: 'absolute', left: '50%', top: -6, width: 2, height: 28, marginLeft: -1, background: '#a855f7', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: '50%', left: -6, height: 2, width: 28, marginTop: -1, background: '#a855f7', pointerEvents: 'none' }} />
          </div>
        )}
      </div>
    </div>
  );
}
