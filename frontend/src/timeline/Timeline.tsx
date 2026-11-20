import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newId } from '../store/objectFactory';
import { useTimelineStore, VERB_META, timelineVerbsFor, defaultParams, CAMERA_ID } from './timelineStore';
import { uploadAudioAsset } from '../api/client';
import { playFrom, stopPlayback } from './audioPlayback';
import { useCanvasStore } from '../store/canvasStore';
import { Waveform } from './Waveform';
import type { AnimationVerb, AudioClip, Keyframe, SceneBreak, SceneObject } from '../types/ir';

const ROW_H = 30;
const AUDIO_ROW_H = 46; // taller so the waveform is readable
const LABEL_W = 150;
const SNAP_PX = 8; // snap radius in screen px (converted to seconds via pxPerSec)

// Nearest snap target within the radius, or null. Targets are the edges of the
// other items in the same lane plus t=0 and the playhead.
function snapTo(value: number, targets: number[], pxPerSec: number): number | null {
  const thresh = SNAP_PX / pxPerSec;
  let best: number | null = null;
  let bestD = thresh;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Snap a block being *moved*: try both its left and right edge, keep the closer hit.
function snapMove(start: number, dur: number, targets: number[], pxPerSec: number): number {
  const s = snapTo(start, targets, pxPerSec);
  const e = snapTo(start + dur, targets, pxPerSec);
  const dS = s === null ? Infinity : Math.abs(s - start);
  const dE = e === null ? Infinity : Math.abs(e - (start + dur));
  if (dS <= dE && s !== null) return s;
  if (e !== null) return e - dur;
  return start;
}

// Float slack for "starts at or after the break" comparisons (times are stored
// rounded to 2-3 decimals, so this only absorbs representation error).
const RIPPLE_EPS = 1e-6;

function edgeTargets(items: { id: string; start_time: number; duration: number }[], excludeId: string): number[] {
  const t = [0, useTimelineStore.getState().playhead];
  for (const it of items) {
    if (it.id === excludeId) continue;
    t.push(it.start_time, it.start_time + it.duration);
  }
  return t;
}

// Like edgeTargets but excludes a whole set — used when a group of keyframes
// moves together (they must snap to the *other* keyframes, not each other).
function edgeTargetsExcluding(items: { id: string; start_time: number; duration: number }[], exclude: Set<string>): number[] {
  const t = [0, useTimelineStore.getState().playhead];
  for (const it of items) {
    if (exclude.has(it.id)) continue;
    t.push(it.start_time, it.start_time + it.duration);
  }
  return t;
}

function defaultVerb(o: SceneObject): AnimationVerb {
  if (o.type === 'latex_text' || o.type === 'text' || o.type === 'matrix') return 'write';
  if (o.type === 'image') return 'fade_in'; // Create/Write need vector points
  return 'create';
}

// Pack a lane's items into stacked sub-rows so ones that overlap in time
// (i.e. play simultaneously) sit on separate rows within the lane rather than
// colliding. Greedy first-fit by start time -> the fewest rows that keep every
// overlapping pair apart. Returns each item's row index + the row count.
function packLanes<T extends { id: string; start_time: number; duration: number }>(
  items: T[],
): { row: Map<string, number>; count: number } {
  const sorted = [...items].sort(
    (a, b) => a.start_time - b.start_time || a.duration - b.duration || (a.id < b.id ? -1 : 1),
  );
  const laneEnds: number[] = []; // end time of the last item placed in each row
  const row = new Map<string, number>();
  for (const it of sorted) {
    let lane = laneEnds.findIndex(end => it.start_time >= end - 1e-6);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = it.start_time + it.duration;
    row.set(it.id, lane);
  }
  return { row, count: Math.max(1, laneEnds.length) };
}

interface DragState {
  kfId: string; // the grabbed keyframe (the anchor whose edge drives snapping)
  mode: 'move' | 'resize';
  startClientX: number;
  origStart: number; // anchor's original start
  origDur: number;
  curStart: number; // anchor's live start (after snap/clamp); group delta = curStart - origStart
  curDur: number;
  targets: number[]; // edges to snap to (+ 0 and playhead), captured at drag start
  // Keyframes moving together as a group (move mode). Includes the anchor; a
  // single, non-grouped drag has just one entry. `origStart` is captured so the
  // whole set shifts by one shared delta.
  members: { id: string; origStart: number }[];
}

// Audio-clip drag: move, or trim from either edge. Trimming the left edge
// shifts start_time AND offset together (the content stays anchored in time).
interface AudioDragState {
  id: string;
  mode: 'move' | 'trim-l' | 'trim-r';
  startClientX: number;
  orig: AudioClip;
  cur: { start: number; offset: number; dur: number };
  targets: number[];
}

// Object-row reorder: dragging a lane's *label* up or down moves that object's
// slot in `scene.objects` (the order the lanes are stacked in). Row geometry is
// captured at drag start so the insertion point follows from the pointer's Y.
interface ObjDragState {
  id: string;
  fromIndex: number;
  startClientY: number;
  moved: boolean; // a click that never moved just selects
  insertAt: number; // insertion index in the *pre-move* list (0 … objects.length)
  rows: { top: number; bottom: number }[]; // viewport Y of every object label, in order
}

// Slide-break drag: a break is a single point in time, so there's nothing to
// trim — only its position moves. Moving it is a ripple edit (see the store's
// `moveBreak`), so the whole tail of the scene previews the shift live.
interface BreakDragState {
  id: string;
  startClientX: number;
  origTime: number;
  curTime: number;
  targets: number[];
  lowerBound: number; // mirrors the store's clamp so the preview can't lie
  moved: boolean; // a click that never moved just selects (and must not write history)
}

type MenuState =
  | { kind: 'kf'; x: number; y: number; id: string }
  | { kind: 'clip'; x: number; y: number; id: string; time: number } // time = where the right-click landed
  | { kind: 'lane'; x: number; y: number; time: number } // empty audio-lane menu (paste target)
  | { kind: 'break'; x: number; y: number; id: string };

// The playhead line + toolbar readout subscribe to the playhead on their own,
// so the 60fps rAF updates during playback don't re-render the whole timeline.
function PlayheadLine({ pxPerSec }: { pxPerSec: number }) {
  const t = useTimelineStore(s => s.playhead);
  return <div className="tl__playhead" style={{ left: LABEL_W + t * pxPerSec }} />;
}

function PlayheadTime() {
  const t = useTimelineStore(s => s.playhead);
  return <span className="tl__time">{t.toFixed(2)}s</span>;
}

export function Timeline() {
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const selectedObjIds = useProjectStore(s => s.selectedObjectIds);
  const selectObject = useProjectStore(s => s.selectObject);
  const reorderObject = useProjectStore(s => s.reorderObject);
  const addKeyframe = useProjectStore(s => s.addKeyframe);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const moveKeyframesBy = useProjectStore(s => s.moveKeyframesBy);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);
  const groupKeyframes = useProjectStore(s => s.groupKeyframes);
  const ungroupKeyframes = useProjectStore(s => s.ungroupKeyframes);
  const addBreak = useProjectStore(s => s.addBreak);
  const moveBreak = useProjectStore(s => s.moveBreak);
  const removeBreak = useProjectStore(s => s.removeBreak);
  const addAudioClip = useProjectStore(s => s.addAudioClip);
  const updateAudioClip = useProjectStore(s => s.updateAudioClip);
  const removeAudioClip = useProjectStore(s => s.removeAudioClip);
  const splitAudioClip = useProjectStore(s => s.splitAudioClip);
  const copyAudioClip = useProjectStore(s => s.copyAudioClip);
  const pasteAudioClip = useProjectStore(s => s.pasteAudioClip);
  const duplicateAudioClip = useProjectStore(s => s.duplicateAudioClip);
  const audioClipboard = useProjectStore(s => s.audioClipboard);

  // Individual selectors (not a whole-store destructure): the playhead updates
  // at 60fps during playback and must not re-render the whole timeline — only
  // PlayheadLine / PlayheadTime subscribe to it.
  const selectedKfIds = useTimelineStore(s => s.selectedKfIds);
  const selectedAudioId = useTimelineStore(s => s.selectedAudioId);
  const selectedBreakId = useTimelineStore(s => s.selectedBreakId);
  const selectBreak = useTimelineStore(s => s.selectBreak);
  const pxPerSec = useTimelineStore(s => s.pxPerSec);
  const playing = useTimelineStore(s => s.playing);
  const selectKf = useTimelineStore(s => s.selectKf);
  const selectAudio = useTimelineStore(s => s.selectAudio);
  const clearKf = useTimelineStore(s => s.clearKf);
  const setPxPerSec = useTimelineStore(s => s.setPxPerSec);
  const setPlayhead = useTimelineStore(s => s.setPlayhead);
  const snapEnabled = useTimelineStore(s => s.snapEnabled);
  const toggleSnap = useTimelineStore(s => s.toggleSnap);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [aDrag, setADrag] = useState<AudioDragState | null>(null);
  const [bDrag, setBDrag] = useState<BreakDragState | null>(null);
  const [oDrag, setODrag] = useState<ObjDragState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrubRef = useRef<{ wasPlaying: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Close the context menu on any click outside it (the menu div stops its own
  // clicks from bubbling, and its buttons close it explicitly).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  // Stop audio + rewind when switching scenes or leaving the editor.
  useEffect(() => {
    stopPlayback();
    useTimelineStore.getState().setPlayhead(0);
  }, [selectedSceneId]);
  useEffect(() => () => stopPlayback(), []);

  // ---- render range (Shift+drag the ruler, or I / O at the playhead) --------
  const range = useTimelineStore(s => s.range);
  const setRange = useTimelineStore(s => s.setRange);
  const rangeHere = range && range.sceneId === selectedSceneId ? range : null;
  const rangeDragRef = useRef<{ anchor: number } | null>(null);
  const setIn = () => {
    if (!selectedSceneId) return;
    const t = useTimelineStore.getState().playhead;
    const end = rangeHere && rangeHere.end > t + 0.05 ? rangeHere.end : Math.max(t + 1, contentEndRef.current);
    setRange({ sceneId: selectedSceneId, start: t, end });
  };
  const setOut = () => {
    if (!selectedSceneId) return;
    const t = useTimelineStore.getState().playhead;
    const start = rangeHere && rangeHere.start < t - 0.05 ? rangeHere.start : 0;
    setRange({ sceneId: selectedSceneId, start, end: t });
  };
  const setInRef = useRef(setIn); setInRef.current = setIn;
  const setOutRef = useRef(setOut); setOutRef.current = setOut;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'i' || e.key === 'I') setInRef.current();
      else if (e.key === 'o' || e.key === 'O') setOutRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const keyframes = scene?.timeline.keyframes ?? [];
  const audioClips = scene?.audio ?? [];
  // Breaks are a slideshow concept: in an animation project the scenes are
  // stitched into one continuous video, so there is nothing to click through.
  const isSlideshow = project?.kind === 'slideshow';
  const breaks = isSlideshow ? scene?.breaks ?? [] : [];

  const contentEnd = Math.max(
    1,
    ...keyframes.map(k => k.start_time + k.duration),
    ...audioClips.map(c => c.start_time + c.duration),
    ...breaks.map(b => b.time),
  );
  const contentEndRef = useRef(contentEnd); contentEndRef.current = contentEnd;
  const totalDur = Math.max(4, contentEnd) + 2;
  const contentW = totalDur * pxPerSec;
  const ticks = Math.ceil(totalDur);

  // ---- transport ----------------------------------------------------------
  const onPlayPause = () => {
    if (playing) { stopPlayback(); return; }
    if (!project) return;
    const t = useTimelineStore.getState().playhead;
    const from = t >= contentEnd - 0.01 ? 0 : t; // at the end -> replay from the top
    // The canvas animates along (playback preview) and stays on the last frame
    // when playback ends, until the user clicks back into edit mode.
    // (In Record mode the canvas already follows the playhead and must stay
    // editable once playback stops, so don't switch it to read-only preview.)
    if (!useCanvasStore.getState().record) useCanvasStore.getState().setPreview(true);
    void playFrom(project.id, audioClips, from, contentEnd);
  };

  const onStop = () => { stopPlayback(); setPlayhead(0); };

  const rulerSeek = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPlayhead(Math.max(0, (e.clientX - rect.left) / pxPerSec));
  };

  // ---- drag handling (commit once on pointer-up) -------------------------
  // Snapping pulls the dragged edge onto neighbouring edges in the same lane
  // (plus t=0 and the playhead) when within SNAP_PX. Toggle with the 🧲
  // button; hold Alt to bypass it for one drag.
  const onPointerMove = (e: React.PointerEvent) => {
    const snapOn = snapEnabled && !e.altKey;
    if (oDrag) {
      // Insert before the first row whose midpoint is below the pointer;
      // past every midpoint means "drop at the end".
      const moved = oDrag.moved || Math.abs(e.clientY - oDrag.startClientY) > 3;
      let insertAt = oDrag.rows.length;
      for (let i = 0; i < oDrag.rows.length; i++) {
        if (e.clientY < (oDrag.rows[i].top + oDrag.rows[i].bottom) / 2) { insertAt = i; break; }
      }
      if (moved !== oDrag.moved || insertAt !== oDrag.insertAt) setODrag({ ...oDrag, moved, insertAt });
    } else if (drag) {
      const dx = (e.clientX - drag.startClientX) / pxPerSec;
      if (drag.mode === 'move') {
        let start = Math.max(0, drag.origStart + dx);
        if (snapOn) start = Math.max(0, snapMove(start, drag.origDur, drag.targets, pxPerSec));
        // Shift the whole group by the anchor's delta, but clamp so the earliest
        // member never crosses t=0 (which would compress the group's spacing).
        const minStart = Math.min(...drag.members.map(m => m.origStart));
        const delta = Math.max(start - drag.origStart, -minStart);
        setDrag({ ...drag, curStart: drag.origStart + delta });
      } else {
        let dur = drag.origDur + dx;
        if (snapOn) {
          const end = snapTo(drag.origStart + dur, drag.targets, pxPerSec);
          if (end !== null) dur = end - drag.origStart;
        }
        setDrag({ ...drag, curDur: Math.max(0.1, dur) });
      }
    } else if (bDrag) {
      const dx = (e.clientX - bDrag.startClientX) / pxPerSec;
      let t = Math.max(bDrag.lowerBound, bDrag.origTime + dx);
      if (snapOn) {
        const hit = snapTo(t, bDrag.targets, pxPerSec);
        if (hit !== null) t = Math.max(bDrag.lowerBound, hit);
      }
      setBDrag({ ...bDrag, curTime: t, moved: bDrag.moved || Math.abs(e.clientX - bDrag.startClientX) > 2 });
    } else if (aDrag) {
      const dx = (e.clientX - aDrag.startClientX) / pxPerSec;
      const o = aDrag.orig;
      if (aDrag.mode === 'move') {
        let start = Math.max(0, o.start_time + dx);
        if (snapOn) start = Math.max(0, snapMove(start, o.duration, aDrag.targets, pxPerSec));
        setADrag({ ...aDrag, cur: { ...aDrag.cur, start } });
      } else if (aDrag.mode === 'trim-l') {
        let d = dx;
        if (snapOn) {
          const edge = snapTo(o.start_time + dx, aDrag.targets, pxPerSec);
          if (edge !== null) d = edge - o.start_time;
        }
        // Can't trim before the source's own start (offset >= 0), before t=0,
        // or past the right edge.
        d = Math.max(-Math.min(o.offset, o.start_time), Math.min(d, o.duration - 0.1));
        setADrag({ ...aDrag, cur: { start: o.start_time + d, offset: o.offset + d, dur: o.duration - d } });
      } else {
        let dur = o.duration + dx;
        if (snapOn) {
          const end = snapTo(o.start_time + dur, aDrag.targets, pxPerSec);
          if (end !== null) dur = end - o.start_time;
        }
        const maxDur = o.source_duration > 0 ? o.source_duration - o.offset : Infinity;
        setADrag({ ...aDrag, cur: { ...aDrag.cur, dur: Math.max(0.1, Math.min(dur, maxDur)) } });
      }
    }
  };

  const onPointerUp = () => {
    if (oDrag) {
      // insertAt indexes the pre-move list, so dropping *after* the dragged row
      // shifts one slot back once it's pulled out.
      if (oDrag.moved) {
        const to = oDrag.insertAt > oDrag.fromIndex ? oDrag.insertAt - 1 : oDrag.insertAt;
        if (to !== oDrag.fromIndex) reorderObject(oDrag.id, to);
      }
      setODrag(null);
    } else if (drag) {
      if (drag.mode === 'move' && drag.curStart !== drag.origStart) {
        moveKeyframesBy(drag.members.map(m => m.id), drag.curStart - drag.origStart);
      } else if (drag.mode === 'resize' && drag.curDur !== drag.origDur) {
        updateKeyframe(drag.kfId, { duration: Math.round(drag.curDur * 100) / 100 });
      }
      setDrag(null);
    } else if (bDrag) {
      // A plain click (no movement) only selects — don't push an undo entry for it.
      if (bDrag.moved && bDrag.curTime !== bDrag.origTime) moveBreak(bDrag.id, bDrag.curTime);
      setBDrag(null);
    } else if (aDrag) {
      const { orig, cur } = aDrag;
      if (cur.start !== orig.start_time || cur.offset !== orig.offset || cur.dur !== orig.duration) {
        updateAudioClip(aDrag.id, {
          start_time: Math.round(cur.start * 1000) / 1000,
          offset: Math.round(cur.offset * 1000) / 1000,
          duration: Math.round(cur.dur * 1000) / 1000,
        });
      }
      setADrag(null);
    }
  };

  const startDrag = (e: React.PointerEvent, kf: Keyframe, mode: 'move' | 'resize') => {
    if (e.button !== 0) return; // only the primary button selects / starts a drag
    e.stopPropagation();
    setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Selection happens here (once). Doing it again in onClick would double-toggle
    // a shift-click and cancel it out. Shift toggles; a plain grab on a keyframe
    // that's already part of a multi-selection keeps the whole set (so it can be
    // dragged as a group), mirroring the canvas multi-select behaviour.
    const prevSel = useTimelineStore.getState().selectedKfIds;
    if (e.shiftKey) selectKf(kf.id, true);
    else if (!(prevSel.includes(kf.id) && prevSel.length > 1)) selectKf(kf.id, false);
    // Group-move only when several keyframes are selected together and we grabbed
    // one of them (resize is always the single grabbed keyframe).
    const sel = useTimelineStore.getState().selectedKfIds;
    const base = mode === 'move' && sel.includes(kf.id) && sel.length > 1 ? sel : [kf.id];
    // An animation group moves as a unit: its members' starts are derived from
    // the group (projectStore.normalizeGroups), so dragging one alone would just
    // snap back. Pull in every member of any group being grabbed.
    const gids = new Set(base.map(id => keyframes.find(k => k.id === id)?.group_id).filter(Boolean));
    const groupIds = mode === 'move' && gids.size
      ? [...new Set([...base, ...keyframes.filter(k => k.group_id && gids.has(k.group_id)).map(k => k.id)])]
      : base;
    const members = groupIds
      .map(id => keyframes.find(k => k.id === id))
      .filter((k): k is Keyframe => !!k)
      .map(k => ({ id: k.id, origStart: k.start_time }));
    const groupSet = new Set(groupIds);
    setDrag({
      kfId: kf.id, mode, startClientX: e.clientX, origStart: kf.start_time, origDur: kf.duration,
      curStart: kf.start_time, curDur: kf.duration, members,
      // Snap against keyframes not being dragged: for a group that spans lanes,
      // any other keyframe; for a single one, just its own lane (same object).
      targets: groupIds.length > 1
        ? edgeTargetsExcluding(keyframes, groupSet)
        : edgeTargets(keyframes.filter(k => k.object_id === kf.object_id), kf.id),
    });
  };

  // A break snaps to keyframe *and* clip edges, t=0, the playhead and the other
  // breaks — "pause exactly when this animation finishes" is the common case.
  // Only what *stays put* is a target though: the ripple carries everything
  // starting at or after the break along with it, so those edges would be
  // snapping to themselves.
  const breakTargets = (excludeId: string, origTime: number): number[] => {
    const stay = [...keyframes, ...audioClips].filter(i => i.start_time < origTime - RIPPLE_EPS);
    return [
      ...edgeTargets(stay, ''),
      ...breaks.filter(b => b.id !== excludeId && b.time < origTime - RIPPLE_EPS).map(b => b.time),
    ];
  };

  const startBreakDrag = (e: React.PointerEvent, b: SceneBreak) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    selectBreak(b.id);
    // Same two clamps the store applies on commit: no rider may be dragged
    // before t=0, and a break may not cross the one before it.
    const rides = (t: number) => t >= b.time - RIPPLE_EPS;
    const earliest = Math.min(
      b.time,
      ...keyframes.filter(k => rides(k.start_time)).map(k => k.start_time),
      ...audioClips.filter(c => rides(c.start_time)).map(c => c.start_time),
    );
    const prev = breaks.filter(o => o.time < b.time - RIPPLE_EPS).map(o => o.time);
    setBDrag({
      id: b.id, startClientX: e.clientX, origTime: b.time, curTime: b.time,
      targets: breakTargets(b.id, b.time), moved: false,
      lowerBound: Math.max(0, b.time - earliest, prev.length ? Math.max(...prev) + 0.01 : 0),
    });
  };

  const startObjDrag = (e: React.PointerEvent, o: SceneObject, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    selectObject(o.id);
    const rows = Array.from(gridRef.current?.querySelectorAll('[data-obj-row]') ?? []).map(el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    setODrag({ id: o.id, fromIndex: index, startClientY: e.clientY, moved: false, insertAt: index, rows });
  };

  const startAudioDrag = (e: React.PointerEvent, clip: AudioClip, mode: AudioDragState['mode']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    selectAudio(clip.id);
    setADrag({
      id: clip.id, mode, startClientX: e.clientX, orig: clip,
      cur: { start: clip.start_time, offset: clip.offset, dur: clip.duration },
      targets: edgeTargets(audioClips, clip.id),
    });
  };

  const laneTime = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left; // lane-local px (rect already accounts for scroll)
    return Math.max(0, Math.round((x / pxPerSec) * 10) / 10);
  };

  const addKfAt = (obj: SceneObject, e: React.MouseEvent) => {
    const kf: Keyframe = {
      id: newId('kf'), object_id: obj.id, start_time: laneTime(e), verb: defaultVerb(obj),
      duration: 1, easing: 'smooth', group_id: null, params: {},
    };
    addKeyframe(kf);
    selectKf(kf.id);
  };

  const addCameraKfAt = (e: React.MouseEvent) => {
    const kf: Keyframe = {
      id: newId('kf'), object_id: CAMERA_ID, start_time: laneTime(e), verb: 'camera_move',
      duration: 1.5, easing: 'smooth', group_id: null, params: defaultParams('camera_move'),
    };
    addKeyframe(kf);
    selectKf(kf.id);
  };

  const duplicateKf = (kf: Keyframe) => {
    const copy: Keyframe = { ...kf, id: newId('kf'), start_time: kf.start_time + 0.2, group_id: null, params: { ...kf.params } };
    addKeyframe(copy);
    selectKf(copy.id);
  };

  // ---- audio upload -------------------------------------------------------
  const onAudioFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !project) return;
    setUploading(true);
    try {
      const info = await uploadAudioAsset(project.id, file);
      const dur = info.duration > 0 ? info.duration : 5;
      const clip: AudioClip = {
        id: newId('au'), name: info.name || file.name, asset: info.filename,
        start_time: Math.round(useTimelineStore.getState().playhead * 100) / 100,
        offset: 0, duration: dur, source_duration: info.duration,
        gain: 1, fade_in: 0, fade_out: 0, muted: false,
      };
      addAudioClip(clip);
      selectAudio(clip.id);
    } catch (err) {
      alert(`Audio upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  const selectedHaveGroup = keyframes.some(k => selectedKfIds.includes(k.id) && k.group_id);
  const cameraKfs = keyframes.filter(k => k.object_id === CAMERA_ID);

  // Live ripple preview: while a break is dragged, everything that starts at or
  // after its original time draws at the shifted position — the same set the
  // store commits on pointer-up (see `moveBreak`).
  const withRipple = (t: number) =>
    bDrag && t >= bDrag.origTime - RIPPLE_EPS ? t + (bDrag.curTime - bDrag.origTime) : t;

  // One keyframe block, shared by the camera lane and every object lane. `row`
  // is its sub-row within the lane (0 = main row), used to stack simultaneous
  // animations vertically.
  const renderKfBlock = (kf: Keyframe, row = 0) => {
    const isAnchor = drag?.kfId === kf.id;
    // A moving group member (incl. the anchor) follows the shared delta live.
    const moving = drag?.mode === 'move' && drag.members.some(m => m.id === kf.id);
    const start = moving ? kf.start_time + (drag!.curStart - drag!.origStart) : withRipple(kf.start_time);
    const dur = isAnchor && drag!.mode === 'resize' ? drag!.curDur : kf.duration;
    const meta = VERB_META[kf.verb];
    const sel = selectedKfIds.includes(kf.id);
    const w = Math.max(18, dur * pxPerSec);
    return (
      <div key={kf.id}
        className={`tl__kf ${sel ? 'tl__kf--sel' : ''} ${kf.group_id ? 'tl__kf--grouped' : ''}`}
        style={{ left: start * pxPerSec, width: w, top: row * ROW_H + 4, height: ROW_H - 8, background: meta.color }}
        title={`${meta.label} @ ${start.toFixed(2)}s · ${dur.toFixed(2)}s${kf.group_id ? ((scene?.timeline.groups.find(g => g.id === kf.group_id)?.lag_ratio ?? 0) > 0 ? ' · staggered group' : ' · parallel group') : ''}`}
        onPointerDown={e => startDrag(e, kf, 'move')}
        onClick={e => { e.stopPropagation(); setMenu(null); }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); selectKf(kf.id, false); setMenu({ kind: 'kf', x: e.clientX, y: e.clientY, id: kf.id }); }}>
        {w > 40 && <span className="tl__kf-label">{meta.label}</span>}
        <span className="tl__kf-handle" onPointerDown={e => startDrag(e, kf, 'resize')} />
      </div>
    );
  };

  // One audio clip block: waveform + trim handles at both edges.
  const renderClipBlock = (c: AudioClip, row = 0) => {
    const isDragging = aDrag?.id === c.id;
    const start = isDragging ? aDrag!.cur.start : withRipple(c.start_time);
    const dur = isDragging ? aDrag!.cur.dur : c.duration;
    const off = isDragging ? aDrag!.cur.offset : c.offset;
    const sel = selectedAudioId === c.id;
    const w = Math.max(18, dur * pxPerSec);
    return (
      <div key={c.id}
        className={`tl__clip ${sel ? 'tl__clip--sel' : ''} ${c.muted ? 'tl__clip--muted' : ''}`}
        style={{ left: start * pxPerSec, width: w, top: row * AUDIO_ROW_H + 3, height: AUDIO_ROW_H - 6 }}
        title={`${c.name || c.asset} @ ${start.toFixed(2)}s · ${dur.toFixed(2)}s · vol ${Math.round((c.gain ?? 1) * 100)}%${c.muted ? ' · muted' : ''}`}
        onPointerDown={e => startAudioDrag(e, c, 'move')}
        onClick={e => { e.stopPropagation(); setMenu(null); }}
        onContextMenu={e => {
          e.preventDefault(); e.stopPropagation();
          selectAudio(c.id);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const time = start + (e.clientX - rect.left) / pxPerSec;
          setMenu({ kind: 'clip', x: e.clientX, y: e.clientY, id: c.id, time });
        }}>
        {project && c.asset && (
          <Waveform projectId={project.id} asset={c.asset} offset={off} duration={dur} width={w} height={AUDIO_ROW_H - 6} />
        )}
        {w > 50 && <span className="tl__clip-name">{c.muted ? '🔇 ' : ''}{c.name || c.asset}</span>}
        <span className="tl__clip-handle tl__clip-handle--l" title="Trim start" onPointerDown={e => startAudioDrag(e, c, 'trim-l')} />
        <span className="tl__clip-handle tl__clip-handle--r" title="Trim end" onPointerDown={e => startAudioDrag(e, c, 'trim-r')} />
      </div>
    );
  };

  if (!scene) return <div className="tl"><p className="panel-hint">No scene.</p></div>;

  const { row: clipRow, count: clipRows } = packLanes(audioClips);
  const audioLaneH = clipRows * AUDIO_ROW_H;

  return (
    <div className="tl" onClick={() => clearKf()}>
      <div className="tl__bar" onClick={e => e.stopPropagation()}>
        <span className="panel-title" style={{ margin: 0 }}>Timeline</span>
        <button className="btn btn--ghost tl__transport" title="Back to start" onClick={onStop}>⏮</button>
        <button className="btn btn--ghost tl__transport" title={playing ? 'Pause' : 'Play (animates the canvas and plays the audio track)'} onClick={onPlayPause}>
          {playing ? '⏸' : '▶'}
        </button>
        <PlayheadTime />
        <span className="tl__range-ctl" title="Render range — Shift+drag on the ruler, or I / O to set its start / end at the playhead. Export → “Only the selected range” renders just this part.">
          <button className="btn btn--ghost tl__zoom" onClick={setIn} title="Range start at the playhead (I)">⇤</button>
          {rangeHere
            ? <span className="tl__range-label">{rangeHere.start.toFixed(2)}–{rangeHere.end.toFixed(2)}s</span>
            : <span className="tl__range-label tl__range-label--empty">range</span>}
          <button className="btn btn--ghost tl__zoom" onClick={setOut} title="Range end at the playhead (O)">⇥</button>
          {rangeHere && <button className="btn btn--ghost tl__zoom" onClick={() => setRange(null)} title="Clear the range">✕</button>}
        </span>
        <button className={`btn tl__snap ${snapEnabled ? 'is-on' : 'btn--ghost'}`}
          title={snapEnabled ? 'Snapping on — drags snap to neighbouring edges, t=0 and the playhead (hold Alt to bypass)' : 'Snapping off'}
          onClick={toggleSnap}>🧲</button>
        <button className="btn btn--ghost tl__zoom" title="Zoom out" onClick={() => setPxPerSec(pxPerSec / 1.25)}>−</button>
        <button className="btn btn--ghost tl__zoom" title="Zoom in" onClick={() => setPxPerSec(pxPerSec * 1.25)}>+</button>
        <button className="btn" disabled={selectedKfIds.length < 2} onClick={() => groupKeyframes(selectedKfIds)}>Group ∥</button>
        <button className="btn" disabled={!selectedHaveGroup} onClick={() => ungroupKeyframes(selectedKfIds)}>Ungroup</button>
        {isSlideshow && (
          <button className="btn tl__break-add"
            title="Add a break at the playhead — the slide pauses there and waits for a click before carrying on"
            onClick={() => addBreak(useTimelineStore.getState().playhead)}>
            ⏸ Break
          </button>
        )}
        <span className="tl__hint">
          double-click a lane to add · drag to move · drag right edge to resize · click the ruler to seek
          {isSlideshow ? ' · double-click the ruler for a break' : ''}
        </span>
      </div>

      <div className="tl__scroll">
        {/* One flex row per lane (label + lane), NOT a 2-column grid: the label
            column pins with position:sticky, which a grid item can't do (see
            .tl__label in App.css). --tl-label-w keeps the CSS in step with LABEL_W. */}
        <div className="tl__grid" ref={gridRef}
          style={{ width: LABEL_W + contentW, ['--tl-label-w' as string]: `${LABEL_W}px` } as React.CSSProperties}
          onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div className="tl__row tl__row--head">
            <div className="tl__corner" style={{ height: 22 }} />
            <div className="tl__ruler" style={{ height: 22 }}
              onPointerDown={e => {
                if (e.button !== 0) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                // Shift+drag marks a render range instead of scrubbing.
                if (e.shiftKey && selectedSceneId) {
                  window.getSelection()?.removeAllRanges(); // Shift+press would extend a text selection
                  const t = laneTime(e);
                  rangeDragRef.current = { anchor: t };
                  setRange(null);
                  return;
                }
                scrubRef.current = { wasPlaying: playing };
                if (playing) stopPlayback();
                // Scrubbing previews on the canvas (Record mode already follows the playhead).
                if (!useCanvasStore.getState().record) useCanvasStore.getState().setPreview(true);
                rulerSeek(e);
              }}
              onPointerMoveCapture={e => {
                const rd = rangeDragRef.current;
                if (rd && selectedSceneId) {
                  const t = laneTime(e);
                  setRange({ sceneId: selectedSceneId, start: Math.min(rd.anchor, t), end: Math.max(rd.anchor, t) });
                  return;
                }
                if (scrubRef.current) rulerSeek(e);
              }}
              onPointerUpCapture={() => {
                if (rangeDragRef.current) { rangeDragRef.current = null; return; }
                const s = scrubRef.current;
                scrubRef.current = null;
                if (s?.wasPlaying && project) {
                  void playFrom(project.id, audioClips, useTimelineStore.getState().playhead, contentEnd);
                }
              }}
              onDoubleClick={e => { if (isSlideshow) { e.stopPropagation(); addBreak(laneTime(e)); } }}>
              {rangeHere && (
                <div className="tl__range-band" style={{ left: rangeHere.start * pxPerSec, width: (rangeHere.end - rangeHere.start) * pxPerSec }}
                  title={`Render range ${rangeHere.start.toFixed(2)}–${rangeHere.end.toFixed(2)}s — right-click to clear`}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setRange(null); }} />
              )}
              {Array.from({ length: ticks + 1 }, (_, i) => (
                <div key={i} className="tl__tick" style={{ left: i * pxPerSec }}>
                  <span className="tl__tick-label">{i}s</span>
                </div>
              ))}
              {/* Break flags live in the (sticky) ruler so they stay grabbable while
                  the lanes scroll; the line itself is drawn across the grid below. */}
              {breaks.map(b => {
                const t = bDrag?.id === b.id ? bDrag.curTime : withRipple(b.time);
                return (
                  <span key={b.id}
                    className={`tl__break-flag ${selectedBreakId === b.id ? 'is-sel' : ''}`}
                    style={{ left: t * pxPerSec }}
                    title={`Break @ ${t.toFixed(2)}s — the slide pauses here until the next click (drag to re-time this segment: everything after the break moves with it; right-click to delete)`}
                    onPointerDown={e => startBreakDrag(e, b)}
                    onClick={e => e.stopPropagation()}
                    onDoubleClick={e => e.stopPropagation()}
                    onContextMenu={e => {
                      e.preventDefault(); e.stopPropagation();
                      selectBreak(b.id);
                      setMenu({ kind: 'break', x: e.clientX, y: e.clientY, id: b.id });
                    }}>
                    ⏸
                  </span>
                );
              })}
            </div>
          </div>

          {/* Dedicated camera track (pan / zoom / focus keyframes). */}
          <div className="tl__row">
            <div className="tl__label tl__label--camera" style={{ height: ROW_H, paddingLeft: 8 }}
              title="Camera track — double-click to add a camera move">
              📷 Camera
            </div>
            <div className="tl__lane tl__lane--camera" style={{ height: ROW_H }}
              onDoubleClick={e => { e.stopPropagation(); addCameraKfAt(e); }}>
              {cameraKfs.map(kf => renderKfBlock(kf))}
            </div>
          </div>

          {/* Audio track (voiceover clips). */}
          <div className="tl__row">
            <div className="tl__label tl__label--audio" style={{ height: audioLaneH, paddingLeft: 8 }}
              title="Audio track — upload a voiceover, then drag/trim/split clips">
              🔊 Audio
              <button className="btn btn--ghost tl__audio-add" disabled={uploading}
                title="Upload an audio file (mp3, wav, ogg, m4a, aac, flac)"
                onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>
                {uploading ? '…' : '＋'}
              </button>
              <input ref={fileRef} type="file" accept=".mp3,.wav,.ogg,.m4a,.aac,.flac,audio/*"
                style={{ display: 'none' }} onChange={onAudioFile} />
            </div>
            <div className="tl__lane tl__lane--audio" style={{ height: audioLaneH }}
              onDoubleClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
              onContextMenu={e => {
                e.preventDefault(); e.stopPropagation();
                setMenu({ kind: 'lane', x: e.clientX, y: e.clientY, time: laneTime(e) });
              }}>
              {audioClips.map(c => renderClipBlock(c, clipRow.get(c.id) ?? 0))}
            </div>
          </div>

          {objects.map((o, i) => {
            const rowKfs = keyframes.filter(k => k.object_id === o.id);
            // Simultaneous animations get their own sub-row; the lane grows to fit.
            const { row, count } = packLanes(rowKfs);
            const laneH = count * ROW_H;
            // Drop indicator while another label is being dragged over this one.
            const dropping = oDrag?.moved ? oDrag : null;
            const cls = [
              'tl__label', 'tl__label--obj',
              selectedObjIds.includes(o.id) ? 'tl__label--sel' : '',
              oDrag?.id === o.id && oDrag.moved ? 'is-dragging' : '',
              dropping?.insertAt === i ? 'is-drop-before' : '',
              dropping?.insertAt === objects.length && i === objects.length - 1 ? 'is-drop-after' : '',
            ].filter(Boolean).join(' ');
            return (
              <div className="tl__row" key={o.id}>
                <div className={cls} data-obj-row=""
                  style={{ height: laneH, paddingLeft: o.parent_id ? 22 : 8 }}
                  title={`${o.name || o.type} — drag up or down to reorder the lanes`}
                  onPointerDown={e => startObjDrag(e, o, i)}
                  onClick={e => e.stopPropagation()}>
                  <span className="tl__label-grip">⠿</span>
                  <span className="tl__label-name">{o.name || o.type}</span>
                </div>
                <div className="tl__lane" style={{ height: laneH }}
                  onDoubleClick={e => { e.stopPropagation(); addKfAt(o, e); }}>
                  {rowKfs.map(kf => renderKfBlock(kf, row.get(kf.id) ?? 0))}
                </div>
              </div>
            );
          })}

          {/* Break lines: full-height verticals like the playhead, but amber and
              static — where playback stops and waits for a click. */}
          {breaks.map(b => {
            const t = bDrag?.id === b.id ? bDrag.curTime : withRipple(b.time);
            return (
              <div key={b.id}
                className={`tl__break ${selectedBreakId === b.id ? 'tl__break--sel' : ''}`}
                style={{ left: LABEL_W + t * pxPerSec }} />
            );
          })}

          {rangeHere && (
            // Full-height tint behind the lanes (grid-level, so offset by LABEL_W by hand).
            <div className="tl__range" style={{ left: LABEL_W + rangeHere.start * pxPerSec, width: (rangeHere.end - rangeHere.start) * pxPerSec }} />
          )}
          <PlayheadLine pxPerSec={pxPerSec} />
        </div>
      </div>

      {menu?.kind === 'kf' && (() => {
        const kf = keyframes.find(k => k.id === menu.id);
        if (!kf) return null;
        return (
          <div className="tl__menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
            {kf.object_id !== CAMERA_ID && (
              <>
                <div className="tl__menu-head">Change verb</div>
                <div className="tl__menu-verbs">
                  {timelineVerbsFor(scene?.objects.find(o => o.id === kf.object_id)).map(v => (
                    <button key={v} className={`tl__menu-verb ${kf.verb === v ? 'is-active' : ''}`}
                      onClick={() => { updateKeyframe(kf.id, { verb: v, params: defaultParams(v) }); setMenu(null); }}>{VERB_META[v].label}</button>
                  ))}
                </div>
                <div className="tl__menu-sep" />
              </>
            )}
            <button className="tl__menu-item" onClick={() => { duplicateKf(kf); setMenu(null); }}>Duplicate</button>
            <button className="tl__menu-item"
              title="Then select one or more objects and press Ctrl+V to give them the same animation"
              onClick={() => {
                const sel = useTimelineStore.getState().selectedKfIds;
                useProjectStore.getState().copyKeyframes(sel.includes(kf.id) ? sel : [kf.id]);
                setMenu(null);
              }}>Copy animation</button>
            <button className="tl__menu-item tl__menu-item--danger" onClick={() => { removeKeyframe(kf.id); setMenu(null); }}>Delete</button>
          </div>
        );
      })()}

      {menu?.kind === 'clip' && (() => {
        const clip = audioClips.find(c => c.id === menu.id);
        if (!clip) return null;
        const canSplit = menu.time > clip.start_time + 0.05 && menu.time < clip.start_time + clip.duration - 0.05;
        return (
          <div className="tl__menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
            <button className="tl__menu-item" disabled={!canSplit}
              onClick={() => { splitAudioClip(clip.id, Math.round(menu.time * 1000) / 1000); setMenu(null); }}>
              ✂ Split here ({menu.time.toFixed(2)}s)
            </button>
            <button className="tl__menu-item" onClick={() => { updateAudioClip(clip.id, { muted: !clip.muted }); setMenu(null); }}>
              {clip.muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="tl__menu-item" onClick={() => { copyAudioClip(clip.id); setMenu(null); }}>Copy (Ctrl+C)</button>
            <button className="tl__menu-item" onClick={() => { duplicateAudioClip(clip.id); setMenu(null); }}>Duplicate</button>
            <button className="tl__menu-item tl__menu-item--danger" onClick={() => { removeAudioClip(clip.id); setMenu(null); }}>Delete</button>
          </div>
        );
      })()}

      {menu?.kind === 'break' && (() => {
        const b = breaks.find(x => x.id === menu.id);
        if (!b) return null;
        return (
          <div className="tl__menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
            <div className="tl__menu-head">Break @ {b.time.toFixed(2)}s</div>
            <button className="tl__menu-item"
              onClick={() => { moveBreak(b.id, useTimelineStore.getState().playhead); setMenu(null); }}>
              Move to playhead
            </button>
            <button className="tl__menu-item tl__menu-item--danger"
              onClick={() => { removeBreak(b.id); setMenu(null); }}>Delete</button>
          </div>
        );
      })()}

      {menu?.kind === 'lane' && (
        <div className="tl__menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <button className="tl__menu-item" disabled={!audioClipboard || audioClipboard.projectId !== project?.id}
            onClick={() => { pasteAudioClip(menu.time); setMenu(null); }}>
            Paste clip here ({menu.time.toFixed(2)}s)
          </button>
          <button className="tl__menu-item" onClick={() => { fileRef.current?.click(); setMenu(null); }}>Upload audio…</button>
        </div>
      )}
    </div>
  );
}
