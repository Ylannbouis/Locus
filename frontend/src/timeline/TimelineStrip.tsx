import { useProjectStore } from '../store/projectStore';
import { newId } from '../store/objectFactory';
import type { AnimationVerb, Keyframe } from '../types/ir';

const VERB_OPTIONS: { value: AnimationVerb | 'none'; label: string }[] = [
  { value: 'none', label: '—' },
  { value: 'write', label: 'Write' },
  { value: 'create', label: 'Create' },
  { value: 'fade_in', label: 'Fade In' },
  { value: 'fade_out', label: 'Fade Out' },
];

export function TimelineStrip() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const addKeyframe = useProjectStore(s => s.addKeyframe);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const keyframes = scene?.timeline.keyframes ?? [];

  const kfFor = (objId: string) => keyframes.find(k => k.object_id === objId);

  const onVerbChange = (objId: string, value: string) => {
    const existing = kfFor(objId);
    if (value === 'none') {
      if (existing) removeKeyframe(existing.id);
      return;
    }
    if (existing) {
      updateKeyframe(existing.id, { verb: value as AnimationVerb });
    } else {
      const kf: Keyframe = {
        id: newId('kf'),
        object_id: objId,
        start_time: 0,
        verb: value as AnimationVerb,
        duration: 1,
        easing: 'smooth',
        group_id: null,
        params: {},
      };
      addKeyframe(kf);
    }
  };

  return (
    <div className="timeline">
      <div className="timeline__header">
        <span className="panel-title">Timeline</span>
        <span className="timeline__hint">one animation per object (sequential)</span>
      </div>

      {objects.length === 0 ? (
        <p className="panel-hint">Add objects to animate them here.</p>
      ) : (
        <div className="timeline__rows">
          <div className="timeline__row timeline__row--head">
            <span>Object</span><span>Animation</span><span>Start (s)</span><span>Duration (s)</span>
          </div>
          {objects.map(o => {
            const kf = kfFor(o.id);
            const sel = selectedIds.includes(o.id);
            return (
              <div
                key={o.id}
                className={`timeline__row ${sel ? 'timeline__row--sel' : ''}`}
                onClick={() => selectObject(o.id)}
              >
                <span className="timeline__name">{o.name || o.type}</span>
                <select
                  className="timeline__select"
                  value={kf?.verb ?? 'none'}
                  onChange={e => onVerbChange(o.id, e.target.value)}
                  onClick={e => e.stopPropagation()}
                >
                  {VERB_OPTIONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
                <input
                  className="timeline__num"
                  type="number" step={0.1} min={0}
                  value={kf?.start_time ?? 0}
                  disabled={!kf}
                  onChange={e => { const v = parseFloat(e.target.value); if (kf && !Number.isNaN(v)) updateKeyframe(kf.id, { start_time: Math.max(0, v) }); }}
                  onClick={e => e.stopPropagation()}
                />
                <input
                  className="timeline__num"
                  type="number" step={0.1} min={0.1}
                  value={kf?.duration ?? 1}
                  disabled={!kf}
                  onChange={e => { const v = parseFloat(e.target.value); if (kf && !Number.isNaN(v)) updateKeyframe(kf.id, { duration: Math.max(0.1, v) }); }}
                  onClick={e => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
