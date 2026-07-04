#!/usr/bin/env bash
#
# Package Math Animation Studio for single-process running on macOS/Linux
# (the Unix counterpart of package.ps1).
#
# Step 1 (works today): build the frontend to frontend/dist. The backend serves
# it at http://localhost:8000 (main.py mounts frontend/dist if present), so the
# whole app runs from one uvicorn process — no Vite needed.
#
# Usage:  bash scripts/package.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_PY="$BACKEND_DIR/.venv/bin/python"

printf '== Math Animation Studio — package ==\n'

printf 'Building frontend (vite build)...\n'
( cd "$FRONTEND_DIR" && npm run build ) || { printf 'frontend build failed\n' >&2; exit 1; }

DIST="$FRONTEND_DIR/dist"
if [[ -d "$DIST" ]]; then
    printf 'Frontend built -> %s\n' "$DIST"
    printf 'Run the single-process app with:\n'
    printf "  '%s' -m uvicorn app.main:app --app-dir '%s' --port 8000\n" "$VENV_PY" "$BACKEND_DIR"
    printf '  then open http://localhost:8000\n'
else
    printf 'expected build output at %s\n' "$DIST" >&2
    exit 1
fi

printf '\nNotes / TODO for a real installer:\n'
printf '  - Manim renders by shelling out to "python -m manim"; a frozen build must ship a\n'
printf '    Python+Manim runtime or detect a system one. worker.py uses sys.executable.\n'
printf '  - LaTeX (MacTeX) and ffmpeg stay external system deps (see scripts/setup.sh).\n'
printf '  - Wrap the uvicorn server + a webview (e.g. pywebview) for a desktop window.\n'
