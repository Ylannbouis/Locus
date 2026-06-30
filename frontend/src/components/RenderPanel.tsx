import { useProjectStore } from '../store/projectStore';
import { useRenderStore } from '../store/renderStore';

export function RenderPanel() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const { job, videoUrl, isRendering, triggerRender, reset } = useRenderStore();

  if (!project) return null;

  const ensureSaved = async () => {
    if (isDirty) await save();
  };

  const handlePreview = async () => {
    await ensureSaved();
    await triggerRender(project.id, selectedSceneId, 'preview');
  };

  const handleFinal = async () => {
    if (!window.confirm('High-quality render (1080p) can take several minutes for a long scene. Continue?')) return;
    await ensureSaved();
    await triggerRender(project.id, selectedSceneId, 'final');
  };

  return (
    <div className="render-panel">
      <h3 className="render-panel__title">Render</h3>

      <button
        className="btn btn--primary render-panel__trigger"
        onClick={handlePreview}
        disabled={isRendering}
      >
        {isRendering ? 'Rendering…' : 'Preview Render (480p)'}
      </button>
      <button
        className="btn btn--secondary render-panel__trigger"
        onClick={handleFinal}
        disabled={isRendering}
        title="1080p — slower"
      >
        Final Render (1080p)
      </button>
      {job?.quality === 'final' && isRendering && (
        <p className="render-panel__message">High quality — this may take a while.</p>
      )}

      {job && (
        <div className="render-panel__status">
          <div className="render-panel__progress-bar">
            <div
              className="render-panel__progress-fill"
              style={{ width: `${job.progress}%` }}
            />
          </div>
          <p className="render-panel__message">
            <span className={`render-panel__badge render-panel__badge--${job.status}`}>
              {job.status}
            </span>
            {' '}{job.message}
          </p>
        </div>
      )}

      {videoUrl && (
        <div className="render-panel__video">
          <video controls src={videoUrl} className="render-panel__player" />
          <a
            href={videoUrl}
            download="render.mp4"
            className="btn btn--secondary render-panel__download"
          >
            Download MP4
          </a>
          <button className="btn btn--ghost" onClick={reset}>Clear</button>
        </div>
      )}
    </div>
  );
}
