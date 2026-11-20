import { create } from 'zustand';
import { produce } from 'immer';
import type { Project, ProjectSettings, Scene, SceneObject, Keyframe, Relationship, AnimationGroup, CameraTrack, AudioClip } from '../types/ir';
import { saveProject } from '../api/client';
import { newId, uniqueName, copyName } from './objectFactory';
import { computeFinalState } from './finalState';
import { useTimelineStore } from '../timeline/timelineStore';

const HISTORY_LIMIT = 50;

interface ProjectState {
  project: Project | null;
  selectedSceneId: string | null;
  selectedObjectIds: string[];
  clipboard: SceneObject[];
  // Audio-clip clipboard — scoped to a project (assets are per-project files).
  // Copying objects clears it, so Ctrl+V always pastes the most recent copy.
  audioClipboard: { projectId: string; clip: AudioClip } | null;
  history: Project[];
  future: Project[];
  isDirty: boolean;

  // Loading
  setProject: (p: Project) => void;
  clearProject: () => void;
  selectScene: (id: string) => void;

  // Project-level settings (the "Project Settings" dialog)
  updateMetadata: (patch: Record<string, string>) => void;
  updateSettings: (patch: Partial<ProjectSettings>) => void;
  setSceneBackground: (id: string, color: string | null) => void;
  clearSceneBackgrounds: () => void;
  setObjectDefault: (key: string, scope: 'style' | 'props', prop: string, value: unknown) => void;
  resetObjectDefault: (key: string) => void;
  resetAllObjectDefaults: () => void;

  // Scenes
  addScene: () => void;
  removeScene: (id: string) => void;
  duplicateScene: (id: string) => void;
  duplicateSceneFinal: (id: string) => void;
  renameScene: (id: string, name: string) => void;
  moveScene: (id: string, dir: -1 | 1) => void;
  reorderScene: (id: string, toIndex: number) => void;
  setSceneAutoAdvance: (id: string, on: boolean) => void;

  // Selection
  selectObject: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;

  // Object mutations
  addObject: (obj: SceneObject) => void;
  // `coalesceKey`: pass from typed / dragged inputs so one gesture is one undo step (see `_mutate`).
  updateObject: (id: string, patch: Partial<SceneObject>, coalesceKey?: string) => void;
  removeObject: (id: string) => void;
  removeSelected: () => void;
  moveObject: (id: string, x: number, y: number) => void;
  moveObjectsBy: (ids: string[], dx: number, dy: number) => void;
  reorderObject: (id: string, toIndex: number) => void;

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
  updateKeyframe: (id: string, patch: Partial<Keyframe>, coalesceKey?: string) => void;
  moveKeyframesBy: (ids: string[], dt: number) => void;
  removeKeyframe: (id: string) => void;
  removeKeyframes: (ids: string[]) => void;
  groupKeyframes: (ids: string[]) => void;
  ungroupKeyframes: (ids: string[]) => void;

  // Slide breaks (slideshow projects): mid-scene pause points
  addBreak: (atTime: number) => void;
  moveBreak: (id: string, time: number) => void;
  removeBreak: (id: string) => void;

  // Audio track
  addAudioClip: (clip: AudioClip) => void;
  updateAudioClip: (id: string, patch: Partial<AudioClip>, coalesceKey?: string) => void;
  removeAudioClip: (id: string) => void;
  splitAudioClip: (id: string, atTime: number) => void;
  copyAudioClip: (id: string) => void;
  pasteAudioClip: (atTime?: number) => void; // defaults to the playhead; pastes into the *active* scene
  duplicateAudioClip: (id: string) => void;

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

// A plain `text` object is named after what it says: the first non-empty line of
// its content (capped, and numbered if another object already has that name).
// Empty content falls back to "Text N". Overridden once the user types a name of
// their own (`props.name_custom`, set by the Inspector's Name field).
function autoTextName(scene: Scene, obj: SceneObject): string {
  const raw = String((obj.props as Record<string, unknown>).text ?? '');
  const line = raw.split('\n').map(l => l.trim()).find(l => l) ?? '';
  const others = scene.objects.filter(o => o.id !== obj.id).map(o => o.name);
  return uniqueName(others, (line || 'Text').slice(0, 60));
}

// Auto-number copies against the names already in the target scene (and against
// each other), the same way `addObject` numbers a repeated default name.
function renameCopies(scene: Scene, copies: SceneObject[]): void {
  const taken = new Set(scene.objects.map(o => o.name));
  for (const c of copies) {
    c.name = copyName(taken, c.name);
    taken.add(c.name);
  }
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
  audioClipboard: null,
  history: [],
  future: [],
  isDirty: false,

  setProject: (p) => set({ project: p, selectedSceneId: p.scenes[0]?.id ?? null, selectedObjectIds: [], history: [], future: [], isDirty: false }),

  clearProject: () => set({ project: null, selectedSceneId: null, selectedObjectIds: [], history: [], future: [], isDirty: false }),

  selectScene: (id) => { useTimelineStore.getState().clearKf(); set({ selectedSceneId: id, selectedObjectIds: [] }); },

  // --- Project settings ---------------------------------------------------
  // These all coalesce (see `_mutate`): typing a name or dragging a colour
  // picker fires per keystroke / per pixel, and each one would otherwise be its
  // own undo step — enough to flush the whole 50-entry history.

  updateMetadata: (patch) => _mutate(set, get, draft => {
    draft.metadata = { ...draft.metadata, ...patch };
  }, undefined, `metadata:${Object.keys(patch).join(',')}`),

  updateSettings: (patch) => _mutate(set, get, draft => {
    draft.settings = { ...draft.settings, ...patch };
  }, undefined, `settings:${Object.keys(patch).join(',')}`),

  // A scene may override the project background; both the canvas and the codegen
  // read `scene.background_color || settings.background_color`. null = inherit.
  setSceneBackground: (id, color) => _mutate(set, get, draft => {
    const s = draft.scenes.find(sc => sc.id === id);
    if (s) s.background_color = color;
  }, undefined, `scene-bg:${id}`),

  // Hand every scene back to the project background — the one action that makes
  // the project colour truly apply everywhere.
  clearSceneBackgrounds: () => _mutate(set, get, draft => {
    draft.scenes.forEach(s => { s.background_color = null; });
  }),

  // --- Object defaults ----------------------------------------------------
  // Defaults for newly added objects, keyed by Add-panel entry. Stored sparsely:
  // one property per call, so anything the user never touches keeps following
  // the factory built-in (see `withDefaults` in objectFactory.ts). Existing
  // objects are deliberately left alone — this only shapes what gets created.
  // `value === undefined` *clears* this one property's override, handing it back
  // to the factory built-in — and drops the entry entirely once nothing is left,
  // so "customised" dots and the Reset-all count stay truthful.
  setObjectDefault: (key, scope, prop, value) => _mutate(set, get, draft => {
    const all = draft.settings.object_defaults ?? (draft.settings.object_defaults = {});
    const entry = all[key] ?? (all[key] = { style: {}, props: {} });
    // Older entries may predate one of the halves.
    if (!entry.style) entry.style = {};
    if (!entry.props) entry.props = {};
    if (value === undefined) {
      delete entry[scope][prop];
      if (!Object.keys(entry.style).length && !Object.keys(entry.props).length) delete all[key];
    } else {
      entry[scope][prop] = value;
    }
  }, undefined, `objdefault:${key}:${scope}:${prop}`),

  resetObjectDefault: (key) => _mutate(set, get, draft => {
    if (draft.settings.object_defaults) delete draft.settings.object_defaults[key];
  }),

  resetAllObjectDefaults: () => _mutate(set, get, draft => {
    draft.settings.object_defaults = {};
  }),

  addScene: () => {
    const id = newId('scene');
    _mutate(set, get, draft => {
      const unit = draft.kind === 'slideshow' ? 'Slide' : 'Scene';
      draft.scenes.push({
        id, name: `${unit} ${draft.scenes.length + 1}`, background_color: null,
        objects: [], relationships: [], timeline: { keyframes: [], groups: [] },
        audio: [],
        camera_track: { initial_pan: { x: 0, y: 0 }, initial_zoom: 1 },
        transition_in: null, transition_out: null,
        auto_advance: false,
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

  duplicateSceneFinal: (id) => {
    const newSceneId = newId('scene');
    _mutate(set, get, draft => {
      const idx = draft.scenes.findIndex(s => s.id === id);
      if (idx < 0) return;
      const src = draft.scenes[idx];
      const { objects, cameraTrack } = computeFinalState(src);
      draft.scenes.splice(idx + 1, 0, {
        id: newSceneId,
        name: `${src.name} (final)`,
        background_color: src.background_color,
        objects,
        // Keep static layout (relationships re-apply at render as before), drop
        // the timeline — the end state is baked into the objects themselves.
        relationships: JSON.parse(JSON.stringify(src.relationships)),
        timeline: { keyframes: [], groups: [] },
        audio: [], // a "final state" scene is static — narration doesn't carry over
        camera_track: cameraTrack,
        transition_in: src.transition_in ? { ...src.transition_in } : null,
        transition_out: src.transition_out ? { ...src.transition_out } : null,
        auto_advance: src.auto_advance ?? false,
      });
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

  // Slideshow projects only: skip the click and roll straight into the next slide.
  setSceneAutoAdvance: (id, on) => _mutate(set, get, draft => {
    const s = draft.scenes.find(sc => sc.id === id);
    if (s) s.auto_advance = on;
  }),

  reorderScene: (id, toIndex) => _mutate(set, get, draft => {
    const idx = draft.scenes.findIndex(s => s.id === id);
    if (idx < 0) return;
    const j = Math.max(0, Math.min(draft.scenes.length - 1, toIndex));
    if (j === idx) return;
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
    if (!scene) return;
    // Auto-number a repeated default name: 2nd "Equation" -> "Equation 2", etc.
    obj.name = uniqueName(scene.objects.map(o => o.name), obj.name);
    scene.objects.push(obj);
  }, [obj.id]),

  updateObject: (id, patch, coalesceKey) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const obj = scene?.objects.find(o => o.id === id);
    if (!obj || !scene) return;
    Object.assign(obj, patch);
    // Keep an un-overridden `text` object's name in step with its content.
    if (obj.type === 'text' && !(obj.props as Record<string, unknown>).name_custom) {
      obj.name = autoTextName(scene, obj);
    }
  }, undefined, coalesceKey),

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

  // Move one object to another slot in `scene.objects` — the order the timeline
  // stacks its lanes in (and the order the codegen emits them, which decides
  // stacking for objects sharing a z_index).
  reorderObject: (id, toIndex) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    const from = scene.objects.findIndex(o => o.id === id);
    if (from < 0) return;
    const j = Math.max(0, Math.min(scene.objects.length - 1, toIndex));
    if (j === from) return;
    const [o] = scene.objects.splice(from, 1);
    scene.objects.splice(j, 0, o);
  }),

  copySelection: () => {
    const { project, selectedSceneId, selectedObjectIds } = get();
    const scene = activeScene(project, selectedSceneId);
    if (!scene || !selectedObjectIds.length) return;
    set({
      clipboard: withGroupChildren(scene, selectedObjectIds).map(o => JSON.parse(JSON.stringify(o))),
      audioClipboard: null, // objects copied last -> Ctrl+V pastes objects
    });
  },

  paste: () => {
    const { clipboard } = get();
    if (!clipboard.length) return;
    const copies = cloneObjects(clipboard);
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      renameCopies(scene, copies);
      scene.objects.push(...copies);
    }, copies.filter(c => c.type === 'group' || !c.parent_id).map(c => c.id));
  },

  duplicateSelection: () => {
    const { project, selectedSceneId, selectedObjectIds } = get();
    const scene = activeScene(project, selectedSceneId);
    if (!scene || !selectedObjectIds.length) return;
    const copies = cloneObjects(withGroupChildren(scene, selectedObjectIds));
    _mutate(set, get, draft => {
      const d = activeScene(draft, get().selectedSceneId);
      if (!d) return;
      renameCopies(d, copies);
      d.objects.push(...copies);
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
      scene.relationships = scene.relationships.filter(r => r.subject_id !== groupId && r.anchor_id !== groupId);
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

  updateKeyframe: (id, patch, coalesceKey) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const kf = scene?.timeline.keyframes.find(k => k.id === id);
    if (kf) Object.assign(kf, patch);
  }, undefined, coalesceKey),

  // Shift a set of keyframes along the timeline by the same delta, in one undo
  // entry — used when dragging a multi-selection of keyframes as a group.
  moveKeyframesBy: (ids, dt) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    const idSet = new Set(ids);
    scene.timeline.keyframes.forEach(k => {
      if (idSet.has(k.id)) k.start_time = Math.max(0, Math.round((k.start_time + dt) * 100) / 100);
    });
  }),

  removeKeyframe: (id) => {
    useTimelineStore.getState().clearKf();
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (scene) scene.timeline.keyframes = scene.timeline.keyframes.filter(k => k.id !== id);
    });
  },

  // Delete several keyframes as ONE undo step (Delete on a multi-selection).
  removeKeyframes: (ids) => {
    if (!ids.length) return;
    useTimelineStore.getState().clearKf();
    const idSet = new Set(ids);
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (scene) scene.timeline.keyframes = scene.timeline.keyframes.filter(k => !idSet.has(k.id));
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

  // ---- Slide breaks -------------------------------------------------------
  // Player-side pause points inside a slide. Kept sorted so "the next break
  // after t" is a scan, and so the timeline draws them in order.
  addBreak: (atTime) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    if (!scene.breaks) scene.breaks = []; // scenes saved before breaks existed
    const time = Math.max(0, Math.round(atTime * 100) / 100);
    // A second break at the same instant would be indistinguishable on the
    // timeline and would stop playback twice in a row.
    if (scene.breaks.some(b => Math.abs(b.time - time) < 0.01)) return;
    scene.breaks.push({ id: newId('brk'), time });
    scene.breaks.sort((a, b) => a.time - b.time);
  }),

  // Moving a break is a *ripple* edit: everything that starts at or after it —
  // keyframes, audio clips and the later breaks — rides along by the same delta.
  // A break marks where one segment of the slide ends and the next begins, so
  // dragging it re-times that segment while leaving the following ones intact
  // (moving the break alone would just squeeze the next segment). Riders are
  // picked by *start*: an animation that spans the break keeps its place, since
  // it can't be split across a pause.
  moveBreak: (id, time) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const brk = scene?.breaks?.find(b => b.id === id);
    if (!scene || !brk) return;
    const from = brk.time;
    const EPS = 1e-6;
    const kfs = scene.timeline.keyframes.filter(k => k.start_time >= from - EPS);
    const clips = (scene.audio ?? []).filter(c => c.start_time >= from - EPS);
    const later = scene.breaks!.filter(b => b.id !== id && b.time > from + EPS);

    let delta = Math.round(time * 100) / 100 - from;
    // Nothing may be pushed before t=0 …
    const earliest = Math.min(from, ...kfs.map(k => k.start_time), ...clips.map(c => c.start_time));
    delta = Math.max(delta, -earliest);
    // … and a break may not be dragged past the one before it (which stays put,
    // so crossing it would silently reorder the segments).
    const prev = scene.breaks!.filter(b => b.time < from - EPS).map(b => b.time);
    if (prev.length) delta = Math.max(delta, Math.max(...prev) + 0.01 - from);
    if (!delta) return;

    brk.time = Math.round((from + delta) * 100) / 100;
    kfs.forEach(k => { k.start_time = Math.max(0, Math.round((k.start_time + delta) * 100) / 100); });
    clips.forEach(c => { c.start_time = Math.max(0, Math.round((c.start_time + delta) * 1000) / 1000); });
    later.forEach(b => { b.time = Math.round((b.time + delta) * 100) / 100; });
    scene.breaks!.sort((a, b) => a.time - b.time);
  }),

  removeBreak: (id) => {
    useTimelineStore.getState().selectBreak(null);
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (scene?.breaks) scene.breaks = scene.breaks.filter(b => b.id !== id);
    });
  },

  addAudioClip: (clip) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    if (!scene.audio) scene.audio = []; // legacy scenes saved before the audio track
    scene.audio.push(clip);
  }),

  updateAudioClip: (id, patch, coalesceKey) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const clip = scene?.audio?.find(c => c.id === id);
    if (clip) Object.assign(clip, patch);
  }, undefined, coalesceKey),

  removeAudioClip: (id) => {
    useTimelineStore.getState().clearKf();
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (scene?.audio) scene.audio = scene.audio.filter(c => c.id !== id);
    });
  },

  copyAudioClip: (id) => {
    const { project, selectedSceneId } = get();
    const scene = activeScene(project, selectedSceneId);
    const clip = scene?.audio?.find(c => c.id === id);
    if (!project || !clip) return;
    set({ audioClipboard: { projectId: project.id, clip: JSON.parse(JSON.stringify(clip)) } });
  },

  pasteAudioClip: (atTime) => {
    const { audioClipboard, project } = get();
    // Assets live under one project's dir, so the clipboard doesn't cross projects.
    if (!audioClipboard || !project || audioClipboard.projectId !== project.id) return;
    const t = atTime ?? useTimelineStore.getState().playhead;
    const clip: AudioClip = {
      ...JSON.parse(JSON.stringify(audioClipboard.clip)),
      id: newId('au'),
      start_time: Math.max(0, Math.round(t * 1000) / 1000),
    };
    _mutate(set, get, draft => {
      const scene = activeScene(draft, get().selectedSceneId);
      if (!scene) return;
      if (!scene.audio) scene.audio = [];
      scene.audio.push(clip);
    });
    useTimelineStore.getState().selectAudio(clip.id);
  },

  duplicateAudioClip: (id) => {
    const { project, selectedSceneId } = get();
    const src = activeScene(project, selectedSceneId)?.audio?.find(c => c.id === id);
    if (!src) return;
    const copy: AudioClip = { ...src, id: newId('au'), start_time: src.start_time + 0.2 };
    _mutate(set, get, draft => {
      activeScene(draft, get().selectedSceneId)?.audio?.push(copy);
    });
    useTimelineStore.getState().selectAudio(copy.id);
  },

  splitAudioClip: (id, atTime) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    const clip = scene?.audio?.find(c => c.id === id);
    if (!scene || !clip) return;
    const cut = atTime - clip.start_time;
    if (cut < 0.05 || cut > clip.duration - 0.05) return; // too close to an edge
    // Non-destructive: the right half is a new clip windowing the same asset.
    const right: AudioClip = {
      ...clip, id: newId('au'), start_time: atTime,
      offset: clip.offset + cut, duration: clip.duration - cut,
    };
    clip.duration = cut;
    scene.audio.push(right);
  }),

  updateCameraTrack: (patch) => _mutate(set, get, draft => {
    const scene = activeScene(draft, get().selectedSceneId);
    if (!scene) return;
    scene.camera_track = { ...scene.camera_track, ...patch };
  }),

  undo: () => {
    const { history, project } = get();
    if (!history.length || !project) return;
    _coalesce = null; // the entry a coalescing gesture would merge into is gone
    const prev = history[history.length - 1];
    const sel = _validSelection(prev, get().selectedSceneId, get().selectedObjectIds);
    set(s => ({ project: prev, history: s.history.slice(0, -1), future: [project, ...s.future], isDirty: true,
      ...sel }));
    _scheduleSave(get);
  },

  redo: () => {
    const { future, project } = get();
    if (!future.length || !project) return;
    _coalesce = null;
    const next = future[0];
    const sel = _validSelection(next, get().selectedSceneId, get().selectedObjectIds);
    set(s => ({ project: next, history: [...s.history, project!], future: s.future.slice(1), isDirty: true,
      ...sel }));
    _scheduleSave(get);
  },

  save: async () => {
    const { project } = get();
    if (!project) return;
    const saved = await saveProject(project);
    // Only adopt the server's copy if nothing changed while the PUT was in
    // flight — otherwise it would silently revert those edits (and the next
    // autosave would then persist the reverted state).
    if (get().project === project) set({ project: saved, isDirty: false });
  },
}));

// Undo/redo can resurrect or remove scenes and objects. Keep the active scene
// pointing at one that exists (undoing "+ Scene" would otherwise leave the whole
// editor blank, with every mutation silently no-oping) and drop selected ids
// that are gone.
function _validSelection(p: Project, sceneId: string | null, objIds: string[]):
  Pick<ProjectState, 'selectedSceneId' | 'selectedObjectIds'> {
  let scene = p.scenes.find(s => s.id === sceneId);
  if (!scene) {
    scene = p.scenes[0];
    useTimelineStore.getState().clearKf();
  }
  const live = new Set(scene?.objects.map(o => o.id) ?? []);
  return { selectedSceneId: scene?.id ?? null, selectedObjectIds: objIds.filter(id => live.has(id)) };
}

// ---------------------------------------------------------------------------
// Helper: snapshot → immer mutation → store update.
// `selectIds` optionally replaces the selection after the mutation.
//
// `coalesceKey` is for edits that fire continuously from one gesture — a colour
// picker emits a change per pixel dragged, a text field one per keystroke. While
// the same key keeps arriving within COALESCE_MS, the mutation *replaces* the
// previous history entry instead of pushing a new one, so the gesture costs a
// single undo step rather than flooding (and evicting) the 50-entry stack. Any
// mutation without that key breaks the chain, so an unrelated edit in between
// still lands as its own step.
// ---------------------------------------------------------------------------
const COALESCE_MS = 1500;
let _coalesce: { key: string; at: number } | null = null;

function _mutate(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
  recipe: (draft: Project) => void,
  selectIds?: string[],
  coalesceKey?: string,
): void {
  const { project, history } = get();
  if (!project) return;
  const next = produce(project, recipe);
  const now = Date.now();
  const merge = !!coalesceKey && _coalesce?.key === coalesceKey
    && now - _coalesce.at < COALESCE_MS && history.length > 0;
  _coalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
  const newHistory = merge ? history : [...history, project].slice(-HISTORY_LIMIT);
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
    // Copy/paste routes to the audio clipboard when an audio clip is selected
    // (timeline selection and object selection are mutually exclusive).
    const audioId = useTimelineStore.getState().selectedAudioId;
    if (ctrl && e.key === 'c') { e.preventDefault(); if (audioId) s.copyAudioClip(audioId); else s.copySelection(); return; }
    if (ctrl && e.key === 'v') { e.preventDefault(); if (s.audioClipboard) s.pasteAudioClip(); else s.paste(); return; }
    if (ctrl && e.key === 'd') { e.preventDefault(); if (audioId) s.duplicateAudioClip(audioId); else s.duplicateSelection(); return; }
    if (ctrl && e.key === 'g') { e.preventDefault(); s.groupSelected(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); // also stops Backspace from navigating back
      const tl = useTimelineStore.getState();
      if (tl.selectedKfIds.length) { s.removeKeyframes(tl.selectedKfIds); }
      else if (tl.selectedAudioId) { s.removeAudioClip(tl.selectedAudioId); }
      else if (tl.selectedBreakId) { s.removeBreak(tl.selectedBreakId); }
      else if (s.selectedObjectIds.length) { s.removeSelected(); }
    }
  });
}
