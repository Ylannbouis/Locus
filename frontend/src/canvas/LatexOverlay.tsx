import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import type { View } from './coords';
import { PX_PER_UNIT, worldX, worldY } from './coords';
import { useProjectStore } from '../store/projectStore';
import type { SceneObject } from '../types/ir';

interface Props {
  objects: SceneObject[];
  view: View;
}

function renderTex(tex: string): string {
  try {
    return katex.renderToString(tex || '\\;', { throwOnError: false, displayMode: true });
  } catch {
    return '<span style="color:#dc2626">LaTeX error</span>';
  }
}

// Build a KaTeX matrix string from a matrix object's entries + brackets.
function matrixTex(o: SceneObject): string {
  const p = o.props as any;
  const entries: string[][] = Array.isArray(p.entries) ? p.entries : [['1', '0'], ['0', '1']];
  const env = p.left_bracket === '(' ? 'pmatrix' : 'bmatrix';
  const body = entries.map(row => row.map(c => String(c)).join(' & ')).join(' \\\\ ');
  return `\\begin{${env}} ${body} \\end{${env}}`;
}

function texFor(o: SceneObject): string {
  if (o.type === 'matrix') return matrixTex(o);
  return String((o.props as any).tex_string ?? '');
}

export function LatexOverlay({ objects, view }: Props) {
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const moveObject = useProjectStore(s => s.moveObject);

  // Local drag state so we commit a single history entry on pointer-up.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startSX: number; startSY: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dxUnits = (e.clientX - d.startSX) / (view.scale * PX_PER_UNIT);
      const dyUnits = -(e.clientY - d.startSY) / (view.scale * PX_PER_UNIT);
      setDrag({ id: d.id, x: d.startX + dxUnits, y: d.startY + dyUnits });
    }
    function onUp() {
      const d = dragRef.current;
      if (d) {
        setDrag(cur => {
          if (cur && cur.id === d.id) moveObject(d.id, cur.x, cur.y);
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
  }, [view.scale, moveObject]);

  const latexObjects = objects.filter(o => (o.type === 'latex_text' || o.type === 'matrix') && o.visible);

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
          const tex = texFor(o);
          const fontSize = Number((o.props as any).font_size ?? 48) * 0.55;
          const color = (o.style.fill_color as string) || '#ffffff';
          const isSel = selectedIds.includes(o.id);
          const px = drag && drag.id === o.id ? drag.x : o.position.x;
          const py = drag && drag.id === o.id ? drag.y : o.position.y;
          return (
            <div
              key={o.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                selectObject(o.id);
                dragRef.current = { id: o.id, startSX: e.clientX, startSY: e.clientY, startX: o.position.x, startY: o.position.y };
              }}
              style={{
                position: 'absolute',
                left: worldX(px),
                top: worldY(py),
                transform: 'translate(-50%, -50%)',
                fontSize: `${fontSize}px`,
                color,
                cursor: 'move',
                pointerEvents: 'auto',
                userSelect: 'none',
                padding: '4px',
                outline: isSel ? '2px solid #2563eb' : 'none',
                outlineOffset: '2px',
                borderRadius: '4px',
                whiteSpace: 'nowrap',
              }}
              dangerouslySetInnerHTML={{ __html: renderTex(tex) }}
            />
          );
        })}
      </div>
    </div>
  );
}
