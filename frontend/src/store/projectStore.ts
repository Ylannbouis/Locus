import { create } from 'zustand';
import { produce } from 'immer';
import type { Project, Scene, SceneObject, Keyframe } from '../types/ir';
import { saveProject } from '../api/client';

const HISTORY_LIMIT = 50;

interface ProjectState {
  project: Project | null;
  selectedSceneId: string | null;
  selectedObjectIds: string[];
  history: Project[];
  future: Project[];
  isDirty: boolean;

  // Loading
  setProject: (p: Project) => void;
  clearProject: () => void;
  selectScene: (id: string) => void;
  selectObject: (id: string | null) => void;

  // Object mutations
  addObject: (obj: SceneObject) => void;
  updateObject: (id: string, patch: Partial<SceneObject>) => void;
  removeObject: (id: string) => void;
  moveObject: (id: string, x: number, y: number) => void;

  // Timeline mutations
  addKeyframe: (kf: Keyframe) => void;
  updateKeyframe: (id: string, patch: Partial<Keyframe>) => void;
  removeKeyframe: (id: string) => void;

  // History
  undo: () => void;
  redo: () => void;

  // Persist
  save: () => Promise<void>;
}

function activeScene(project: Project | null, sceneId: string | null): Scene | undefined {
  if (!project || !sceneId) return undefined;
  return project.scenes.find(s => s.id === sceneId);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  selectedSceneId: null,
  selectedObjectIds: [],
  history: [],
  future: [],
  isDirty: false,

  setProject: (p) => set({ project: p, selectedSceneId: p.scenes[0]?.id ?? null, history: [], future: [], isDirty: false }),

  clearProject: () => set({ project: null, selectedSceneId: null, selectedObjectIds: [], history: [], future: [], isDirty: false }),

  selectScene: (id) => set({ selectedSceneId: id, selectedObjectIds: [] }),

  selectObject: (id) => set({ selectedObjectIds: id ? [id] : [] }),

  addObject: (obj) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    scene?.objects.push(obj);
  }),

  updateObject: (id, patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const obj = scene?.objects.find(o => o.id === id);
    if (obj) Object.assign(obj, patch);
  }),

  removeObject: (id) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    scene.objects = scene.objects.filter(o => o.id !== id);
    scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.object_id !== id);
  }),

  moveObject: (id, x, y) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const obj = scene?.objects.find(o => o.id === id);
    if (obj) { obj.position.x = x; obj.position.y = y; }
  }),

  addKeyframe: (kf) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    scene?.timeline.keyframes.push(kf);
  }),

  updateKeyframe: (id, patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const kf = scene?.timeline.keyframes.find(k => k.id === id);
    if (kf) Object.assign(kf, patch);
  }),

  removeKeyframe: (id) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.id !== id);
  }),

  undo: () => {
    const { history, project } = get();
    if (!history.length || !project) return;
    const prev = history[history.length - 1];
    set(s => ({
      project: prev,
      history: s.history.slice(0, -1),
      future: [project, ...s.future],
      isDirty: true,
    }));
  },

  redo: () => {
    const { future, project } = get();
    if (!future.length || !project) return;
    const next = future[0];
    set(s => ({
      project: next,
      history: [...s.history, project!],
      future: s.future.slice(1),
      isDirty: true,
    }));
  },

  save: async () => {
    const { project } = get();
    if (!project) return;
    const saved = await saveProject(project);
    set({ project: saved, isDirty: false });
  },
}));

// ---------------------------------------------------------------------------
// Helper: snapshot → immer mutation → store update
// ---------------------------------------------------------------------------
function _mutate(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
  recipe: (draft: Project) => void,
): void {
  const { project, history } = get();
  if (!project) return;
  const next = produce(project, recipe);
  const newHistory = [...history, project].slice(-HISTORY_LIMIT);
  set({ project: next, history: newHistory, future: [], isDirty: true });
  _scheduleSave(get);
}

// Autosave: debounced 2s
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function _scheduleSave(get: () => ProjectState) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try { await get().save(); } catch { /* ignore autosave errors */ }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      useProjectStore.getState().undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      useProjectStore.getState().redo();
    }
  });
}
