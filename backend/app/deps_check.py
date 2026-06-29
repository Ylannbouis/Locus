"""Runtime dependency verification."""
from __future__ import annotations

import asyncio
import importlib
import subprocess
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


def _run_check(args: list[str]) -> DepStatus:
    # Plain blocking subprocess (run off-thread by the caller). Avoids
    # asyncio.create_subprocess_exec, which raises NotImplementedError on the
    # Windows SelectorEventLoop that uvicorn uses under --reload.
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        text = (proc.stdout or proc.stderr).decode(errors="replace").splitlines()
        version = text[0].strip() if text else ""
        if proc.returncode == 0:
            return DepStatus(ok=True, version=version)
        return DepStatus(ok=False, error=version or f"exited with code {proc.returncode}")
    except FileNotFoundError:
        return DepStatus(ok=False, error="Not found in PATH")
    except subprocess.TimeoutExpired:
        return DepStatus(ok=False, error="Check timed out")
    except Exception as exc:
        return DepStatus(ok=False, error=str(exc) or type(exc).__name__)


async def _check_subprocess(args: list[str]) -> DepStatus:
    return await asyncio.to_thread(_run_check, args)


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
