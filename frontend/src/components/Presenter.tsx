import { useCallback, useEffect, useRef, useState } from 'react';
import { getSlideManifest } from '../api/client';
import type { SlideManifest } from '../types/ir';

/**
 * Fullscreen presentation of a finished `slideshow` render, streamed slide by
 * slide from the job's player folder on the backend.
 *
 * Mirrors the exported HTML player (`backend/app/render/slideshow.py`) — same
 * keys, same freeze-on-last-frame behaviour — so rehearsing here matches what
 * the downloaded deck does. Keep the two in step when changing either.
 */
export function Presenter({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<SlideManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [started, setStarted] = useState(false);
  const [frozen, setFrozen] = useState(false); // paused on a last frame, waiting for the click

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  // Key/click handlers are registered once, so they read the index from a ref.
  const currentRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getSlideManifest(jobId)
      .then(m => { if (!cancelled) setManifest(m); })
      .catch(() => { if (!cancelled) setError('Could not load the rendered slides.'); });
    return () => { cancelled = true; };
  }, [jobId]);

  const show = useCallback((i: number, mode: 'play' | 'end') => {
    const vids = videoRefs.current;
    if (i < 0 || i >= vids.length) return;
    const prev = vids[currentRef.current];
    if (prev && prev !== vids[i]) prev.pause();
    currentRef.current = i;
    setCurrent(i);

    const v = vids[i];
    if (!v) return;
    if (mode === 'end') {
      // Stepping back restores where that slide was left: frozen on its last
      // frame. Seeking needs metadata, so wait for it when it isn't loaded yet.
      const seek = () => { v.currentTime = Math.max(0, (v.duration || 0) - 0.05); };
      if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
      v.pause();
      setFrozen(true);
    } else {
      v.currentTime = 0;
      setFrozen(false);
      v.play().catch(() => setFrozen(true)); // autoplay blocked → wait for a click
    }
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStarted(true);
    show(0, 'play');
  }, [show]);

  const next = useCallback(() => {
    const v = videoRefs.current[currentRef.current];
    // Clicking part-way through a slide skips to its end first — the same
    // frozen state the slide would have reached on its own.
    if (v && !v.ended && !v.paused) {
      v.pause();
      v.currentTime = Math.max(0, (v.duration || 0) - 0.05);
      setFrozen(true);
      return;
    }
    if (currentRef.current < videoRefs.current.length - 1) show(currentRef.current + 1, 'play');
  }, [show]);

  const back = useCallback(() => {
    if (currentRef.current > 0) show(currentRef.current - 1, 'end');
  }, [show]);

  const onEnded = (i: number) => {
    if (i !== currentRef.current) return;
    const slide = manifest?.slides[i];
    if (slide?.auto_advance && i < (manifest?.slides.length ?? 0) - 1) next();
    else setFrozen(true);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootRef.current?.requestFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Leaving fullscreen is the browser's own Esc job; only close on the second press.
        if (!document.fullscreenElement) onClose();
        return;
      }
      if ([' ', 'Enter', 'ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        if (startedRef.current) next(); else start();
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) {
        e.preventDefault();
        back();
      } else if (e.key === 'r' || e.key === 'R') {
        show(currentRef.current, 'play');
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, start, show, onClose]);

  const slides = manifest?.slides ?? [];

  return (
    <div className="presenter" ref={rootRef} onClick={() => { if (started) next(); else start(); }}>
      {error && (
        <div className="presenter__curtain">
          <p className="presenter__error">{error}</p>
          <button className="btn" onClick={e => { e.stopPropagation(); onClose(); }}>Close</button>
        </div>
      )}

      {slides.map((s, i) => (
        <video
          key={s.index}
          ref={el => { videoRefs.current[i] = el; }}
          src={s.url}
          className={`presenter__video ${i === current ? 'is-current' : ''}`}
          preload={i <= current + 1 ? 'auto' : 'none'}
          playsInline
          onEnded={() => onEnded(i)}
        />
      ))}

      {!started && !error && (
        <div className="presenter__curtain">
          <h2>{manifest?.title ?? 'Slideshow'}</h2>
          <p className="presenter__dim">
            {slides.length} slide{slides.length !== 1 ? 's' : ''}
          </p>
          <button
            className="btn btn--primary"
            disabled={!manifest}
            onClick={e => { e.stopPropagation(); start(); }}
          >
            {manifest ? 'Start presentation' : 'Loading slides…'}
          </button>
          <p className="presenter__dim presenter__keys">
            <kbd>Space</kbd>/<kbd>→</kbd> next · <kbd>←</kbd> back · <kbd>R</kbd> replay ·
            <kbd>F</kbd> fullscreen · <kbd>Esc</kbd> exit
          </p>
        </div>
      )}

      {started && frozen && <div className="presenter__hint">Click or press Space for the next slide</div>}

      {started && (
        <div className="presenter__hud" onClick={e => e.stopPropagation()}>
          <span className="presenter__slide-name">{slides[current]?.name}</span>
          <span className="presenter__counter">{current + 1} / {slides.length}</span>
          <span className="presenter__dots">
            {slides.map((s, i) => (
              <span
                key={s.index}
                className={`presenter__dot ${i === current ? 'is-current' : i < current ? 'is-seen' : ''}`}
                title={s.name}
                onClick={() => show(i, 'play')}
              />
            ))}
          </span>
          <button className="btn btn--ghost" onClick={back} disabled={current === 0}>‹</button>
          <button className="btn btn--ghost" onClick={next} disabled={current === slides.length - 1 && frozen}>›</button>
          <button className="btn btn--ghost" onClick={toggleFullscreen} title="Fullscreen (F)">⛶</button>
          <button className="btn btn--ghost" onClick={onClose} title="Exit (Esc)">✕</button>
        </div>
      )}
    </div>
  );
}
