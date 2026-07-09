# Scripts — bootstrap, launch, package

Every user-facing script exists twice: PowerShell (`*.ps1`, Windows 10, **PS 5.1** — no `&&`/`||`
chains, no ternary) and POSIX shell (`*.sh`, macOS/Linux, bash). **The pairs are hand-mirrored —
there is no shared source, so when you change one, make the same change in its twin.** Root
`CLAUDE.md` has the usage overview; this file is the per-script map.

| Script | Role |
|--------|------|
| `setup.ps1` / `setup.sh` | One-time bootstrap: checks Python ≥ 3.10 and Node ≥ 18, installs ffmpeg + LaTeX (winget: MiKTeX / Homebrew: MacTeX), creates the venv at `backend/.venv/`, pip-installs backend deps + Manim (verified inline via `-m manim --version`), npm-installs the frontend. Also detects Node/npm TLS-interception cert failures and applies the `--use-system-ca` workaround. No admin/sudo needed on Windows. |
| `check_deps.py` | Standalone dep verification (manim / pdflatex / ffmpeg on PATH required, sympy import optional; exit 0 only when all required pass). **Currently orphaned** — its docstring says "called from setup.ps1" but nothing invokes it anymore (setup verifies inline); it remains as a manual diagnostic. Distinct from the backend's `app/deps_check.py`, which feeds the frontend `DepGate` at runtime. |
| `start.ps1` | Dev launch (Windows): backend (uvicorn `--reload --reload-dir app`, port 8000) and frontend (vite, port 5173) each in its **own window** via `run-in-job.ps1`; command/dir/title are passed through `MAS_CMD`/`MAS_DIR`/`MAS_TITLE` env vars (inherited at launch) to dodge argument-quoting issues. Opens the browser when both are up. |
| `run-in-job.ps1` | Internal, not run directly: assigns its own process to a Windows **Job Object** with `KILL_ON_JOB_CLOSE` (P/Invoke via `Add-Type`) before running `MAS_CMD`, so closing the window — Ctrl+C, ✕, or `Stop-Process` — kills the whole child tree (uvicorn reloader + worker, node). |
| `start.sh` | Dev launch (macOS/Linux): both servers as background jobs of **one shell**; a `trap … kill 0` on Ctrl+C/exit tears down the process group — the Unix stand-in for the Job Object. Same ports, same browser-open. |
| `package.ps1` / `package.sh` | Single-process packaging, step 1: `vite build` → `frontend/dist`, which `app/main.py` mounts so one uvicorn on :8000 serves the whole app (no Vite). `package.ps1 -PyInstaller` additionally attempts a PyInstaller backend bundle — a documented skeleton only, because Manim, LaTeX and ffmpeg stay external host deps a frozen build must locate, not embed. |

Platform gotcha both start scripts encode: the venv interpreter is
`backend/.venv/Scripts/python.exe` on Windows but `backend/.venv/bin/python` on macOS/Linux —
scripts must use the right one explicitly, since the venv is never "activated".
