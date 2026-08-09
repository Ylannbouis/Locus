import { create } from 'zustand';
import type { AnimationVerb, SceneObject } from '../types/ir';

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
  selectKf: (id: string, additive?: boolean) => void;
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
  camera_move: { label: 'Camera', color: '#0891b2' },
};

// Verbs offered in the timeline "add animation" picker for object lanes.
// (camera_move is authored from the dedicated camera track, not here.)
export const TIMELINE_VERBS: AnimationVerb[] = [
  'write', 'create', 'draw_border_then_fill', 'type_on', 'fade_in', 'fade_out',
  'transform', 'replacement_transform', 'move', 'scale', 'rotate',
  'indicate', 'circumscribe', 'flash',
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

export function timelineVerbsFor(o?: SceneObject): AnimationVerb[] {
  const base = supportsTypeOn(o) ? TIMELINE_VERBS : TIMELINE_VERBS.filter(v => v !== 'type_on');
  return o?.type === 'image' ? base.filter(v => !VECTOR_ONLY_VERBS.includes(v)) : base;
}

// Sensible starting params when a verb is chosen, so a new keyframe does
// something visible (notably Move, which the codegen skips without a target).
export function defaultParams(verb: AnimationVerb): Record<string, unknown> {
  switch (verb) {
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
