import { useProjectStore } from '../store/projectStore';
import { useTimelineStore } from './timelineStore';

function Num({ label, value, step = 0.1, min, onChange }: {
  label: string; value: number; step?: number; min?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="field__input" type="number" step={step} min={min}
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} />
    </label>
  );
}

// Right-sidebar editor for the selected audio clip (volume, fades, trim).
export function AudioClipInspector() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const updateAudioClip = useProjectStore(s => s.updateAudioClip);
  const removeAudioClip = useProjectStore(s => s.removeAudioClip);
  // Field selectors, not a whole-store destructure — the store's playhead
  // updates at 60fps during audio playback.
  const selectedAudioId = useTimelineStore(s => s.selectedAudioId);
  const clearKf = useTimelineStore(s => s.clearKf);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const clip = scene?.audio?.find(c => c.id === selectedAudioId);
  if (!clip) return null;

  const srcDur = clip.source_duration ?? 0;
  const maxDur = srcDur > 0 ? srcDur - clip.offset : Infinity;

  return (
    <div className="kf-inspector">
      <h3 className="panel-title">🔊 Audio Clip</h3>

      <label className="field">
        <span className="field__label">Name</span>
        <input className="field__input" type="text" value={clip.name}
          onChange={e => updateAudioClip(clip.id, { name: e.target.value })} />
      </label>

      <div className="field-row">
        <Num label="Start (s)" value={clip.start_time} min={0}
          onChange={v => updateAudioClip(clip.id, { start_time: Math.max(0, v) })} />
        <Num label="Duration (s)" value={clip.duration} min={0.1}
          onChange={v => updateAudioClip(clip.id, { duration: Math.max(0.1, Math.min(v, maxDur)) })} />
      </div>

      <Num label="Source offset (s) — trim-in point in the file" value={clip.offset} min={0}
        onChange={v => {
          const off = Math.max(0, srcDur > 0 ? Math.min(v, Math.max(0, srcDur - 0.1)) : v);
          const dur = srcDur > 0 ? Math.min(clip.duration, srcDur - off) : clip.duration;
          updateAudioClip(clip.id, { offset: off, duration: Math.max(0.1, dur) });
        }} />

      <label className="field">
        <span className="field__label">Volume — {Math.round((clip.gain ?? 1) * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01} value={clip.gain ?? 1}
          onChange={e => updateAudioClip(clip.id, { gain: parseFloat(e.target.value) })} />
      </label>

      <div className="field-row">
        <Num label="Fade in (s)" value={clip.fade_in} min={0}
          onChange={v => updateAudioClip(clip.id, { fade_in: Math.max(0, v) })} />
        <Num label="Fade out (s)" value={clip.fade_out} min={0}
          onChange={v => updateAudioClip(clip.id, { fade_out: Math.max(0, v) })} />
      </div>

      <label className="field field--check">
        <input type="checkbox" checked={clip.muted}
          onChange={e => updateAudioClip(clip.id, { muted: e.target.checked })} />
        <span className="field__label" style={{ margin: 0 }}>Muted (skipped on export too)</span>
      </label>

      <span className="panel-hint">
        Source: {clip.asset}{srcDur > 0 ? ` · ${srcDur.toFixed(2)}s` : ''}. Right-click the clip in the
        timeline to split it; splits share the same file, so cuts are non-destructive.
      </span>

      <div className="field-row" style={{ marginTop: 6 }}>
        <button className="btn btn--ghost" onClick={() => clearKf()}>Done</button>
        <button className="btn btn--danger-ghost" onClick={() => removeAudioClip(clip.id)}>Delete</button>
      </div>
    </div>
  );
}
