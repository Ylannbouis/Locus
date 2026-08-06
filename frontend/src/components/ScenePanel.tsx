import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';

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
          return (
            <div
              key={s.id}
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
          );
        })}
        <button className="scene-bar__add" onClick={addScene} title={isSlideshow ? 'Add slide' : 'Add scene'}>
          + {isSlideshow ? 'Slide' : 'Scene'}
        </button>
      </div>
    </div>
  );
}
