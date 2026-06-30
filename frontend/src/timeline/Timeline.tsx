import { Fragment, useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newId } from '../store/objectFactory';
import { useTimelineStore, VERB_META, TIMELINE_VERBS, defaultParams, CAMERA_ID } from './timelineStore';
import type { AnimationVerb, Keyframe, SceneObject } from '../types/ir';

const ROW_H = 30;
const LABEL_W = 150;

function defaultVerb(o: SceneObject): AnimationVerb {
  if (o.type === 'latex_text' || o.type === 'matrix') return 'write';
  return 'create';
}

interface DragState {
  kfId: string;
  mode: 'move' | 'resize';
  startClientX: number;
  origStart: number;
  origDur: number;
  curStart: number;
  curDur: number;
}

export function Timeline() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedObjIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const addKeyframe = useProjectStore(s => s.addKeyframe);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);
  const groupKeyframes = useProjectStore(s => s.groupKeyframes);
  const ungroupKeyframes = useProjectStore(s => s.ungroupKeyframes);

  const { selectedKfIds, pxPerSec, selectKf, clearKf, setPxPerSec } = useTimelineStore();

  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kfId: string } | null>(null);

  // Close the context menu on any click outside it (the menu div stops its own
  // clicks from bubbling, and its buttons close it explicitly).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const keyframes = scene?.timeline.keyframes ?? [];

  const totalDur = Math.max(4, ...keyframes.map(k => k.start_time + k.duration)) + 2;
  const contentW = totalDur * pxPerSec;
  const ticks = Math.ceil(totalDur);

  // ---- drag handling (commit once on pointer-up) -------------------------
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startClientX) / pxPerSec;
    if (drag.mode === 'move') {
      setDrag({ ...drag, curStart: Math.max(0, drag.origStart + dx) });
    } else {
      setDrag({ ...drag, curDur: Math.max(0.1, drag.origDur + dx) });
    }
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.mode === 'move' && drag.curStart !== drag.origStart) {
      updateKeyframe(drag.kfId, { start_time: Math.round(drag.curStart * 100) / 100 });
    } else if (drag.mode === 'resize' && drag.curDur !== drag.origDur) {
      updateKeyframe(drag.kfId, { duration: Math.round(drag.curDur * 100) / 100 });
    }
    setDrag(null);
  };

  const startDrag = (e: React.PointerEvent, kf: Keyframe, mode: 'move' | 'resize') => {
    if (e.button !== 0) return; // only the primary button selects / starts a drag
    e.stopPropagation();
    setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Selection happens here (once). Doing it again in onClick would double-toggle
    // a shift-click and cancel it out.
    selectKf(kf.id, e.shiftKey);
    setDrag({ kfId: kf.id, mode, startClientX: e.clientX, origStart: kf.start_time, origDur: kf.duration, curStart: kf.start_time, curDur: kf.duration });
  };

  const laneTime = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left; // lane-local px (rect already accounts for scroll)
    return Math.max(0, Math.round((x / pxPerSec) * 10) / 10);
  };

  const addKfAt = (obj: SceneObject, e: React.MouseEvent) => {
    const kf: Keyframe = {
      id: newId('kf'), object_id: obj.id, start_time: laneTime(e), verb: defaultVerb(obj),
      duration: 1, easing: 'smooth', group_id: null, params: {},
    };
    addKeyframe(kf);
    selectKf(kf.id);
  };

  const addCameraKfAt = (e: React.MouseEvent) => {
    const kf: Keyframe = {
      id: newId('kf'), object_id: CAMERA_ID, start_time: laneTime(e), verb: 'camera_move',
      duration: 1.5, easing: 'smooth', group_id: null, params: defaultParams('camera_move'),
    };
    addKeyframe(kf);
    selectKf(kf.id);
  };

  const duplicateKf = (kf: Keyframe) => {
    const copy: Keyframe = { ...kf, id: newId('kf'), start_time: kf.start_time + 0.2, group_id: null, params: { ...kf.params } };
    addKeyframe(copy);
    selectKf(copy.id);
  };

  const selectedHaveGroup = keyframes.some(k => selectedKfIds.includes(k.id) && k.group_id);
  const cameraKfs = keyframes.filter(k => k.object_id === CAMERA_ID);

  // One keyframe block, shared by the camera lane and every object lane.
  const renderKfBlock = (kf: Keyframe) => {
    const isDragging = drag?.kfId === kf.id;
    const start = isDragging ? drag!.curStart : kf.start_time;
    const dur = isDragging && drag!.mode === 'resize' ? drag!.curDur : kf.duration;
    const meta = VERB_META[kf.verb];
    const sel = selectedKfIds.includes(kf.id);
    const w = Math.max(18, dur * pxPerSec);
    return (
      <div key={kf.id}
        className={`tl__kf ${sel ? 'tl__kf--sel' : ''} ${kf.group_id ? 'tl__kf--grouped' : ''}`}
        style={{ left: start * pxPerSec, width: w, background: meta.color }}
        title={`${meta.label} @ ${start.toFixed(2)}s · ${dur.toFixed(2)}s${kf.group_id ? ' · parallel' : ''}`}
        onPointerDown={e => startDrag(e, kf, 'move')}
        onClick={e => { e.stopPropagation(); setMenu(null); }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); selectKf(kf.id, false); setMenu({ x: e.clientX, y: e.clientY, kfId: kf.id }); }}>
        {w > 40 && <span className="tl__kf-label">{meta.label}</span>}
        <span className="tl__kf-handle" onPointerDown={e => startDrag(e, kf, 'resize')} />
      </div>
    );
  };

  if (!scene) return <div className="tl"><p className="panel-hint">No scene.</p></div>;

  return (
    <div className="tl" onClick={() => clearKf()}>
      <div className="tl__bar" onClick={e => e.stopPropagation()}>
        <span className="panel-title" style={{ margin: 0 }}>Timeline</span>
        <button className="btn btn--ghost tl__zoom" title="Zoom out" onClick={() => setPxPerSec(pxPerSec / 1.25)}>−</button>
        <button className="btn btn--ghost tl__zoom" title="Zoom in" onClick={() => setPxPerSec(pxPerSec * 1.25)}>+</button>
        <button className="btn" disabled={selectedKfIds.length < 2} onClick={() => groupKeyframes(selectedKfIds)}>Group ∥</button>
        <button className="btn" disabled={!selectedHaveGroup} onClick={() => ungroupKeyframes(selectedKfIds)}>Ungroup</button>
        <span className="tl__hint">double-click a lane to add · drag to move · drag right edge to resize</span>
      </div>

      <div className="tl__scroll">
        <div className="tl__grid" style={{ gridTemplateColumns: `${LABEL_W}px ${contentW}px` }}
          onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div className="tl__corner" style={{ height: 22 }} />
          <div className="tl__ruler" style={{ width: contentW, height: 22 }}>
            {Array.from({ length: ticks + 1 }, (_, i) => (
              <div key={i} className="tl__tick" style={{ left: i * pxPerSec }}>
                <span className="tl__tick-label">{i}s</span>
              </div>
            ))}
          </div>

          {/* Dedicated camera track (pan / zoom / focus keyframes). */}
          <div className="tl__label tl__label--camera" style={{ height: ROW_H, paddingLeft: 8 }}
            title="Camera track — double-click to add a camera move">
            📷 Camera
          </div>
          <div className="tl__lane tl__lane--camera" style={{ height: ROW_H }}
            onDoubleClick={e => { e.stopPropagation(); addCameraKfAt(e); }}>
            {cameraKfs.map(renderKfBlock)}
          </div>

          {objects.map(o => {
            const rowKfs = keyframes.filter(k => k.object_id === o.id);
            return (
              <Fragment key={o.id}>
                <div className={`tl__label ${selectedObjIds.includes(o.id) ? 'tl__label--sel' : ''}`}
                  style={{ height: ROW_H, paddingLeft: o.parent_id ? 22 : 8 }}
                  onClick={e => { e.stopPropagation(); selectObject(o.id); }}>
                  {o.name || o.type}
                </div>
                <div className="tl__lane" style={{ height: ROW_H }}
                  onDoubleClick={e => { e.stopPropagation(); addKfAt(o, e); }}>
                  {rowKfs.map(renderKfBlock)}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      {menu && (() => {
        const kf = keyframes.find(k => k.id === menu.kfId);
        if (!kf) return null;
        return (
          <div className="tl__menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
            {kf.object_id !== CAMERA_ID && (
              <>
                <div className="tl__menu-head">Change verb</div>
                <div className="tl__menu-verbs">
                  {TIMELINE_VERBS.map(v => (
                    <button key={v} className={`tl__menu-verb ${kf.verb === v ? 'is-active' : ''}`}
                      onClick={() => { updateKeyframe(kf.id, { verb: v, params: defaultParams(v) }); setMenu(null); }}>{VERB_META[v].label}</button>
                  ))}
                </div>
                <div className="tl__menu-sep" />
              </>
            )}
            <button className="tl__menu-item" onClick={() => { duplicateKf(kf); setMenu(null); }}>Duplicate</button>
            <button className="tl__menu-item tl__menu-item--danger" onClick={() => { removeKeyframe(kf.id); setMenu(null); }}>Delete</button>
          </div>
        );
      })()}
    </div>
  );
}
