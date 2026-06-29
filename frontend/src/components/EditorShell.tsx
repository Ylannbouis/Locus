import { useProjectStore } from '../store/projectStore';
import { CanvasStage } from '../canvas/CanvasStage';
import { AddPanel } from './AddPanel';
import { Outliner } from '../outliner/Outliner';
import { Inspector } from '../inspector/Inspector';
import { Timeline } from '../timeline/Timeline';
import { KeyframeInspector } from '../timeline/KeyframeInspector';
import { useTimelineStore } from '../timeline/timelineStore';
import { RenderPanel } from './RenderPanel';

export function EditorShell() {
  const project = useProjectStore(s => s.project);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const clearProject = useProjectStore(s => s.clearProject);
  const hasKfSelected = useTimelineStore(s => s.selectedKfIds.length > 0);

  if (!project) return null;

  return (
    <div className="editor-shell">
      <header className="editor-shell__topbar">
        <button className="btn btn--ghost" onClick={clearProject}>← Projects</button>
        <span className="editor-shell__title">
          {project.metadata.name}
          {isDirty && <span className="editor-shell__dirty"> •</span>}
        </span>
        <button className="btn btn--ghost" onClick={save} disabled={!isDirty}>Save</button>
      </header>

      <div className="editor-shell__body">
        <aside className="editor-shell__sidebar editor-shell__sidebar--left">
          <AddPanel />
          <div className="sidebar-divider" />
          <Outliner />
        </aside>

        <main className="editor-shell__canvas-area">
          <CanvasStage />
        </main>

        <aside className="editor-shell__sidebar editor-shell__sidebar--right">
          {hasKfSelected ? <KeyframeInspector /> : <Inspector />}
          <div className="sidebar-divider" />
          <RenderPanel />
        </aside>
      </div>

      <footer className="editor-shell__timeline">
        <Timeline />
      </footer>
    </div>
  );
}
