import { Fragment, useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { TransitionType } from '../types/ir';

// Scene-to-scene transitions (animation projects): stored as the earlier scene's
// `transition_out` and applied by the backend stitcher (render/stitch.py).
// '' = unset → follows the Export panel's "crossfade between scenes" checkbox.
const TRANSITIONS: { value: '' | TransitionType; label: string; glyph: string }[] = [
  { value: '', label: 'Default (Export panel setting)', glyph: '·' },
  { value: 'cut', label: 'Cut', glyph: '|' },
  { value: 'crossfade', label: 'Crossfade', glyph: '✕' },
  { value: 'fade_to_black', label: 'Fade through black', glyph: '◐' },
  { value: 'wipe_left', label: 'Wipe left', glyph: '⇠' },
  { value: 'wipe_right', label: 'Wipe right', glyph: '⇢' },
];
const DEFAULT_TR_DURATION = 0.8;

export function ScenePanel() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectScene = useProjectStore(s => s.selectScene);
  const addScene = useProjectStore(s => s.addScene);
  const removeScene = useProjectStore(s => s.removeScene);
  const duplicateScene = useProjectStore(s => s.duplicateScene);
  const duplicateSceneFinal = useProjectStore(s => s.duplicateSceneFinal);
  const renameScene = useProjectStore(s => s.renameScene);
  const moveScene = useProjectStore(s => s.moveScene);
  const reorderScene = useProjectStore(s => s.reorderScene);
  const setSceneAutoAdvance = useProjectStore(s => s.setSceneAutoAdvance);
  const setSceneTransition = useProjectStore(s => s.setSceneTransition);
  // Open transition popover: which scene's outgoing transition, anchored where.
  const [trOpen, setTrOpen] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!trOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTrOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trOpen]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  // Drag-to-reorder: id being dragged, and the gap it would drop into ("before index i").
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (!project) return null;
  const scenes = project.scenes;
  // In a slideshow project a "scene" is a slide — same data, different words.
  const isSlideshow = project.kind === 'slideshow';

  const endDrag = () => { setDragId(null); setDropIndex(null); };
  const onDrop = () => {
    if (dragId && dropIndex !== null) {
      const from = scenes.findIndex(s => s.id === dragId);
      // Dropping after items past the source shifts the target index left by one.
      reorderScene(dragId, from < dropIndex ? dropIndex - 1 : dropIndex);
    }
    endDrag();
  };

  const startRename = (id: string, name: string) => { setEditingId(id); setDraftName(name); };
  const commitRename = () => {
    if (editingId && draftName.trim()) renameScene(editingId, draftName.trim());
    setEditingId(null);
  };

  return (
    <div className="scene-bar">
      <span className="scene-bar__label">{isSlideshow ? 'Slides' : 'Scenes'}</span>
      <div className="scene-bar__tabs" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
        {scenes.map((s, i) => {
          const active = s.id === selectedSceneId;
          const isDragging = s.id === dragId;
          const tr = s.transition_out ?? null;
          const trMeta = TRANSITIONS.find(t => t.value === (tr?.type ?? '')) ?? TRANSITIONS[0];
          return (
            <Fragment key={s.id}>
            <div
              className={`scene-tab ${active ? 'is-active' : ''} ${isDragging ? 'is-dragging' : ''} ${dropIndex === i ? 'drop-before' : ''} ${dropIndex === i + 1 ? 'drop-after' : ''}`}
              draggable={editingId !== s.id}
              onClick={() => selectScene(s.id)}
              title="Drag to reorder · double-click to rename"
              onDragStart={e => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={endDrag}
              onDragOver={e => {
                e.preventDefault();
                if (!dragId) return;
                const r = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientX < r.left + r.width / 2 ? i : i + 1);
              }}
            >
              <span className="scene-tab__num">{i + 1}</span>
              {editingId === s.id ? (
                <input
                  className="scene-tab__rename"
                  autoFocus
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="scene-tab__name" onDoubleClick={e => { e.stopPropagation(); startRename(s.id, s.name); }}>
                  {s.name}
                </span>
              )}
              {isSlideshow && s.auto_advance && !active && (
                <span className="scene-tab__auto" title="Auto-advances to the next slide">⏩</span>
              )}
              {active && (
                <span className="scene-tab__actions" onClick={e => e.stopPropagation()}>
                  {isSlideshow && (
                    <button
                      className={`scene-tab__auto-btn ${s.auto_advance ? 'is-on' : ''}`}
                      title={s.auto_advance
                        ? 'Auto-advance on: the next slide starts without a click'
                        : 'Auto-advance off: hold on the last frame until clicked'}
                      onClick={() => setSceneAutoAdvance(s.id, !s.auto_advance)}
                    >⏩</button>
                  )}
                  <button title="Move left" disabled={i === 0} onClick={() => moveScene(s.id, -1)}>‹</button>
                  <button title="Move right" disabled={i === scenes.length - 1} onClick={() => moveScene(s.id, 1)}>›</button>
                  <button title="Duplicate" onClick={() => duplicateScene(s.id)}>⧉</button>
                  <button title="Duplicate final state (snapshot after all animations, no timeline)" onClick={() => duplicateSceneFinal(s.id)}>⏭</button>
                  <button className="scene-tab__del" title="Delete" disabled={scenes.length <= 1} onClick={() => removeScene(s.id)}>✕</button>
                </span>
              )}
            </div>
            {/* Transition into the next scene — slides are never stitched, so
                slideshow projects have none. */}
            {!isSlideshow && i < scenes.length - 1 && (
              <button
                className={`scene-tr ${tr ? 'is-set' : ''}`}
                title={`Transition to "${scenes[i + 1].name}": ${trMeta.label}${tr && tr.type !== 'cut' ? ` (${tr.duration}s)` : ''} — click to change`}
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTrOpen(o => (o?.id === s.id ? null : { id: s.id, x: r.left, y: r.bottom + 4 }));
                }}
              >{trMeta.glyph}</button>
            )}
            </Fragment>
          );
        })}
        <button className="scene-bar__add" onClick={addScene} title={isSlideshow ? 'Add slide' : 'Add scene'}>
          + {isSlideshow ? 'Slide' : 'Scene'}
        </button>
      </div>
      {trOpen && (() => {
        const idx = scenes.findIndex(s => s.id === trOpen.id);
        const s = scenes[idx];
        if (!s || idx >= scenes.length - 1) return null;
        const tr = s.transition_out ?? null;
        const type = (tr?.type ?? '') as '' | TransitionType;
        return (
          <>
            {/* Fixed-position popover (the tab strip scrolls horizontally and would clip it). */}
            <div className="scene-tr-backdrop" onClick={() => setTrOpen(null)} />
            <div className="scene-tr-pop" style={{ left: trOpen.x, top: trOpen.y }}>
              <div className="scene-tr-pop__title">{s.name} → {scenes[idx + 1].name}</div>
              <label className="field">
                <span className="field__label">Transition</span>
                <select className="field__input" value={type} onChange={e => {
                  const v = e.target.value as '' | TransitionType;
                  setSceneTransition(s.id, v ? { type: v, duration: tr?.duration ?? DEFAULT_TR_DURATION } : null);
                }}>
                  {TRANSITIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              {tr && tr.type !== 'cut' && (
                <label className="field">
                  <span className="field__label">Duration (s)</span>
                  <input className="field__input" type="number" min={0.1} max={5} step={0.1} value={tr.duration}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isNaN(v)) setSceneTransition(s.id, { ...tr, duration: Math.max(0.1, Math.min(5, v)) }, `scene-tr:${s.id}`);
                    }} />
                </label>
              )}
              <span className="panel-hint">
                {type ? 'Applied when all scenes are exported as one video.' : 'Follows the Export panel\'s "crossfade between scenes" setting.'}
              </span>
            </div>
          </>
        );
      })()}
    </div>
  );
}
