import { create } from 'zustand';
import type { Guide } from '../canvas/snapping';

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
  // Record mode: the canvas shows the scene at the playhead but stays editable,
  // and drags / rotations / resizes there become keyframes (canvas/record.ts).
  // Mutually exclusive with `preview`; not persisted either.
  record: boolean;
  setRecord: (v: boolean) => void;
  // Smart-guide lines for the drag in progress (canvas/snapping.ts); cleared on release.
  guides: Guide[];
  setGuides: (g: Guide[]) => void;
  // Centre of the visible canvas area in Manim units, published by CanvasStage
  // whenever the view pans / zooms / resizes. New objects from the Add panel
  // land here, so they appear where you're looking rather than at the origin.
  viewCenter: { x: number; y: number };
  setViewCenter: (c: { x: number; y: number }) => void;
}

function sameGuides(a: Guide[], b: Guide[]): boolean {
  return a.length === b.length && a.every((g, i) => g.axis === b[i].axis && Math.abs(g.at - b[i].at) < 1e-9);
}

export const useCanvasStore = create<CanvasState>((set) => ({
  snapToCenter: localStorage.getItem(SNAP_KEY) !== 'false', // default on
  setSnapToCenter: (v) => { localStorage.setItem(SNAP_KEY, String(v)); set({ snapToCenter: v }); },
  preview: false,
  setPreview: (v) => set(v ? { preview: true, record: false } : { preview: false }),
  record: false,
  setRecord: (v) => set(v ? { record: true, preview: false } : { record: false }),
  guides: [],
  // Called on every drag-move: only publish real changes, so a drag that isn't
  // snapping doesn't re-render the canvas each frame.
  setGuides: (g) => set(s => (sameGuides(s.guides, g) ? s : { guides: g })),
  viewCenter: { x: 0, y: 0 },
  setViewCenter: (c) => set(s => (s.viewCenter.x === c.x && s.viewCenter.y === c.y ? s : { viewCenter: c })),
}));
