import { create } from 'zustand';
import type { AnimationVerb, SceneObject } from '../types/ir';
import { dataKind, histValues } from '../canvas/data';

// Sentinel object id for keyframes that drive the camera (mirrors the backend).
export const CAMERA_ID = '__camera__';

const SNAP_KEY = 'locus.tlSnap';

// UI-only state for the timeline editor (not persisted with the project).
interface TimelineUIState {
  selectedKfIds: string[];
  selectedAudioId: string | null; // selected audio clip (mutually exclusive with kf selection)
  selectedBreakId: string | null; // selected slide break (also mutually exclusive)
  pxPerSec: number;
  playhead: number; // seconds — audio-preview position marker
  playing: boolean;
  snapEnabled: boolean; // drag-snapping to neighbouring edges (persisted)
  // A time range on one scene's timeline (Shift+drag the ruler, or I / O at the
  // playhead) — what "Render selected range" in the Export panel renders.
  // UI-only, never saved; it belongs to the scene it was drawn on.
  range: { sceneId: string; start: number; end: number } | null;
  setRange: (r: { sceneId: string; start: number; end: number } | null) => void;
  selectKf: (id: string, additive?: boolean) => void;
  setKfSelection: (ids: string[]) => void; // replace the keyframe selection (box select)
  selectAudio: (id: string | null) => void;
  selectBreak: (id: string | null) => void;
  clearKf: () => void; // clears the whole timeline selection (keyframes + audio + breaks)
  setPxPerSec: (v: number) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (v: boolean) => void;
  toggleSnap: () => void;
}

export const useTimelineStore = create<TimelineUIState>((set) => ({
  selectedKfIds: [],
  selectedAudioId: null,
  selectedBreakId: null,
  pxPerSec: 90,
  playhead: 0,
  playing: false,
  snapEnabled: localStorage.getItem(SNAP_KEY) !== '0', // default on
  range: null,
  setRange: (r) => set({
    range: r && r.end - r.start >= 0.05
      ? { sceneId: r.sceneId, start: Math.max(0, Math.round(r.start * 100) / 100), end: Math.round(r.end * 100) / 100 }
      : null,
  }),
  selectKf: (id, additive) => set(s => {
    if (!additive) return { selectedKfIds: [id], selectedAudioId: null, selectedBreakId: null };
    return {
      selectedAudioId: null,
      selectedBreakId: null,
      selectedKfIds: s.selectedKfIds.includes(id)
        ? s.selectedKfIds.filter(x => x !== id)
        : [...s.selectedKfIds, id],
    };
  }),
  setKfSelection: (ids) => set(s => (
    s.selectedKfIds.length === ids.length && s.selectedKfIds.every((x, i) => x === ids[i])
      && !s.selectedAudioId && !s.selectedBreakId
      ? s
      : { selectedKfIds: ids, selectedAudioId: null, selectedBreakId: null })),
  selectAudio: (id) => set({ selectedAudioId: id, selectedKfIds: [], selectedBreakId: null }),
  selectBreak: (id) => set({ selectedBreakId: id, selectedKfIds: [], selectedAudioId: null }),
  clearKf: () => set({ selectedKfIds: [], selectedAudioId: null, selectedBreakId: null }),
  setPxPerSec: (v) => set({ pxPerSec: Math.max(20, Math.min(400, v)) }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (v) => set({ playing: v }),
  toggleSnap: () => set(s => {
    const v = !s.snapEnabled;
    localStorage.setItem(SNAP_KEY, v ? '1' : '0');
    return { snapEnabled: v };
  }),
}));

// Verb metadata: label + a color family for keyframe blocks.
export const VERB_META: Record<AnimationVerb, { label: string; color: string }> = {
  write: { label: 'Write', color: '#2563eb' },
  create: { label: 'Create', color: '#2563eb' },
  draw_border_then_fill: { label: 'Draw+Fill', color: '#2563eb' },
  type_on: { label: 'Type On', color: '#2563eb' },
  fade_in: { label: 'Fade In', color: '#16a34a' },
  fade_out: { label: 'Fade Out', color: '#64748b' },
  transform: { label: 'Transform', color: '#a855f7' },
  replacement_transform: { label: 'Replace', color: '#a855f7' },
  morph_equation: { label: 'Morph', color: '#a855f7' },
  move: { label: 'Move', color: '#ea580c' },
  scale: { label: 'Scale', color: '#ea580c' },
  rotate: { label: 'Rotate', color: '#ea580c' },
  indicate: { label: 'Indicate', color: '#d97706' },
  circumscribe: { label: 'Circumscribe', color: '#d97706' },
  flash: { label: 'Flash', color: '#d97706' },
  update_data: { label: 'Update', color: '#0d9488' },
  camera_move: { label: 'Camera', color: '#0891b2' },
};

// Verbs offered in the timeline "add animation" picker for object lanes.
// (camera_move is authored from the dedicated camera track, not here.)
export const TIMELINE_VERBS: AnimationVerb[] = [
  'write', 'create', 'draw_border_then_fill', 'type_on', 'fade_in', 'fade_out',
  'transform', 'replacement_transform', 'move', 'scale', 'rotate',
  'indicate', 'circumscribe', 'flash', 'update_data',
];

// Write/Create/DrawBorderThenFill need vector points and can't run on a raster
// image (the codegen degrades them to FadeIn) — don't offer them for one.
const VECTOR_ONLY_VERBS: AnimationVerb[] = ['write', 'create', 'draw_border_then_fill'];

// `type_on` (AddTextLetterByLetter) reveals one submobject per step, which only
// reads as "one letter" for a Pango `Text` — i.e. a `text` object carrying a
// `font` prop. A LaTeX `Tex` is a single submobject and would pop in whole, so
// the codegen degrades type_on to a Write for everything else; don't offer it.
function supportsTypeOn(o?: SceneObject): boolean {
  return o?.type === 'text' && !!String((o.props as Record<string, unknown>)?.font ?? '').trim();
}

// Graph subtypes anchored to an Axes (mirrors codegen `AXES_BOUND_GRAPHS`).
const AXES_BOUND = new Set(['function_plot', 'parametric', 'implicit', 'histogram']);
export const ATTACHED_DROPPED_VERBS: AnimationVerb[] = ['move', 'scale', 'rotate'];
export function isAxesBound(o?: SceneObject): boolean {
  return o?.type === 'graph' && AXES_BOUND.has(String((o.props as Record<string, unknown>)?.subtype ?? 'function_plot'));
}

export function timelineVerbsFor(o?: SceneObject): AnimationVerb[] {
  let base = supportsTypeOn(o) ? TIMELINE_VERBS : TIMELINE_VERBS.filter(v => v !== 'type_on');
  // Update (new bar heights / a new value) only means something on a
  // histogram or a number readout; the codegen drops it anywhere else.
  if (!dataKind(o)) base = base.filter(v => v !== 'update_data');
  // A graph drawn on an Axes has no position of its own: it moves, scales and
  // rotates with its axes, and the codegen drops its own transforms.
  if (isAxesBound(o)) base = base.filter(v => !ATTACHED_DROPPED_VERBS.includes(v));
  return o?.type === 'image' ? base.filter(v => !VECTOR_ONLY_VERBS.includes(v)) : base;
}

// Sensible starting params when a verb is chosen, so a new keyframe does
// something visible (notably Move, which the codegen skips without a target).
// `obj` seeds an Update with the object's own data (its current bars / value),
// which is also what makes the params fit the object at all.
export function defaultParams(verb: AnimationVerb, obj?: SceneObject): Record<string, unknown> {
  switch (verb) {
    case 'update_data': {
      const kind = dataKind(obj);
      if (kind === 'bars') return { values: histValues(obj!) };
      if (kind === 'count') return { value: Number((obj!.props as Record<string, unknown>).value ?? 0) || 0 };
      return {};
    }
    case 'move': return { delta: { x: 1, y: 0 } };
    case 'scale': return { factor: 1.5 };
    case 'rotate': return { angle_degrees: 90 };
    case 'indicate': return { color: '#ffff00', scale_factor: 1.2 };
    case 'circumscribe': return { color: '#ffff00' };
    case 'flash': return { color: '#ffff00' };
    case 'camera_move': return { pan: { x: 0, y: 0 }, zoom: 1 };
    default: return {};
  }
}

export const EASING_OPTIONS: { value: string; label: string }[] = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'linear', label: 'Linear' },
  { value: 'rush_from', label: 'Rush from' },
  { value: 'rush_into', label: 'Rush into' },
  { value: 'there_and_back', label: 'There & back' },
  { value: 'double_smooth', label: 'Double smooth' },
];
