import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { getSceneScript } from '../api/client';

type Tab = 'python' | 'json';

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function CodeView({ onClose }: { onClose: () => void }) {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);

  const [tab, setTab] = useState<Tab>('python');
  const [script, setScript] = useState<string>('Loading…');

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const json = project ? JSON.stringify(project, null, 2) : '';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!project || !selectedSceneId) return;
      setScript('Generating…');
      try {
        if (isDirty) await save(); // ensure the backend codegen sees the latest IR
        const src = await getSceneScript(project.id, selectedSceneId);
        if (!cancelled) setScript(src);
      } catch (e) {
        if (!cancelled) setScript(`# Failed to generate script: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, selectedSceneId]);

  const body = tab === 'python' ? script : json;
  const sceneName = scene?.name ?? 'scene';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="code-view" onClick={e => e.stopPropagation()}>
        <div className="code-view__head">
          <div className="code-view__tabs">
            <button className={`code-view__tab ${tab === 'python' ? 'is-active' : ''}`} onClick={() => setTab('python')}>Manim Python</button>
            <button className={`code-view__tab ${tab === 'json' ? 'is-active' : ''}`} onClick={() => setTab('json')}>Project JSON</button>
          </div>
          <div className="code-view__head-actions">
            <button className="btn btn--ghost" onClick={() => navigator.clipboard?.writeText(body)}>Copy</button>
            <button className="btn btn--secondary" onClick={() =>
              tab === 'python'
                ? download(`${sceneName.replace(/\s+/g, '_')}.py`, script, 'text/x-python')
                : download(`${project?.metadata.name ?? 'project'}.json`, json, 'application/json')
            }>Download</button>
            <button className="btn btn--ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        <p className="code-view__hint">
          {tab === 'python'
            ? 'One-way export of the generated Manim script for the current scene. The JSON is the source of truth — edits here are not imported back.'
            : 'The full project document (the source of truth). Human-readable and diffable.'}
        </p>
        <pre className="code-view__pre"><code>{body}</code></pre>
      </div>
    </div>
  );
}
