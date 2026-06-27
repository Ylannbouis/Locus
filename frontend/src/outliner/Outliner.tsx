import { useProjectStore } from '../store/projectStore';

const TYPE_ICON: Record<string, string> = {
  latex_text: '∑',
  matrix: '⊞',
  shape: '▭',
  coordinate_system: '✛',
  graph: '∿',
};

export function Outliner() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const updateObject = useProjectStore(s => s.updateObject);
  const removeObject = useProjectStore(s => s.removeObject);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  // Front-to-back: highest z first.
  const objects = [...(scene?.objects ?? [])].sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));

  return (
    <div className="outliner">
      <h3 className="panel-title">Outliner</h3>
      {objects.length === 0 ? (
        <p className="panel-hint">No objects yet.</p>
      ) : (
        <ul className="outliner__list">
          {objects.map(o => {
            const sel = selectedIds.includes(o.id);
            return (
              <li key={o.id} className={`outliner__item ${sel ? 'outliner__item--sel' : ''}`} onClick={() => selectObject(o.id)}>
                <span className="outliner__icon">{TYPE_ICON[o.type] ?? '•'}</span>
                <span className="outliner__name">{o.name || o.type}</span>
                <span className="outliner__actions" onClick={e => e.stopPropagation()}>
                  <button className="outliner__btn" title="Bring forward" onClick={() => updateObject(o.id, { z_index: (o.z_index ?? 0) + 1 })}>▲</button>
                  <button className="outliner__btn" title="Send backward" onClick={() => updateObject(o.id, { z_index: (o.z_index ?? 0) - 1 })}>▼</button>
                  <button className="outliner__btn" title={o.visible ? 'Hide' : 'Show'} onClick={() => updateObject(o.id, { visible: !o.visible })}>{o.visible ? '👁' : '⊘'}</button>
                  <button className="outliner__btn outliner__btn--del" title="Delete" onClick={() => removeObject(o.id)}>✕</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
