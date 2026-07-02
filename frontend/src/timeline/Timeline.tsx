import { Fragment, useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { newId } from '../store/objectFactory';
import { useTimelineStore, VERB_META, TIMELINE_VERBS, defaultParams, CAMERA_ID } from './timelineStore';
import { uploadAudioAsset } from '../api/client';
import { playFrom, stopPlayback } from './audioPlayback';
import { Waveform } from './Waveform';
import type { AnimationVerb, AudioClip, Keyframe, SceneObject } from '../types/ir';

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

function edgeTargets(items: { id: string; start_time: number; duration: number }[], excludeId: string): number[] {
  const t = [0, useTimelineStore.getState().playhead];
  for (const it of items) {
    if (it.id === excludeId) continue;
    t.push(it.start_time, it.start_time + it.duration);
  }
  return t;
}

function defaultVerb(o: SceneObject): AnimationVerb {
  if (o.type === 'latex_text' || o.type === 'matrix') return 'write';
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
  kfId: string;
  mode: 'move' | 'resize';
  startClientX: number;
  origStart: number;
  origDur: number;
  curStart: number;
  curDur: number;
  targets: number[]; // same-lane edges (+ 0 and playhead), captured at drag start
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

type MenuState =
  | { kind: 'kf'; x: number; y: number; id: string }
  | { kind: 'clip'; x: number; y: number; id: string; time: number } // time = where the right-click landed
  | { kind: 'lane'; x: number; y: number; time: number }; // empty audio-lane menu (paste target)

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
  const addKeyframe = useProjectStore(s => s.addKeyframe);
  const updateKeyframe = useProjectStore(s => s.updateKeyframe);
  const removeKeyframe = useProjectStore(s => s.removeKeyframe);
  const groupKeyframes = useProjectStore(s => s.groupKeyframes);
  const ungroupKeyframes = useProjectStore(s => s.ungroupKeyframes);
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
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrubRef = useRef<{ wasPlaying: boolean } | null>(null);

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

  const scene = project?.scenes.find(s => s.id === selectedSceneId);
  const objects = scene?.objects ?? [];
  const keyframes = scene?.timeline.keyframes ?? [];
  const audioClips = scene?.audio ?? [];

  const contentEnd = Math.max(
    1,
    ...keyframes.map(k => k.start_time + k.duration),
    ...audioClips.map(c => c.start_time + c.duration),
  );
  const totalDur = Math.max(4, contentEnd) + 2;
  const contentW = totalDur * pxPerSec;
  const ticks = Math.ceil(totalDur);

  // ---- transport ----------------------------------------------------------
  const onPlayPause = () => {
    if (playing) { stopPlayback(); return; }
    if (!project) return;
    const t = useTimelineStore.getState().playhead;
    const from = t >= contentEnd - 0.01 ? 0 : t; // at the end -> replay from the top
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
    if (drag) {
      const dx = (e.clientX - drag.startClientX) / pxPerSec;
      if (drag.mode === 'move') {
        let start = Math.max(0, drag.origStart + dx);
        if (snapOn) start = Math.max(0, snapMove(start, drag.origDur, drag.targets, pxPerSec));
        setDrag({ ...drag, curStart: start });
      } else {
        let dur = drag.origDur + dx;
        if (snapOn) {
          const end = snapTo(drag.origStart + dur, drag.targets, pxPerSec);
          if (end !== null) dur = end - drag.origStart;
        }
        setDrag({ ...drag, curDur: Math.max(0.1, dur) });
      }
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
    if (drag) {
      if (drag.mode === 'move' && drag.curStart !== drag.origStart) {
        updateKeyframe(drag.kfId, { start_time: Math.round(drag.curStart * 100) / 100 });
      } else if (drag.mode === 'resize' && drag.curDur !== drag.origDur) {
        updateKeyframe(drag.kfId, { duration: Math.round(drag.curDur * 100) / 100 });
      }
      setDrag(null);
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
    // a shift-click and cancel it out.
    selectKf(kf.id, e.shiftKey);
    setDrag({
      kfId: kf.id, mode, startClientX: e.clientX, origStart: kf.start_time, origDur: kf.duration,
      curStart: kf.start_time, curDur: kf.duration,
      // Snap against the other keyframes in this lane (same object / camera).
      targets: edgeTargets(keyframes.filter(k => k.object_id === kf.object_id), kf.id),
    });
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

  // One keyframe block, shared by the camera lane and every object lane. `row`
  // is its sub-row within the lane (0 = main row), used to stack simultaneous
  // animations vertically.
  const renderKfBlock = (kf: Keyframe, row = 0) => {
    const isDragging = drag?.kfId === kf.id;
    const start = isDragging ? drag!.curStart : kf.start_time;
    const dur = isDragging && drag!.mode === 'resize' ? drag!.curDur : kf.duration;
    const meta = VERB_META[kf.verb];
    const sel = selectedKfIds.includes(kf.id);
    const w = Math.max(18, dur * pxPerSec);
    return (
      <div key={kf.id}
        className={`tl__kf ${sel ? 'tl__kf--sel' : ''} ${kf.group_id ? 'tl__kf--grouped' : ''}`}
        style={{ left: start * pxPerSec, width: w, top: row * ROW_H + 4, height: ROW_H - 8, background: meta.color }}
        title={`${meta.label} @ ${start.toFixed(2)}s · ${dur.toFixed(2)}s${kf.group_id ? ' · parallel' : ''}`}
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
    const start = isDragging ? aDrag!.cur.start : c.start_time;
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
        <button className="btn btn--ghost tl__transport" title={playing ? 'Pause' : 'Play audio'} onClick={onPlayPause}>
          {playing ? '⏸' : '▶'}
        </button>
        <PlayheadTime />
        <button className={`btn tl__snap ${snapEnabled ? 'is-on' : 'btn--ghost'}`}
          title={snapEnabled ? 'Snapping on — drags snap to neighbouring edges, t=0 and the playhead (hold Alt to bypass)' : 'Snapping off'}
          onClick={toggleSnap}>🧲</button>
        <button className="btn btn--ghost tl__zoom" title="Zoom out" onClick={() => setPxPerSec(pxPerSec / 1.25)}>−</button>
        <button className="btn btn--ghost tl__zoom" title="Zoom in" onClick={() => setPxPerSec(pxPerSec * 1.25)}>+</button>
        <button className="btn" disabled={selectedKfIds.length < 2} onClick={() => groupKeyframes(selectedKfIds)}>Group ∥</button>
        <button className="btn" disabled={!selectedHaveGroup} onClick={() => ungroupKeyframes(selectedKfIds)}>Ungroup</button>
        <span className="tl__hint">double-click a lane to add · drag to move · drag right edge to resize · click the ruler to seek</span>
      </div>

      <div className="tl__scroll">
        <div className="tl__grid" style={{ gridTemplateColumns: `${LABEL_W}px ${contentW}px` }}
          onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div className="tl__corner" style={{ height: 22 }} />
          <div className="tl__ruler" style={{ width: contentW, height: 22 }}
            onPointerDown={e => {
              if (e.button !== 0) return;
              (e.target as Element).setPointerCapture?.(e.pointerId);
              scrubRef.current = { wasPlaying: playing };
              if (playing) stopPlayback();
              rulerSeek(e);
            }}
            onPointerMoveCapture={e => { if (scrubRef.current) rulerSeek(e); }}
            onPointerUpCapture={() => {
              const s = scrubRef.current;
              scrubRef.current = null;
              if (s?.wasPlaying && project) {
                void playFrom(project.id, audioClips, useTimelineStore.getState().playhead, contentEnd);
              }
            }}>
            {Array.from({ length: ticks + 1 }, (_, i) => (
              <div key={i} className="tl__tick" style={{ left: i * pxPerSec }}>
                <span className="tl__tick-label">{i}s</span>
              </div>
            ))}
          </div>

          {/* Dedicated camera track (pan / zoom / focus keyframes). */}
          <div className="tl__label tl__label--camera" style={{ height: ROW_H, paddingLeft: 8 }}
            title="Camera track — double-click to add a camera move">
            📷 Camera
          </div>
          <div className="tl__lane tl__lane--camera" style={{ height: ROW_H }}
            onDoubleClick={e => { e.stopPropagation(); addCameraKfAt(e); }}>
            {cameraKfs.map(kf => renderKfBlock(kf))}
          </div>

          {/* Audio track (voiceover clips). */}
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

          {objects.map(o => {
            const rowKfs = keyframes.filter(k => k.object_id === o.id);
            // Simultaneous animations get their own sub-row; the lane grows to fit.
            const { row, count } = packLanes(rowKfs);
            const laneH = count * ROW_H;
            return (
              <Fragment key={o.id}>
                <div className={`tl__label ${selectedObjIds.includes(o.id) ? 'tl__label--sel' : ''}`}
                  style={{ height: laneH, paddingLeft: o.parent_id ? 22 : 8 }}
                  onClick={e => { e.stopPropagation(); selectObject(o.id); }}>
                  {o.name || o.type}
                </div>
                <div className="tl__lane" style={{ height: laneH }}
                  onDoubleClick={e => { e.stopPropagation(); addKfAt(o, e); }}>
                  {rowKfs.map(kf => renderKfBlock(kf, row.get(kf.id) ?? 0))}
                </div>
              </Fragment>
            );
          })}

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
                  {TIMELINE_VERBS.map(v => (
                    <button key={v} className={`tl__menu-verb ${kf.verb === v ? 'is-active' : ''}`}
                      onClick={() => { updateKeyframe(kf.id, { verb: v, params: defaultParams(v) }); setMenu(null); }}>{VERB_META[v].label}</button>
                  ))}
                </div>
                <div className="tl__menu-sep" />
              </>
            )}
            <button className="tl__menu-item" onClick={() => { duplicateKf(kf); setMenu(null); }}>Duplicate</button>
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
