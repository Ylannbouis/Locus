import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useRenderStore } from '../store/renderStore';
import { CodeView } from './CodeView';
import { Presenter } from './Presenter';
import type { RenderFormat, ResolutionPreset } from '../types/ir';

const FORMATS: { value: RenderFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 video' },
  { value: 'gif', label: 'Animated GIF' },
  { value: 'png', label: 'PNG sequence (zip)' },
  { value: 'still', label: 'Still frame (PNG)' },
];

// Slideshow projects lead with the deck export; the per-slide formats still work.
const SLIDESHOW_FORMAT: { value: RenderFormat; label: string } =
  { value: 'slideshow', label: 'Slideshow (HTML deck)' };

const RESOLUTIONS: ResolutionPreset[] = ['480p', '720p', '1080p', '4k'];

/** "~2m 30s left" — the backend already rounds, so don't add precision here. */
function formatEta(seconds: number): string {
  if (seconds < 60) return `~${seconds}s left`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `~${m}m ${s}s left` : `~${m}m left`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `~${h}h ${rm}m left` : `~${h}h left`;
}

const EXT: Record<RenderFormat, string> = { mp4: 'mp4', gif: 'gif', png: 'zip', still: 'png', slideshow: 'zip' };

export function RenderPanel() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const { job, videoUrl, isRendering, triggerRender, reset } = useRenderStore();

  const isSlideshow = project?.kind === 'slideshow';
  const [format, setFormat] = useState<RenderFormat>(isSlideshow ? 'slideshow' : 'mp4');
  const [scope, setScope] = useState<'scene' | 'all'>('scene');
  const [crossfade, setCrossfade] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [presenting, setPresenting] = useState(false);

  // Resolution/FPS/transparency follow the project defaults (Project Settings)
  // until this panel is touched, then the ad-hoc choice wins for the session.
  // Holding them as `null = follow the default` rather than seeding useState is
  // what lets a default edited mid-session show up here — this panel stays
  // mounted for as long as the project is open, so it never re-seeds.
  const [resOverride, setResOverride] = useState<ResolutionPreset | null>(null);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [transparentOverride, setTransparentOverride] = useState<boolean | null>(null);

  const resolution = resOverride ?? project?.settings.default_resolution ?? '1080p';
  const fps = fpsOverride ?? project?.settings.default_fps ?? 30;
  const transparent = transparentOverride ?? project?.settings.transparent_background ?? false;

  if (!project) return null;

  const formats = isSlideshow ? [SLIDESHOW_FORMAT, ...FORMATS] : FORMATS;
  const deckExport = format === 'slideshow';
  const multiScene = project.scenes.length > 1;
  // Slideshow projects never stitch — their slides stay separate by design.
  const canStitch = format === 'mp4' && !isSlideshow;
  const renderAll = deckExport || (multiScene && canStitch && scope === 'all');
  const allowTransparent = format !== 'mp4' && !deckExport;
  const unit = isSlideshow ? 'slide' : 'scene';
  const canPresent = job?.status === 'done' && job.format === 'slideshow';

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

  // Quick 480p MP4 preview, ignoring the format/resolution selectors. In a
  // slideshow project this always previews the current slide on its own —
  // stitching every slide into one video is exactly what the kind rules out.
  const runPreview = async () => {
    if (isDirty) await save();
    await triggerRender(project.id, renderAll && !isSlideshow ? null : selectedSceneId, {
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

      {deckExport ? (
        <p className="render-panel__note">
          Renders all {project.scenes.length} slides and packages them with a click-through
          HTML player. Present it here, or download the zip to run it anywhere.
        </p>
      ) : multiScene && (
        <label className="field">
          <span className="field__label">Scope</span>
          <select className="field__input" value={canStitch ? scope : 'scene'} disabled={!canStitch}
            onChange={e => setScope(e.target.value as 'scene' | 'all')}>
            <option value="scene">This {unit}</option>
            <option value="all">All scenes (stitched)</option>
          </select>
        </label>
      )}

      <div className="field-row">
        <label className="field">
          <span className="field__label">Format</span>
          <select className="field__input" value={format} onChange={e => setFormat(e.target.value as RenderFormat)}>
            {formats.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Resolution</span>
          <select className="field__input" value={resolution} onChange={e => setResOverride(e.target.value as ResolutionPreset)}>
            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field__label">FPS</span>
          <input className="field__input" type="number" min={1} max={120} value={fps}
            onChange={e => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setFpsOverride(v); }} />
        </label>
        {allowTransparent && (
          <label className="field field--check" style={{ alignSelf: 'flex-end' }}>
            <input type="checkbox" checked={transparent} onChange={e => setTransparentOverride(e.target.checked)} />
            <span className="field__label" style={{ margin: 0 }}>Transparent</span>
          </label>
        )}
      </div>

      {renderAll && !deckExport && (
        <label className="field field--check">
          <input type="checkbox" checked={crossfade} onChange={e => setCrossfade(e.target.checked)} />
          <span className="field__label" style={{ margin: 0 }}>Crossfade between scenes</span>
        </label>
      )}

      <button className="btn btn--secondary render-panel__trigger" onClick={runPreview} disabled={isRendering}
        title={`Fast 480p MP4 preview of this ${unit}`}>
        {isRendering ? 'Rendering…' : 'Render Preview (480p)'}
      </button>
      <button className="btn btn--primary render-panel__trigger" onClick={run} disabled={isRendering}>
        {isRendering ? 'Rendering…'
          : deckExport ? 'Render slideshow'
          : renderAll ? 'Render all scenes'
          : `Render ${unit}`}
      </button>

      {job && (
        <div className="render-panel__status">
          <div className="render-panel__progress-bar">
            <div className="render-panel__progress-fill" style={{ width: `${job.progress}%` }} />
          </div>
          <p className="render-panel__message">
            <span className={`render-panel__badge render-panel__badge--${job.status}`}>{job.status}</span>
            {' '}{job.message}
            {job.status === 'running' && job.eta_seconds != null && (
              <span className="render-panel__eta"> · {formatEta(job.eta_seconds)}</span>
            )}
          </p>
        </div>
      )}

      {videoUrl && job?.status === 'done' && (
        <div className="render-panel__video">
          {doneFmt === 'mp4' && <video controls src={videoUrl} className="render-panel__player" />}
          {(doneFmt === 'gif' || doneFmt === 'still') && <img src={videoUrl} alt="render" className="render-panel__player" />}
          {canPresent && (
            <button className="btn btn--primary render-panel__trigger" onClick={() => setPresenting(true)}>
              ▶ Present
            </button>
          )}
          <a href={videoUrl} download={downloadName} className="btn btn--secondary render-panel__download">
            Download {EXT[doneFmt].toUpperCase()}
          </a>
          <button className="btn btn--ghost" onClick={reset}>Clear</button>
        </div>
      )}

      {presenting && job && <Presenter jobId={job.job_id} onClose={() => setPresenting(false)} />}
      {showCode && <CodeView onClose={() => setShowCode(false)} />}
    </div>
  );
}
