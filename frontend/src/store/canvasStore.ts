import { create } from 'zustand';

// UI-only canvas preferences (not part of the project IR). Persisted to
// localStorage so they survive reloads, like the timeline height.
const SNAP_KEY = 'locus.snapToCenter';

interface CanvasState {
  // Snap a dragged object to the horizontal/vertical center lines when close.
  snapToCenter: boolean;
  setSnapToCenter: (v: boolean) => void;
  // Playback preview: the canvas shows the scene *as animated* at the timeline
  // playhead (read-only) instead of the editable authored layout. Turned on by
  // playing or scrubbing the timeline; off via the toolbar, Esc, or a click on
  // the canvas. Deliberately not persisted — a reload should land in edit mode.
  preview: boolean;
  setPreview: (v: boolean) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  snapToCenter: localStorage.getItem(SNAP_KEY) !== 'false', // default on
  setSnapToCenter: (v) => { localStorage.setItem(SNAP_KEY, String(v)); set({ snapToCenter: v }); },
  preview: false,
  setPreview: (v) => set({ preview: v }),
}));
