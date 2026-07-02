// Web Audio playback engine for the timeline's audio track (editor preview
// only — the render mixes audio with ffmpeg on the backend, which is the
// source of truth). Decoded buffers are cached per asset URL and shared with
// the waveform renderer.
import type { AudioClip } from '../types/ir';
import { audioAssetUrl } from '../api/client';
import { useTimelineStore } from './timelineStore';

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

// ---------------------------------------------------------------------------
// Buffer cache (shared by playback + waveforms)
// ---------------------------------------------------------------------------

const buffers = new Map<string, Promise<AudioBuffer>>();

export function loadBuffer(projectId: string, asset: string): Promise<AudioBuffer> {
  const url = audioAssetUrl(projectId, asset);
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`fetch ${asset}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(ab => audioCtx().decodeAudioData(ab));
    buffers.set(url, p);
    p.catch(() => buffers.delete(url)); // allow a retry after a failed fetch
  }
  return p;
}

// Max-abs peak per 512-sample block (channel 0), computed once per buffer.
// Waveform drawing aggregates these per pixel column instead of raw samples.
const blockPeaks = new WeakMap<AudioBuffer, Float32Array>();
export const PEAK_BLOCK = 512;

export function peaksFor(buf: AudioBuffer): Float32Array {
  let peaks = blockPeaks.get(buf);
  if (!peaks) {
    const data = buf.getChannelData(0);
    const n = Math.ceil(data.length / PEAK_BLOCK);
    peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(data.length, (i + 1) * PEAK_BLOCK);
      for (let j = i * PEAK_BLOCK; j < end; j++) {
        const a = Math.abs(data[j]);
        if (a > m) m = a;
      }
      peaks[i] = m;
    }
    blockPeaks.set(buf, peaks);
  }
  return peaks;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let active: AudioBufferSourceNode[] = [];
let raf = 0;

export function stopPlayback(): void {
  for (const src of active) {
    try { src.stop(); } catch { /* already stopped */ }
  }
  active = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  useTimelineStore.getState().setPlaying(false);
}

// Linear fade envelope, mirroring the backend's ffmpeg afade curves.
function scheduleGain(param: AudioParam, c: AudioClip, elapsed: number, when: number, playDur: number): void {
  const g = Math.max(0, c.gain ?? 1);
  const fi = Math.min(Math.max(0, c.fade_in ?? 0), c.duration);
  const fo = Math.min(Math.max(0, c.fade_out ?? 0), c.duration);
  const outStart = c.duration - fo; // clip-local time where the fade-out begins

  let v0 = g;
  if (fi > 0 && elapsed < fi) v0 = Math.min(v0, g * (elapsed / fi));
  if (fo > 0 && elapsed > outStart) v0 = Math.min(v0, g * ((c.duration - elapsed) / fo));
  param.setValueAtTime(Math.max(0, v0), when);

  if (fi > elapsed) param.linearRampToValueAtTime(g, when + (fi - elapsed));
  if (fo > 0) {
    if (outStart > elapsed) param.setValueAtTime(g, when + (outStart - elapsed));
    param.linearRampToValueAtTime(0, when + playDur);
  }
}

// Play the scene's audio from `from` seconds; the rAF loop drives the store's
// playhead until `endTime`, then stops.
export async function playFrom(projectId: string, clips: AudioClip[], from: number, endTime: number): Promise<void> {
  stopPlayback();
  const ac = audioCtx();
  if (ac.state === 'suspended') await ac.resume();

  const audible = clips.filter(c => !c.muted && c.duration > 0.01 && c.asset);
  const bufs = await Promise.all(
    audible.map(c => loadBuffer(projectId, c.asset).catch(() => null)),
  );

  const t0 = ac.currentTime + 0.05; // small scheduling headroom
  audible.forEach((c, i) => {
    const buf = bufs[i];
    if (!buf) return;
    if (c.start_time + c.duration <= from) return; // already fully behind the playhead
    const elapsed = Math.max(0, from - c.start_time); // clip-local time already passed
    const srcOffset = c.offset + elapsed;
    const playDur = c.duration - elapsed;
    if (playDur <= 0 || srcOffset >= buf.duration) return;

    const src = ac.createBufferSource();
    src.buffer = buf;
    const gain = ac.createGain();
    scheduleGain(gain.gain, c, elapsed, t0 + Math.max(0, c.start_time - from), playDur);
    src.connect(gain).connect(ac.destination);
    src.start(t0 + Math.max(0, c.start_time - from), srcOffset, playDur);
    active.push(src);
  });

  useTimelineStore.getState().setPlaying(true);
  const tick = () => {
    const t = from + Math.max(0, ac.currentTime - t0);
    const store = useTimelineStore.getState();
    if (t >= endTime) {
      store.setPlayhead(endTime);
      stopPlayback();
      return;
    }
    store.setPlayhead(t);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
