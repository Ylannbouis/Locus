import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useRenderStore } from '../store/renderStore';
import { CodeView } from './CodeView';
import type { RenderFormat, ResolutionPreset } from '../types/ir';

const FORMATS: { value: RenderFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 video' },
  { value: 'gif', label: 'Animated GIF' },
  { value: 'png', label: 'PNG sequence (zip)' },
  { value: 'still', label: 'Still frame (PNG)' },
];

const RESOLUTIONS: ResolutionPreset[] = ['480p', '720p', '1080p', '4k'];
const EXT: Record<RenderFormat, string> = { mp4: 'mp4', gif: 'gif', png: 'zip', still: 'png' };

export function RenderPanel() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const { job, videoUrl, isRendering, triggerRender, reset } = useRenderStore();

  const [format, setFormat] = useState<RenderFormat>('mp4');
  const [resolution, setResolution] = useState<ResolutionPreset>(project?.settings.default_resolution ?? '1080p');
  const [fps, setFps] = useState<number>(project?.settings.default_fps ?? 30);
  const [scope, setScope] = useState<'scene' | 'all'>('scene');
  const [transparent, setTransparent] = useState(false);
  const [crossfade, setCrossfade] = useState(true);
  const [showCode, setShowCode] = useState(false);

  if (!project) return null;

  const multiScene = project.scenes.length > 1;
  const canStitch = format === 'mp4';
  const renderAll = multiScene && canStitch && scope === 'all';
  const allowTransparent = format !== 'mp4';

  const run = async () => {
    if (resolution !== '480p' &&
      !window.confirm(`Render at ${resolution}? Higher resolutions can take several minutes.`)) return;
    if (isDirty) await save();
    const quality = resolution === '480p' ? 'preview' : 'final';
    await triggerRender(project.id, renderAll ? null : selectedSceneId, {
      quality, format, resolution, fps,
      transparent: transparent && allowTransparent,
      transition: crossfade,
    });
  };

  // Quick 480p MP4 preview, ignoring the format/resolution selectors.
  const runPreview = async () => {
    if (isDirty) await save();
    await triggerRender(project.id, renderAll ? null : selectedSceneId, {
      quality: 'preview', format: 'mp4', resolution: '480p', fps,
      transparent: false, transition: crossfade,
    });
  };

  const doneFmt: RenderFormat = (job?.format as RenderFormat) ?? 'mp4';
  const downloadName = `${(project.metadata.name || 'render').replace(/\s+/g, '_')}.${EXT[doneFmt]}`;

  return (
    <div className="render-panel">
      <div className="render-panel__head">
        <h3 className="render-panel__title" style={{ margin: 0 }}>Export</h3>
        <button className="btn btn--ghost" onClick={() => setShowCode(true)} title="View generated code / JSON">&lt;/&gt; Code</button>
      </div>

      {multiScene && (
        <label className="field">
          <span className="field__label">Scope</span>
          <select className="field__input" value={canStitch ? scope : 'scene'} disabled={!canStitch}
            onChange={e => setScope(e.target.value as 'scene' | 'all')}>
            <option value="scene">This scene</option>
            <option value="all">All scenes (stitched)</option>
          </select>
        </label>
      )}

      <div className="field-row">
        <label className="field">
          <span className="field__label">Format</span>
          <select className="field__input" value={format} onChange={e => setFormat(e.target.value as RenderFormat)}>
            {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Resolution</span>
          <select className="field__input" value={resolution} onChange={e => setResolution(e.target.value as ResolutionPreset)}>
            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field__label">FPS</span>
          <input className="field__input" type="number" min={1} max={120} value={fps}
            onChange={e => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setFps(v); }} />
        </label>
        {allowTransparent && (
          <label className="field field--check" style={{ alignSelf: 'flex-end' }}>
            <input type="checkbox" checked={transparent} onChange={e => setTransparent(e.target.checked)} />
            <span className="field__label" style={{ margin: 0 }}>Transparent</span>
          </label>
        )}
      </div>

      {renderAll && (
        <label className="field field--check">
          <input type="checkbox" checked={crossfade} onChange={e => setCrossfade(e.target.checked)} />
          <span className="field__label" style={{ margin: 0 }}>Crossfade between scenes</span>
        </label>
      )}

      <button className="btn btn--secondary render-panel__trigger" onClick={runPreview} disabled={isRendering}
        title="Fast 480p MP4 preview">
        {isRendering ? 'Rendering…' : 'Render Preview (480p)'}
      </button>
      <button className="btn btn--primary render-panel__trigger" onClick={run} disabled={isRendering}>
        {isRendering ? 'Rendering…' : renderAll ? 'Render all scenes' : 'Render scene'}
      </button>

      {job && (
        <div className="render-panel__status">
          <div className="render-panel__progress-bar">
            <div className="render-panel__progress-fill" style={{ width: `${job.progress}%` }} />
          </div>
          <p className="render-panel__message">
            <span className={`render-panel__badge render-panel__badge--${job.status}`}>{job.status}</span>
            {' '}{job.message}
          </p>
        </div>
      )}

      {videoUrl && job?.status === 'done' && (
        <div className="render-panel__video">
          {doneFmt === 'mp4' && <video controls src={videoUrl} className="render-panel__player" />}
          {(doneFmt === 'gif' || doneFmt === 'still') && <img src={videoUrl} alt="render" className="render-panel__player" />}
          <a href={videoUrl} download={downloadName} className="btn btn--secondary render-panel__download">
            Download {EXT[doneFmt].toUpperCase()}
          </a>
          <button className="btn btn--ghost" onClick={reset}>Clear</button>
        </div>
      )}

      {showCode && <CodeView onClose={() => setShowCode(false)} />}
    </div>
  );
}
