import { create } from 'zustand';
import type { AnimationVerb } from '../types/ir';

// Sentinel object id for keyframes that drive the camera (mirrors the backend).
export const CAMERA_ID = '__camera__';

// UI-only state for the timeline editor (not persisted with the project).
interface TimelineUIState {
  selectedKfIds: string[];
  pxPerSec: number;
  selectKf: (id: string, additive?: boolean) => void;
  clearKf: () => void;
  setPxPerSec: (v: number) => void;
}

export const useTimelineStore = create<TimelineUIState>((set) => ({
  selectedKfIds: [],
  pxPerSec: 90,
  selectKf: (id, additive) => set(s => {
    if (!additive) return { selectedKfIds: [id] };
    return {
      selectedKfIds: s.selectedKfIds.includes(id)
        ? s.selectedKfIds.filter(x => x !== id)
        : [...s.selectedKfIds, id],
    };
  }),
  clearKf: () => set({ selectedKfIds: [] }),
  setPxPerSec: (v) => set({ pxPerSec: Math.max(20, Math.min(400, v)) }),
}));

// Verb metadata: label + a color family for keyframe blocks.
export const VERB_META: Record<AnimationVerb, { label: string; color: string }> = {
  write: { label: 'Write', color: '#2563eb' },
  create: { label: 'Create', color: '#2563eb' },
  draw_border_then_fill: { label: 'Draw+Fill', color: '#2563eb' },
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
  'write', 'create', 'draw_border_then_fill', 'fade_in', 'fade_out',
  'transform', 'replacement_transform', 'move', 'scale', 'rotate',
  'indicate', 'circumscribe', 'flash',
];

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
