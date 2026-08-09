import { create } from 'zustand';

// UI-only canvas preferences (not part of the project IR). Persisted to
// localStorage so they survive reloads, like the timeline height.
const SNAP_KEY = 'locus.snapToCenter';

interface CanvasState {
  // Snap a dragged object to the horizontal/vertical center lines when close.
  snapToCenter: boolean;
  setSnapToCenter: (v: boolean) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  snapToCenter: localStorage.getItem(SNAP_KEY) !== 'false', // default on
  setSnapToCenter: (v) => { localStorage.setItem(SNAP_KEY, String(v)); set({ snapToCenter: v }); },
}));
