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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  if (!project) return null;
  const scenes = project.scenes;

  const startRename = (id: string, name: string) => { setEditingId(id); setDraftName(name); };
  const commitRename = () => {
    if (editingId && draftName.trim()) renameScene(editingId, draftName.trim());
    setEditingId(null);
  };

  return (
    <div className="scene-bar">
      <span className="scene-bar__label">Scenes</span>
      <div className="scene-bar__tabs">
        {scenes.map((s, i) => {
          const active = s.id === selectedSceneId;
          return (
            <div
              key={s.id}
              className={`scene-tab ${active ? 'is-active' : ''}`}
              onClick={() => selectScene(s.id)}
              title="Double-click to rename"
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
              {active && (
                <span className="scene-tab__actions" onClick={e => e.stopPropagation()}>
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
        <button className="scene-bar__add" onClick={addScene} title="Add scene">+ Scene</button>
      </div>
    </div>
  );
}
