# Render — job queue, Manim subprocess, ffmpeg post-processing

| File | Role |
|------|------|
| `queue.py` | In-process job registry + pub/sub for progress events. `new_job_id()` → 12-char slug. |
| `worker.py` | The single background worker: generate script → run Manim → locate output → post-process. |
| `audio.py` | ffmpeg voiceover mixing (per scene). |
| `stitch.py` | ffmpeg multi-scene concat / crossfade, `zip_dir`, `probe_duration`. |
| `slideshow.py` | Slideshow packaging + the generated single-file HTML player. |

No database, no Celery: the queue is an `asyncio.Queue` and jobs live in a module dict, so a backend
restart loses them.

## Platform rules (do not violate)

1. **No `asyncio.create_subprocess_exec` / `create_subprocess_shell`.** They raise
   `NotImplementedError` — whose `str()` is `""`, so it surfaces as a blank error — on the Windows
   asyncio **SelectorEventLoop** that uvicorn uses under `--reload`. Always run blocking
   `subprocess.run` / `Popen` via `asyncio.to_thread`. Applied throughout this package.
2. **Invoke Manim as `[sys.executable, "-m", "manim", "render", ...]`** — never `["manim", ...]`. The
   venv is not activated, so its `manim` entrypoint isn't on PATH. ffmpeg / ffprobe / pdflatex *are*
   system tools resolved via PATH, so calling those by name is fine.
3. **Worker-thread → event-loop hand-off.** `queue.update_job` broadcasts via
   `asyncio.Queue.put_nowait`, which is only safe on the loop thread. `_render_one` runs `Popen` in
   `asyncio.to_thread` and fires its progress callbacks on that worker thread, so `_process` wraps
   each in `loop.call_soon_threadsafe` (see "Progress" below). Do the same for any new code that
   updates a job from a thread.

## Pipeline

`POST /api/render` (or `/api/render/morph-preview`) → `queue.enqueue(RenderJob)` → `run_worker`
(started in `main.lifespan`) processes **one job at a time**. Per scene: generate script → write
`scene.py` under the job dir → run Manim (`_build_cmd`: `-ql`/`-qh` plus optional `--resolution` /
`--fps` / `--format` / `-s` / `-t`) → `_find_output` (format-aware, `_mtime`-ranked). The client watches
`WS /ws/render/{job_id}` and downloads from `/api/render/{job_id}/download`.

- **Timeout:** the Manim subprocess has a **per-scene** wall-clock cap (`_render_timeout`), default 6h —
  a runaway guard, not a deadline. Override with `LOCUS_RENDER_TIMEOUT` (seconds; `0` disables). The
  ffmpeg helpers keep their own fixed timeouts: `stitch.py` 1800s, `audio.py` 600s, probes 60s.
- `RenderJob.scene_id` is a specific scene, or **`None` = every scene**. Multi-scene **mp4** jobs render
  each scene then stitch (`crossfade_scenes` when `transition`, else `concat_scenes`); other formats and
  morph render a single scene.
- `RenderJob.format` ∈ `mp4 | gif | png | still | slideshow`. `png` returns the frame *directory*, which
  the worker zips (`zip_dir`); `still` uses `-s` (last frame); `transparent` adds `-t` (non-mp4 only).
- `RenderJob.mode` is `"scene"` (normal) or `"morph"` (a 1s standalone `morph_equation` preview).

## Progress (`_JobProgress`, and the script's `_LocusProgress`)

The bar tracks **Manim's own frame counter**, not the clock. `generate_scene_script(…, progress=True)`
mixes `_LocusProgress` into the generated scene (worker renders only — the ejected `/script` output
stays clean): it wraps `Scene.get_time_progression`, the iterator `play_internal` steps once per
rendered frame, and prints `LOCUS_PROGRESS <done_s> <total_s>` to stdout at most 5×/s. `<total_s>`
comes from `build_body_timed`, so it is exactly what the emitted statements will render. Static waits
never reach that iterator (the renderer freezes one frame instead), so the mixin's `play` override
settles them up afterwards.

`_render_one` therefore streams the subprocess line by line instead of collecting output at exit, and
its callbacks run on the **worker thread** — `_process` hands them back with `loop.call_soon_threadsafe`
(rule 3 above). `_JobProgress` maps scene fractions onto 10 → 85/90%, weighting scenes by
`scene_runtime_seconds` so a 60s scene doesn't get the same slice as a 5s one, and extrapolates
`RenderJob.eta_seconds` from the frame rate measured since the current scene's first frame (start-up
excluded — including it overstates the first estimate several-fold). Before that first frame,
`_progress_ticker` → `drift()` creeps asymptotically into a quarter of the scene's slice; it never
pins the bar at the ceiling the way the old fixed-step ticker did.

Because the deadline can no longer be enforced by `subprocess.run(timeout=…)`, a `threading.Timer`
kills the process instead — a Manim wedged before printing anything would otherwise block the read loop.

## Audio (`audio.py`)

After Manim produces a scene's mp4, the worker mixes that scene's `Scene.audio` clips under the video —
**codegen and the ejected script never see audio.** Each clip is trimmed/gained/faded/delayed and
`mux_scene_audio` muxes the result: video **copied**, audio AAC 44.1 kHz stereo. Those params are fixed
*so concat can stream-copy* later — don't make them depend on the source file.
`audible_clips` filters to clips that will actually be heard: not muted, longer than 1ms, and whose
asset file **exists on disk**.

When a clip runs past the video, the last frame is held (`tpad`, which forces a video re-encode) so the
scene ends on the later of last-animation / last-audio instead of truncating the voiceover.

**Silent tracks are `mux_scene_audio`'s job**, not the stitcher's: called on a scene with no audible
clips it attaches a silent track instead of a mix. The worker exploits that — when *stitching* it muxes
every scene (so concat sees uniform streams), and otherwise skips clipless scenes entirely. That skip is
also why slideshow slides get no padding: nothing is concatenated, so stream parity doesn't matter.

## Stitching (`stitch.py`)

`concat_scenes` uses the concat demuxer with `-c copy` (no re-encode), which is why every input must
already have identical streams. `crossfade_scenes` chains `xfade` — each offset is the running output
length minus the fade duration — and delays + amixes the per-scene audio to match the video offsets,
using `_has_audio` (ffprobe) to see which inputs actually have a track. `probe_duration` is ffprobe;
`zip_dir` packages PNG sequences.

## Slideshow (`slideshow.py`)

For `Project.kind == "slideshow"`. Every scene renders as an ordinary mp4 — same Manim flags as `mp4`,
no `--format` — and is then **packaged instead of stitched**: `build_slideshow` copies the per-scene
mp4s into `job_dir/slideshow/` (`slide_filename` → `slides/slide_NN.mp4`) and generates a single-file
`index.html` player plus `manifest.json`; `zip_slideshow` produces `job_dir/slideshow.zip` for download.
The **unzipped folder stays** in the job dir so the editor's Present mode can stream from
`/api/render/{job_id}/slides[/{i}]`.

- Audio is mixed per slide with **no silent-track padding** — nothing is concatenated here, so stream
  parity doesn't matter.
- The hold between slides is just a **paused `<video>`**, so no ffmpeg padding is involved. A scene's
  `breaks` are the same trick *inside* a slide: `_slide_breaks` clamps them to the probed duration and
  the player's rAF loop pauses on each until the next click.
- `_render_player` is a **deliberate mirror of `frontend/src/components/Presenter.tsx`** — same keys,
  same freeze-on-last-frame, same break handling. **Change both or they drift.**
