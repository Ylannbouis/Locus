"""Runtime dependency verification."""
from __future__ import annotations

import asyncio
import importlib
import sys

# In-memory cache for the process lifetime. Cleared on server restart so a
# fresh start always re-checks (avoids stale "missing" results persisting
# after the user installs a dependency).
_CACHE: dict | None = None


class DepStatus:
    def __init__(self, ok: bool, version: str = "", error: str = ""):
        self.ok = ok
        self.version = version
        self.error = error

    def dict(self) -> dict:
        return {"ok": self.ok, "version": self.version, "error": self.error}


async def _check_subprocess(args: list[str]) -> DepStatus:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        text = (stdout or stderr).decode(errors="replace").splitlines()
        version = text[0].strip() if text else ""
        if proc.returncode == 0:
            return DepStatus(ok=True, version=version)
        return DepStatus(ok=False, error=version)
    except FileNotFoundError:
        return DepStatus(ok=False, error="Not found in PATH")
    except asyncio.TimeoutError:
        return DepStatus(ok=False, error="Check timed out")
    except Exception as exc:
        return DepStatus(ok=False, error=str(exc))


def _check_python_import(module: str) -> DepStatus:
    try:
        mod = importlib.import_module(module)
        version = getattr(mod, "__version__", "installed")
        return DepStatus(ok=True, version=version)
    except ImportError as exc:
        return DepStatus(ok=False, error=str(exc))


async def check_all() -> dict[str, dict]:
    # Invoke manim through THIS interpreter (the venv's python) as a module, so
    # it works even when the venv isn't "activated" and manim.exe isn't on PATH.
    # ffmpeg and pdflatex are external system tools resolved via PATH.
    manim, latex, ffmpeg = await asyncio.gather(
        _check_subprocess([sys.executable, "-m", "manim", "--version"]),
        _check_subprocess(["pdflatex", "--version"]),
        _check_subprocess(["ffmpeg", "-version"]),
    )
    sympy = _check_python_import("sympy")
    return {
        "manim": manim.dict(),
        "latex": latex.dict(),
        "ffmpeg": ffmpeg.dict(),
        "sympy": sympy.dict(),
    }


def load_cached() -> dict | None:
    return _CACHE


def save_cache(result: dict) -> None:
    global _CACHE
    _CACHE = result
