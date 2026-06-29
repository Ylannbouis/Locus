import { useProjectStore } from '../store/projectStore';
import type { SceneObject } from '../types/ir';

const TYPE_ICON: Record<string, string> = {
  latex_text: '∑',
  matrix: '⊞',
  shape: '▭',
  coordinate_system: '✛',
  graph: '∿',
  geometry: '↗',
  group: '▦',
};

export function Outliner() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const toggleSelect = useProjectStore(s => s.toggleSelect);
  const updateObject = useProjectStore(s => s.updateObject);
  const removeObject = useProjectStore(s => s.removeObject);
  const groupSelected = useProjectStore(s => s.groupSelected);
  const ungroup = useProjectStore(s => s.ungroup);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const all = scene?.objects ?? [];
  // Top-level objects (not inside a group), highest z first.
  const topLevel = [...all].filter(o => !o.parent_id).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));
  const childrenOf = (id: string) => all.filter(o => o.parent_id === id);

  const onClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey) toggleSelect(id);
    else selectObject(id);
  };

  const renderItem = (o: SceneObject, depth: number) => {
    const sel = selectedIds.includes(o.id);
    return (
      <li key={o.id}>
        <div className={`outliner__item ${sel ? 'outliner__item--sel' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={e => onClick(e, o.id)}>
          <span className="outliner__icon">{TYPE_ICON[o.type] ?? '•'}</span>
          <span className="outliner__name">{o.name || o.type}</span>
          <span className="outliner__actions" onClick={e => e.stopPropagation()}>
            {o.type === 'group' && <button className="outliner__btn" title="Ungroup" onClick={() => ungroup(o.id)}>⊟</button>}
            <button className="outliner__btn" title="Bring forward" onClick={() => updateObject(o.id, { z_index: (o.z_index ?? 0) + 1 })}>▲</button>
            <button className="outliner__btn" title="Send backward" onClick={() => updateObject(o.id, { z_index: (o.z_index ?? 0) - 1 })}>▼</button>
            <button className="outliner__btn" title={o.visible ? 'Hide' : 'Show'} onClick={() => updateObject(o.id, { visible: !o.visible })}>{o.visible ? '👁' : '⊘'}</button>
            <button className="outliner__btn outliner__btn--del" title="Delete" onClick={() => removeObject(o.id)}>✕</button>
          </span>
        </div>
        {o.type === 'group' && childrenOf(o.id).length > 0 && (
          <ul className="outliner__list">{childrenOf(o.id).map(c => renderItem(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <div className="outliner">
      <div className="outliner__head">
        <h3 className="panel-title" style={{ margin: 0 }}>Outliner</h3>
        <button className="btn btn--ghost outliner__group-btn" disabled={selectedIds.length < 2} title="Group selected (Ctrl+G)" onClick={groupSelected}>Group</button>
      </div>
      {topLevel.length === 0 ? (
        <p className="panel-hint">No objects yet.</p>
      ) : (
        <ul className="outliner__list">{topLevel.map(o => renderItem(o, 0))}</ul>
      )}
    </div>
  );
}
