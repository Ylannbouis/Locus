#!/usr/bin/env python3
"""Standalone dependency check — called from setup.ps1."""
import subprocess
import sys
import importlib


def check(name: str, args: list[str]) -> tuple[bool, str]:
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=15)
        out = (r.stdout or r.stderr).splitlines()
        ver = out[0].strip() if out else ""
        return r.returncode == 0, ver
    except FileNotFoundError:
        return False, "not found in PATH"
    except Exception as e:
        return False, str(e)


def check_import(module: str) -> tuple[bool, str]:
    try:
        m = importlib.import_module(module)
        return True, getattr(m, "__version__", "installed")
    except ImportError:
        return False, "not installed"


checks = [
    ("Python", None, f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", True),
]

results = {}
ok_manim, ver_manim = check("Manim", ["manim", "--version"])
ok_latex, ver_latex = check("LaTeX (pdflatex)", ["pdflatex", "--version"])
ok_ffmpeg, ver_ffmpeg = check("ffmpeg", ["ffmpeg", "-version"])
ok_sympy, ver_sympy = check_import("sympy")

for label, ok, ver, required in [
    ("Python", True, f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", True),
    ("Manim", ok_manim, ver_manim, True),
    ("LaTeX", ok_latex, ver_latex, True),
    ("ffmpeg", ok_ffmpeg, ver_ffmpeg, True),
    ("sympy", ok_sympy, ver_sympy, False),
]:
    status = "OK" if ok else ("MISSING (required)" if required else "MISSING (optional)")
    print(f"  {'[OK]' if ok else '[!!]'} {label:12s} {status}  {ver}")

all_required_ok = ok_manim and ok_latex and ok_ffmpeg
sys.exit(0 if all_required_ok else 1)
