import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { CanvasStage } from '../canvas/CanvasStage';
import { AddPanel } from './AddPanel';
import { ScenePanel } from './ScenePanel';
import { Outliner } from '../outliner/Outliner';
import { Inspector } from '../inspector/Inspector';
import { Timeline } from '../timeline/Timeline';
import { KeyframeInspector } from '../timeline/KeyframeInspector';
import { AudioClipInspector } from '../timeline/AudioClipInspector';
import { useTimelineStore } from '../timeline/timelineStore';
import { RenderPanel } from './RenderPanel';
import { ProjectSettings } from './ProjectSettings';
import { ThemeToggle } from './ThemeToggle';

const MIN_TL = 90;
const maxTL = () => Math.round(window.innerHeight * 0.7);

export function EditorShell() {
  const project = useProjectStore(s => s.project);
  const isDirty = useProjectStore(s => s.isDirty);
  const save = useProjectStore(s => s.save);
  const clearProject = useProjectStore(s => s.clearProject);
  const hasKfSelected = useTimelineStore(s => s.selectedKfIds.length > 0);
  const hasAudioSelected = useTimelineStore(s => !!s.selectedAudioId);

  // Resizable timeline height (persisted so it survives reloads).
  const [timelineH, setTimelineH] = useState(() => {
    const saved = Number(localStorage.getItem('locus.timelineH'));
    return saved && saved >= MIN_TL ? Math.min(saved, maxTL()) : 220;
  });
  const [showSettings, setShowSettings] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const timelineHRef = useRef(timelineH);
  timelineHRef.current = timelineH;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Dragging the handle up grows the timeline.
      setTimelineH(Math.max(MIN_TL, Math.min(maxTL(), d.startH + (d.startY - e.clientY))));
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = '';
        localStorage.setItem('locus.timelineH', String(timelineHRef.current));
      }
    }
    function onResize() {
      setTimelineH(h => Math.max(MIN_TL, Math.min(maxTL(), h)));
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  if (!project) return null;

  return (
    <div className="editor-shell">
      <header className="editor-shell__topbar">
        <button className="btn btn--ghost" onClick={clearProject}>← Projects</button>
        <span className="editor-shell__title">
          {project.metadata.name}
          {isDirty && <span className="editor-shell__dirty"> •</span>}
        </span>
        <ThemeToggle />
        <button className="btn btn--ghost" onClick={() => setShowSettings(true)} title="Project settings">⚙ Settings</button>
        <button className="btn btn--ghost" onClick={save} disabled={!isDirty}>Save</button>
      </header>

      {showSettings && <ProjectSettings onClose={() => setShowSettings(false)} />}

      <div className="editor-shell__scenebar">
        <ScenePanel />
      </div>

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
          {hasAudioSelected ? <AudioClipInspector /> : hasKfSelected ? <KeyframeInspector /> : <Inspector />}
          <div className="sidebar-divider" />
          <RenderPanel />
        </aside>
      </div>

      <div
        className="editor-shell__resizer"
        onPointerDown={e => {
          dragRef.current = { startY: e.clientY, startH: timelineH };
          document.body.style.cursor = 'ns-resize';
        }}
        title="Drag to resize the timeline"
      />

      <footer className="editor-shell__timeline" style={{ height: timelineH }}>
        <Timeline />
      </footer>
    </div>
  );
}
