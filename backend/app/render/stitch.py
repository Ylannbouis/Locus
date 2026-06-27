"""ffmpeg scene stitching — Phase 6 implementation."""
from __future__ import annotations

import asyncio
from pathlib import Path


async def concat_scenes(input_paths: list[Path], output_path: Path) -> None:
    """Concatenate rendered scene MP4s using ffmpeg concat demuxer."""
    filelist = output_path.parent / "filelist.txt"
    filelist.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in input_paths),
        encoding="utf-8",
    )
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(filelist), "-c", "copy", str(output_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {stderr.decode(errors='replace')}")
