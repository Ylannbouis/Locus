"""Slideshow packaging — turn per-scene mp4s into a click-through presentation.

A slideshow project (`Project.kind == "slideshow"`) is never stitched. Each
scene is rendered to its own mp4 and packaged here into a self-contained folder:

    slideshow/
        index.html      the player (no external assets — opens from file://)
        manifest.json   slide list, also inlined into index.html
        slides/slide_01.mp4 …

The player plays one slide, freezes on its last frame (an HTML5 <video> paused
at the end just keeps showing it), and advances on click / Space / →. That
freeze is why no ffmpeg work is needed here: the "hold" between slides is the
player pausing, not padded video.

A scene's `breaks` work the same way *inside* a slide: the mp4 is one continuous
render, and the player pauses it at each break timestamp until the next click.
So breaks cost no render time and stepping backwards through them is just a seek.

The manifest is *inlined* into index.html because a page opened from file://
cannot fetch() a sibling JSON file, while a relative <video src> works fine.
"""
from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

from app.models.ir import Scene
from app.render.stitch import probe_duration

SLIDES_SUBDIR = "slides"
MANIFEST_NAME = "manifest.json"


def slide_filename(index: int) -> str:
    """1-based, zero-padded so the files sort in presentation order."""
    return f"slide_{index:02d}.mp4"


def build_slideshow(videos: list[Path], scenes: list[Scene], out_dir: Path, title: str) -> dict:
    """Assemble the player folder. Returns the manifest dict.

    `videos[i]` is the rendered mp4 for `scenes[i]` (already audio-muxed by the
    worker, so slide narration just plays with the video).
    """
    slides_dir = out_dir / SLIDES_SUBDIR
    slides_dir.mkdir(parents=True, exist_ok=True)

    slides: list[dict] = []
    for i, (video, scene) in enumerate(zip(videos, scenes)):
        name = slide_filename(i + 1)
        shutil.copyfile(video, slides_dir / name)
        duration = probe_duration(slides_dir / name)
        slides.append({
            "index": i,
            "name": scene.name or f"Slide {i + 1}",
            "file": f"{SLIDES_SUBDIR}/{name}",
            "duration": duration,
            "auto_advance": bool(scene.auto_advance),
            "breaks": _slide_breaks(scene, duration),
        })

    manifest = {"title": title, "slides": slides}
    (out_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(_render_player(manifest), encoding="utf-8")
    return manifest


def _slide_breaks(scene: Scene, duration: float) -> list[float]:
    """The scene's mid-slide pause points, as sorted seconds the player can use.

    Dropped: duplicates, and anything outside the rendered video — a break at (or
    past) the last frame is just the slide's own freeze, and one at t=0 would stop
    the slide before it started.
    """
    times = sorted({round(b.time, 3) for b in (scene.breaks or [])})
    if duration <= 0:
        return times  # unprobeable video: keep them and let the player clamp
    return [t for t in times if 0.05 < t < duration - 0.05]


def zip_slideshow(src_dir: Path, output_zip: Path) -> None:
    """Zip the player folder, keeping index.html at the archive root."""
    with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src_dir.rglob("*")):
            if f.is_file():
                zf.write(f, arcname=f.relative_to(src_dir).as_posix())


def _render_player(manifest: dict) -> str:
    # `</` is escaped so a slide name can never close the <script> element.
    data = json.dumps(manifest).replace("</", "<\\/")
    return _PLAYER_HTML.replace("__MANIFEST__", data).replace(
        "__TITLE__", _html_escape(manifest.get("title") or "Slideshow")
    )


def _html_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


# ---------------------------------------------------------------------------
# The player. Single file, no dependencies, works from file:// and over http.
# ---------------------------------------------------------------------------

_PLAYER_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: #000; overflow: hidden; }
  body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; cursor: pointer; }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  video { position: absolute; width: 100%; height: 100%; object-fit: contain; opacity: 0; }
  video.is-current { opacity: 1; }
  #hud {
    position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 14px;
    padding: 10px 16px; background: linear-gradient(transparent, rgba(0,0,0,.75));
    transition: opacity .35s; opacity: 0; pointer-events: none;
  }
  body.show-hud #hud { opacity: 1; }
  #title { font-weight: 600; }
  #counter { color: #bbb; font-variant-numeric: tabular-nums; }
  #dots { display: flex; gap: 5px; margin-left: auto; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #555; }
  .dot.is-current { background: #fff; }
  .dot.is-seen { background: #999; }
  #hint {
    position: fixed; left: 50%; bottom: 46px; transform: translateX(-50%);
    padding: 7px 14px; border-radius: 999px; background: rgba(20,20,20,.82);
    border: 1px solid rgba(255,255,255,.16); color: #eee; font-size: 13px;
    opacity: 0; transition: opacity .3s; pointer-events: none;
  }
  body.show-hint #hint { opacity: 1; }
  #curtain {
    position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px;
    align-items: center; justify-content: center; background: #000; text-align: center; padding: 24px;
  }
  #curtain.is-hidden { display: none; }
  #curtain h1 { font-size: 26px; font-weight: 600; }
  #curtain p { color: #9a9a9a; }
  #curtain kbd {
    display: inline-block; padding: 1px 6px; margin: 0 2px; border-radius: 4px;
    background: #222; border: 1px solid #3a3a3a; font: inherit; font-size: 12px;
  }
  #start {
    margin-top: 6px; padding: 10px 26px; border-radius: 8px; border: 0;
    background: #fff; color: #000; font: inherit; font-weight: 600; cursor: pointer;
  }
</style>
</head>
<body>
<div id="stage"></div>

<div id="hint"><span id="hint-text">Click or press <b>Space</b> for the next slide</span></div>

<div id="hud">
  <span id="title"></span>
  <span id="counter"></span>
  <span id="dots"></span>
</div>

<div id="curtain">
  <h1 id="deck-title"></h1>
  <p id="deck-meta"></p>
  <button id="start">Start presentation</button>
  <p><kbd>Space</kbd>/<kbd>&rarr;</kbd> next &middot; <kbd>&larr;</kbd> back &middot;
     <kbd>R</kbd> replay slide &middot; <kbd>F</kbd> fullscreen</p>
</div>

<script>
const MANIFEST = __MANIFEST__;
const SLIDES = MANIFEST.slides || [];

const stage = document.getElementById('stage');
const curtain = document.getElementById('curtain');
const hintEl = document.getElementById('hint');
const hintTextEl = document.getElementById('hint-text');
const titleEl = document.getElementById('title');
const counterEl = document.getElementById('counter');
const dotsEl = document.getElementById('dots');

document.getElementById('deck-title').textContent = MANIFEST.title || 'Slideshow';
document.getElementById('deck-meta').textContent =
  SLIDES.length + (SLIDES.length === 1 ? ' slide' : ' slides');

// One <video> per slide, all in the DOM. Only the current + next preload, so a
// long deck doesn't try to buffer everything at once.
const videos = SLIDES.map((s, i) => {
  const v = document.createElement('video');
  v.src = s.file;
  v.preload = i === 0 ? 'auto' : 'none';
  v.playsInline = true;
  v.addEventListener('ended', () => { if (i === current) onSlideEnded(); });
  stage.appendChild(v);
  return v;
});

let current = 0;
let started = false;
let hudTimer = null, hintTimer = null;
// The next break this slide should stop at, and the rAF handle watching for it.
// `timeupdate` only fires ~4x a second, which would overshoot a break visibly.
let breakTarget = null, rafId = 0;

function flashHud() {
  document.body.classList.add('show-hud');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => document.body.classList.remove('show-hud'), 2200);
}
function showHint(on, kind) {
  clearTimeout(hintTimer);
  if (!on) { document.body.classList.remove('show-hint'); return; }
  hintTextEl.innerHTML = kind === 'break'
    ? 'Click or press <b>Space</b> to continue'
    : 'Click or press <b>Space</b> for the next slide';
  // Only nag once the slide has actually been sitting frozen for a moment.
  hintTimer = setTimeout(() => document.body.classList.add('show-hint'), 700);
}

// ---- mid-slide breaks ----------------------------------------------------
function breaksOf(i) { return (SLIDES[i] && SLIDES[i].breaks) || []; }

function nextBreakAfter(i, t) {
  const bs = breaksOf(i);
  for (let k = 0; k < bs.length; k++) if (bs[k] > t + 0.02) return bs[k];
  return null;
}

function stopMonitor() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

// Watch the playing slide and pause it the moment it reaches `breakTarget`.
function monitor() {
  rafId = 0;
  const v = videos[current];
  if (!v || v.paused || v.ended) return;
  if (breakTarget !== null && v.currentTime >= breakTarget) {
    v.pause();
    v.currentTime = breakTarget; // land exactly on it, so stepping back is stable
    showHint(true, 'break');
    return;
  }
  rafId = requestAnimationFrame(monitor);
}

function playFromHere() {
  const v = videos[current];
  if (!v) return;
  breakTarget = nextBreakAfter(current, v.currentTime);
  showHint(false);
  const p = v.play();
  if (p && p.catch) p.catch(() => showHint(true, breakTarget === null ? 'end' : 'break'));
  stopMonitor();
  if (breakTarget !== null) rafId = requestAnimationFrame(monitor);
}

function renderHud() {
  const s = SLIDES[current];
  titleEl.textContent = s ? s.name : '';
  counterEl.textContent = (current + 1) + ' / ' + SLIDES.length;
  dotsEl.innerHTML = '';
  SLIDES.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'dot' + (i === current ? ' is-current' : i < current ? ' is-seen' : '');
    dotsEl.appendChild(d);
  });
  flashHud();
}

function preloadNeighbours() {
  const next = videos[current + 1];
  if (next && next.preload !== 'auto') { next.preload = 'auto'; next.load(); }
}

function show(i, mode) {
  if (i < 0 || i >= videos.length) return;
  const prev = videos[current];
  if (prev && prev !== videos[i]) { prev.pause(); prev.classList.remove('is-current'); }
  stopMonitor();
  breakTarget = null;
  current = i;
  const v = videos[i];
  v.classList.add('is-current');
  showHint(false);
  renderHud();
  preloadNeighbours();

  if (mode === 'end') {
    // Going backwards restores where that slide was left: frozen on its last
    // frame. Seek needs metadata, so wait for it if it isn't loaded yet.
    const seek = () => { try { v.currentTime = Math.max(0, (v.duration || 0) - 0.05); } catch (e) {} };
    if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
    v.pause();
    showHint(true, 'end');
  } else {
    v.currentTime = 0;
    playFromHere(); // picks up this slide's first break, if it has one
  }
}

function onSlideEnded() {
  stopMonitor();
  breakTarget = null;
  const s = SLIDES[current];
  if (s && s.auto_advance && current < videos.length - 1) next();
  else showHint(true, 'end');
}

function next() {
  const v = videos[current];
  if (!v) return;
  const atEnd = v.ended || v.currentTime >= (v.duration || 0) - 0.1;
  // Paused part-way through: we're sitting on a break (or autoplay was blocked).
  // The click resumes the same slide rather than skipping it.
  if (v.paused && !atEnd) { playFromHere(); return; }
  // Playing: a click jumps to the next stop — the coming break if there is one,
  // otherwise the slide's last frame (the presenter reflex of skipping ahead).
  if (!v.paused) {
    stopMonitor();
    const target = breakTarget !== null ? breakTarget : Math.max(0, (v.duration || 0) - 0.05);
    const kind = breakTarget !== null ? 'break' : 'end';
    v.pause();
    v.currentTime = target;
    showHint(true, kind);
    return;
  }
  if (current < videos.length - 1) show(current + 1, 'play');
}

function back() {
  const v = videos[current];
  // Step back through this slide's own breaks before leaving it.
  if (v) {
    const bs = breaksOf(current);
    let prev = null;
    for (let k = 0; k < bs.length; k++) if (bs[k] < v.currentTime - 0.15) prev = bs[k];
    if (prev !== null) {
      stopMonitor();
      v.pause();
      v.currentTime = prev;
      breakTarget = prev;
      showHint(true, 'break');
      return;
    }
  }
  if (current > 0) show(current - 1, 'end');
}
function replay() { show(current, 'play'); }

function start() {
  if (started) return;
  started = true;
  curtain.classList.add('is-hidden');
  show(0, 'play');
}

document.getElementById('start').addEventListener('click', e => { e.stopPropagation(); start(); });

document.addEventListener('click', () => { started ? next() : start(); });
document.addEventListener('mousemove', () => { if (started) flashHud(); });

document.addEventListener('keydown', e => {
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault(); started ? next() : start();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') {
    e.preventDefault(); back();
  } else if (e.key === 'r' || e.key === 'R') {
    replay();
  } else if (e.key === 'Home') {
    show(0, 'play');
  } else if (e.key === 'End') {
    show(videos.length - 1, 'end');
  } else if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});
</script>
</body>
</html>
"""
