"""ffmpeg audio mixing — voiceover clips → scene MP4s.

Each clip is trimmed (atrim), gain-staged (volume), faded (afade), and placed on
the timeline (adelay), then everything is mixed (amix) and muxed under the
rendered video: video stream copied, audio encoded AAC 44.1kHz stereo (fixed
params so multi-scene concat can stream-copy). Scenes without clips can get a
silent track for stream parity. Blocking subprocess.run (Windows
SelectorEventLoop rule) — callers invoke via asyncio.to_thread.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from app.models.ir import AudioClip
from app.render.stitch import probe_duration

# Fixed output-audio params — every mux uses these so concat -c copy is safe.
_AAC = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"]


def _run(args: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)


def audible_clips(clips: list[AudioClip], assets: Path) -> list[AudioClip]:
    """Clips that will actually be heard (and whose asset file exists)."""
    return [
        c for c in clips
        if not c.muted and c.duration > 1e-3 and c.asset and (assets / c.asset).is_file()
    ]


def mux_scene_audio(video: Path, clips: list[AudioClip], assets: Path, output: Path) -> None:
    """Mix `clips` under `video` into `output`. With no audible clips, attaches
    a silent track instead (keeps streams uniform across stitched scenes)."""
    vdur = probe_duration(video)
    clips = audible_clips(clips, assets)

    if not clips:
        proc = _run([
            "ffmpeg", "-y", "-i", str(video),
            "-f", "lavfi", "-t", f"{max(vdur, 0.1):.3f}",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", *_AAC,
            "-shortest", str(output),
        ])
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg silent-track mux failed: {proc.stdout.decode(errors='replace')[-800:]}")
        return

    args = ["ffmpeg", "-y", "-i", str(video)]
    for c in clips:
        args += ["-i", str(assets / c.asset)]

    filters: list[str] = []
    for i, c in enumerate(clips):
        dur = c.duration
        chain = [f"atrim=start={max(0.0, c.offset):.4f}:duration={dur:.4f}", "asetpts=PTS-STARTPTS"]
        if abs(c.gain - 1.0) > 1e-3:
            chain.append(f"volume={max(0.0, c.gain):.4f}")
        fi = min(max(0.0, c.fade_in), dur)
        fo = min(max(0.0, c.fade_out), dur)
        if fi > 1e-3:
            chain.append(f"afade=t=in:st=0:d={fi:.4f}")
        if fo > 1e-3:
            chain.append(f"afade=t=out:st={max(0.0, dur - fo):.4f}:d={fo:.4f}")
        chain.append(f"adelay={int(round(max(0.0, c.start_time) * 1000))}:all=1")
        filters.append(f"[{i + 1}:a]" + ",".join(chain) + f"[a{i}]")

    if len(clips) > 1:
        filters.append(
            "".join(f"[a{i}]" for i in range(len(clips)))
            + f"amix=inputs={len(clips)}:duration=longest:normalize=0[aout]"
        )
        amap = "[aout]"
    else:
        amap = "[a0]"

    args += ["-filter_complex", ";".join(filters), "-map", "0:v", "-map", amap,
             "-c:v", "copy", *_AAC]
    if vdur > 0:
        args += ["-t", f"{vdur:.3f}"]  # audio never extends past the video
    args.append(str(output))

    proc = _run(args)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg audio mix failed: {proc.stdout.decode(errors='replace')[-800:]}")
