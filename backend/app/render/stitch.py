"""ffmpeg scene stitching — Phase 6.

Two strategies:
  - concat: lossless concatenation of same-codec clips (concat demuxer, -c copy).
  - crossfade: xfade filtergraph that dissolves between consecutive clips.

All ffmpeg/ffprobe calls run through a blocking subprocess so they work on the
Windows SelectorEventLoop (asyncio.create_subprocess_exec raises there). Callers
invoke these via asyncio.to_thread.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def _run(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)


def probe_duration(path: Path) -> float:
    """Clip duration in seconds (0.0 if it can't be read)."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
    )
    try:
        return float(proc.stdout.decode(errors="replace").strip())
    except (ValueError, AttributeError):
        return 0.0


def concat_scenes(input_paths: list[Path], output_path: Path) -> None:
    """Concatenate clips with the concat demuxer (no re-encode)."""
    filelist = output_path.parent / "filelist.txt"
    filelist.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in input_paths),
        encoding="utf-8",
    )
    proc = _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(filelist), "-c", "copy", str(output_path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {proc.stdout.decode(errors='replace')[-800:]}")


def crossfade_scenes(input_paths: list[Path], output_path: Path, duration: float = 0.6) -> None:
    """Dissolve between consecutive clips using a chained xfade filtergraph.

    Each xfade's offset is the running output length so far minus the fade
    duration; the clips must share resolution/fps (they do — same render flags).
    """
    if len(input_paths) < 2:
        if input_paths:
            concat_scenes(input_paths, output_path)
        return

    durs = [probe_duration(p) for p in input_paths]
    d = max(0.1, float(duration))
    # Clamp the fade so it never exceeds the shorter neighbouring clip.
    d = min(d, min(durs) * 0.5) if all(x > 0 for x in durs) else d

    inputs: list[str] = []
    for p in input_paths:
        inputs += ["-i", str(p)]

    filters: list[str] = []
    prev = "[0:v]"
    acc = durs[0]
    for k in range(1, len(input_paths)):
        offset = max(0.0, acc - d)
        out = f"[v{k}]"
        filters.append(f"{prev}[{k}:v]xfade=transition=fade:duration={d}:offset={round(offset, 4)}{out}")
        prev = out
        acc = acc + durs[k] - d

    proc = _run([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(filters),
        "-map", prev, "-pix_fmt", "yuv420p", str(output_path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg xfade failed: {proc.stdout.decode(errors='replace')[-800:]}")


def zip_dir(src_dir: Path, output_zip: Path) -> None:
    """Zip a directory of PNG frames for download."""
    import zipfile
    with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src_dir.rglob("*.png")):
            zf.write(f, arcname=f.name)
