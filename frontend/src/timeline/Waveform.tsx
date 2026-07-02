import { useEffect, useRef, useState } from 'react';
import { loadBuffer, peaksFor, PEAK_BLOCK } from './audioPlayback';

// Draws the [offset, offset+duration] window of an audio asset as a peak
// waveform. Cheap to redraw during trims/zooms: it aggregates the buffer's
// cached per-block peaks, never raw samples.
export function Waveform({ projectId, asset, offset, duration, width, height }: {
  projectId: string;
  asset: string;
  offset: number;
  duration: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);

  useEffect(() => {
    let alive = true;
    loadBuffer(projectId, asset)
      .then(b => { if (alive) setBuf(b); })
      .catch(() => { /* no waveform; the clip block still works */ });
    return () => { alive = false; };
  }, [projectId, asset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buf || duration <= 0) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.55)';

    const peaks = peaksFor(buf);
    const blocksPerSec = buf.sampleRate / PEAK_BLOCK;
    for (let x = 0; x < w; x++) {
      const t0 = offset + (x / w) * duration;
      const t1 = offset + ((x + 1) / w) * duration;
      const b0 = Math.max(0, Math.floor(t0 * blocksPerSec));
      const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.ceil(t1 * blocksPerSec)));
      let m = 0;
      for (let b = b0; b < b1; b++) if (peaks[b] > m) m = peaks[b];
      const bh = Math.max(1, m * (h - 2));
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [buf, offset, duration, width, height]);

  return <canvas ref={canvasRef} className="tl__clip-wave" style={{ width, height }} />;
}
