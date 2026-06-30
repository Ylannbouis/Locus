import { create } from 'zustand';
import { produce } from 'immer';
import type { Project, Scene, SceneObject, Keyframe, Relationship, AnimationGroup, CameraTrack } from '../types/ir';
import { saveProject } from '../api/client';
import { newId } from './objectFactory';
import { useTimelineStore } from '../timeline/timelineStore';

const HISTORY_LIMIT = 50;

interface ProjectState {
  project: Project | null;
  selectedSceneId: string | null;
  selectedObjectIds: string[];
  clipboard: SceneObject[];
  history: Project[];
  future: Project[];
  isDirty: boolean;

  // Loading
  setProject: (p: Project) => void;
  clearProject: () => void;
  selectScene: (id: string) => void;

  // Scenes
  addScene: () => void;
  removeScene: (id: string) => void;
  duplicateScene: (id: string) => void;
  renameScene: (id: string, name: string) => void;
  moveScene: (id: string, dir: -1 | 1) => void;

  // Selection
  selectObject: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;

  // Object mutations
  addObject: (obj: SceneObject) => void;
  updateObject: (id: string, patch: Partial<SceneObject>) => void;
  removeObject: (id: string) => void;
  removeSelected: () => void;
  moveObject: (id: string, x: number, y: number) => void;
  moveObjectsBy: (ids: string[], dx: number, dy: number) => void;

  // Clipboard / duplicate / group
  copySelection: () => void;
  paste: () => void;
  duplicateSelection: () => void;
  groupSelected: () => void;
  ungroup: (groupId: string) => void;

  // Relationships
  addRelationship: (rel: Relationship) => void;
  updateRelationship: (id: string, patch: Partial<Relationship>) => void;
  removeRelationship: (id: string) => void;

  // Timeline mutations
  addKeyframe: (kf: Keyframe) => void;
  updateKeyframe: (id: string, patch: Partial<Keyframe>) => void;
  removeKeyframe: (id: string) => void;
  groupKeyframes: (ids: string[]) => void;
  ungroupKeyframes: (ids: string[]) => void;

  // Camera
  updateCameraTrack: (patch: Partial<CameraTrack>) => void;

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

// Deep-clone a set of objects with fresh ids; rewire parent_id refs that point
// within the set and offset positions so copies are visible.
function cloneObjects(objs: SceneObject[], offset = 0.3): SceneObject[] {
  const idMap = new Map<string, string>();
  objs.forEach(o => idMap.set(o.id, newId()));
  return objs.map(o => {
    const c = JSON.parse(JSON.stringify(o)) as SceneObject;
    c.id = idMap.get(o.id)!;
    c.parent_id = o.parent_id && idMap.has(o.parent_id) ? idMap.get(o.parent_id)! : null;
    c.position = { x: o.position.x + offset, y: o.position.y - offset };
    return c;
  });
}

// Expand a selection to include the children of any selected groups.
function withGroupChildren(scene: Scene, ids: string[]): SceneObject[] {
  const idSet = new Set(ids);
  return scene.objects.filter(o => idSet.has(o.id) || (o.parent_id && idSet.has(o.parent_id)));
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  selectedSceneId: null,
  selectedObjectIds: [],
  clipboard: [],
  history: [],
  future: [],
  isDirty: false,

  setProject: (p) => set({ project: p, selectedSceneId: p.scenes[0]?.id ?? null, selectedObjectIds: [], history: [], future: [], isDirty: false }),

  clearProject: () => set({ project: null, selectedSceneId: null, selectedObjectIds: [], history: [], future: [], isDirty: false }),

  selectScene: (id) => { useTimelineStore.getState().clearKf(); set({ selectedSceneId: id, selectedObjectIds: [] }); },

  addScene: () => {
    const id = newId('scene');
    _mutate(set, get, draft => {
      draft.scenes.push({
        id, name: `Scene ${draft.scenes.length + 1}`, background_color: null,
        objects: [], relationships: [], timeline: { keyframes: [], groups: [] },
        camera_track: { initial_pan: { x: 0, y: 0 }, initial_zoom: 1 },
        transition_in: null, transition_out: null,
      });
    });
    useTimelineStore.getState().clearKf();
    set({ selectedSceneId: id, selectedObjectIds: [] });
  },

  removeScene: (id) => {
    const { project } = get();
    if (!project || project.scenes.length <= 1) return; // always keep one scene
    const idx = project.scenes.findIndex(s => s.id === id);
    _mutate(set, get, draft => { draft.scenes = draft.scenes.filter(s => s.id !== id); });
    if (get().selectedSceneId === id) {
      const remaining = get().project!.scenes;
      useTimelineStore.getState().clearKf();
      set({ selectedSceneId: remaining[Math.min(idx, remaining.length - 1)]?.id ?? null, selectedObjectIds: [] });
    }
  },

  duplicateScene: (id) => {
    const newSceneId = newId('scene');
    _mutate(set, get, draft => {
      const idx = draft.scenes.findIndex(s => s.id === id);
      if (idx < 0) return;
      const clone = JSON.parse(JSON.stringify(draft.scenes[idx])) as Scene;
      clone.id = newSceneId;
      clone.name = `${draft.scenes[idx].name} copy`;
      draft.scenes.splice(idx + 1, 0, clone);
    });
    useTimelineStore.getState().clearKf();
    set({ selectedSceneId: newSceneId, selectedObjectIds: [] });
  },

  renameScene: (id, name) => _mutate(set, get, draft => {
    const s = draft.scenes.find(sc => sc.id === id);
    if (s) s.name = name;
  }),

  moveScene: (id, dir) => _mutate(set, get, draft => {
    const idx = draft.scenes.findIndex(s => s.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= draft.scenes.length) return;
    const [s] = draft.scenes.splice(idx, 1);
    draft.scenes.splice(j, 0, s);
  }),

  selectObject: (id) => { useTimelineStore.getState().clearKf(); set({ selectedObjectIds: id ? [id] : [] }); },

  toggleSelect: (id) => { useTimelineStore.getState().clearKf(); set(s => ({
    selectedObjectIds: s.selectedObjectIds.includes(id)
      ? s.selectedObjectIds.filter(x => x !== id)
      : [...s.selectedObjectIds, id],
  })); },

  selectMany: (ids) => { useTimelineStore.getState().clearKf(); set({ selectedObjectIds: [...new Set(ids)] }); },

  addObject: (obj) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    scene?.objects.push(obj);
  }, [obj.id]),

  updateObject: (id, patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const obj = scene?.objects.find(o => o.id === id);
    if (obj) Object.assign(obj, patch);
  }),

  removeObject: (id) => {
    useTimelineStore.getState().clearKf();
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      // Removing a group frees its children rather than deleting them.
      scene.objects.forEach(o => { if (o.parent_id === id) o.parent_id = null; });
      scene.objects = scene.objects.filter(o => o.id !== id);
      scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.object_id !== id);
      scene.relationships = scene.relationships.filter(r => r.subject_id !== id && r.anchor_id !== id);
    }, []);
  },

  removeSelected: () => {
    const ids = get().selectedObjectIds;
    if (!ids.length) return;
    useTimelineStore.getState().clearKf();
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      const idSet = new Set(ids);
      scene.objects.forEach(o => { if (o.parent_id && idSet.has(o.parent_id)) o.parent_id = null; });
      scene.objects = scene.objects.filter(o => !idSet.has(o.id));
      scene.timeline.keyframes = scene.timeline.keyframes.filter(k => !idSet.has(k.object_id));
      scene.relationships = scene.relationships.filter(r => !idSet.has(r.subject_id) && !idSet.has(r.anchor_id));
    }, []);
  },

  moveObject: (id, x, y) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const obj = scene?.objects.find(o => o.id === id);
    if (obj) { obj.position.x = x; obj.position.y = y; }
  }),

  moveObjectsBy: (ids, dx, dy) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    const idSet = new Set(ids);
    for (const o of scene.objects) {
      if (idSet.has(o.id)) { o.position.x += dx; o.position.y += dy; }
    }
  }),

  copySelection: () => {
    const { project, selectedSceneId, selectedObjectIds } = get();
    const scene = activeScene(project, selectedSceneId);
    if (!scene || !selectedObjectIds.length) return;
    set({ clipboard: withGroupChildren(scene, selectedObjectIds).map(o => JSON.parse(JSON.stringify(o))) });
  },

  paste: () => {
    const { clipboard } = get();
    if (!clipboard.length) return;
    const copies = cloneObjects(clipboard);
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      scene?.objects.push(...copies);
    }, copies.filter(c => c.type === 'group' || !c.parent_id).map(c => c.id));
  },

  duplicateSelection: () => {
    const { project, selectedSceneId, selectedObjectIds } = get();
    const scene = activeScene(project, selectedSceneId);
    if (!scene || !selectedObjectIds.length) return;
    const copies = cloneObjects(withGroupChildren(scene, selectedObjectIds));
    _mutate(set, get, draft => {
      const d = activeScene(draft, get().selectedSceneId);
      d?.objects.push(...copies);
    }, copies.filter(c => c.type === 'group' || !c.parent_id).map(c => c.id));
  },

  groupSelected: () => {
    const ids = get().selectedObjectIds;
    if (ids.length < 2) return;
    const groupId = newId('grp');
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      const idSet = new Set(ids);
      const group: SceneObject = {
        id: groupId, type: 'group', name: 'Group',
        position: { x: 0, y: 0 }, anchor: 'center', z_index: 0,
        style_ref: null, style: {}, props: {}, parent_id: null, visible: true,
      };
      scene.objects.forEach(o => { if (idSet.has(o.id)) o.parent_id = groupId; });
      scene.objects.push(group);
    }, [groupId]);
  },

  ungroup: (groupId) => {
    const childIds: string[] = [];
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      scene.objects.forEach(o => { if (o.parent_id === groupId) { o.parent_id = null; childIds.push(o.id); } });
      scene.objects = scene.objects.filter(o => o.id !== groupId);
      scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.object_id !== groupId);
    }, childIds);
  },

  addRelationship: (rel) => _mutate(set, get, draft => {
    activeScene(draft, get().selectedSceneId)?.relationships.push(rel);
  }),

  updateRelationship: (id, patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const rel = scene?.relationships.find(r => r.id === id);
    if (rel) Object.assign(rel, patch);
  }),

  removeRelationship: (id) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (scene) scene.relationships = scene.relationships.filter(r => r.id !== id);
  }),

  addKeyframe: (kf) => _mutate(set, get, draft => {
    activeScene(draft, get().selectedSceneId)?.timeline.keyframes.push(kf);
  }),

  updateKeyframe: (id, patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const kf = scene?.timeline.keyframes.find(k => k.id === id);
    if (kf) Object.assign(kf, patch);
  }),

  removeKeyframe: (id) => {
    useTimelineStore.getState().clearKf();
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (scene) scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.id !== id);
    });
  },

  groupKeyframes: (ids) => {
    if (ids.length < 2) return;
    const gid = newId('agrp');
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      const idSet = new Set(ids);
      // Align grouped keyframes to a common start so they truly play in parallel.
      const members = scene.timeline.keyframes.filter(k => idSet.has(k.id));
      if (!members.length) return;
      const start = Math.min(...members.map(k => k.start_time));
      members.forEach(k => { k.group_id = gid; k.start_time = start; });
      const group: AnimationGroup = { id: gid, type: 'parallel', label: '', lag_ratio: 0 };
      scene.timeline.groups.push(group);
    });
  },

  ungroupKeyframes: (ids) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    const idSet = new Set(ids);
    const freed = new Set<string>();
    scene.timeline.keyframes.forEach(k => { if (idSet.has(k.id) && k.group_id) { freed.add(k.group_id); k.group_id = null; } });
    // Drop now-empty groups.
    scene.timeline.groups = scene.timeline.groups.filter(g =>
      scene.timeline.keyframes.some(k => k.group_id === g.id));
  }),

  updateCameraTrack: (patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    scene.camera_track = { ...scene.camera_track, ...patch };
  }),

  undo: () => {
    const { history, project } = get();
    if (!history.length || !project) return;
    const prev = history[history.length - 1];
    set(s => ({ project: prev, history: s.history.slice(0, -1), future: [project, ...s.future], isDirty: true }));
    _scheduleSave(get);
  },

  redo: () => {
    const { future, project } = get();
    if (!future.length || !project) return;
    const next = future[0];
    set(s => ({ project: next, history: [...s.history, project!], future: s.future.slice(1), isDirty: true }));
    _scheduleSave(get);
  },

  save: async () => {
    const { project } = get();
    if (!project) return;
    const saved = await saveProject(project);
    set({ project: saved, isDirty: false });
  },
}));

// ---------------------------------------------------------------------------
// Helper: snapshot → immer mutation → store update.
// `selectIds` optionally replaces the selection after the mutation.
// ---------------------------------------------------------------------------
function _mutate(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
  recipe: (draft: Project) => void,
  selectIds?: string[],
): void {
  const { project, history } = get();
  if (!project) return;
  const next = produce(project, recipe);
  const newHistory = [...history, project].slice(-HISTORY_LIMIT);
  const patch: Partial<ProjectState> = { project: next, history: newHistory, future: [], isDirty: true };
  if (selectIds) { patch.selectedObjectIds = selectIds; useTimelineStore.getState().clearKf(); }
  set(patch);
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
function _isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const s = useProjectStore.getState();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); s.undo(); return; }
    if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); s.redo(); return; }
    if (_isTyping(e.target)) return;
    if (ctrl && e.key === 'c') { e.preventDefault(); s.copySelection(); return; }
    if (ctrl && e.key === 'v') { e.preventDefault(); s.paste(); return; }
    if (ctrl && e.key === 'd') { e.preventDefault(); s.duplicateSelection(); return; }
    if (ctrl && e.key === 'g') { e.preventDefault(); s.groupSelected(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); // also stops Backspace from navigating back
      const kfIds = useTimelineStore.getState().selectedKfIds;
      if (kfIds.length) { kfIds.forEach(id => s.removeKeyframe(id)); }
      else if (s.selectedObjectIds.length) { s.removeSelected(); }
    }
  });
}
