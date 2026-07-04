#!/usr/bin/env bash
#
# Launch the Math Animation Studio dev servers on macOS/Linux (the Unix
# counterpart of start.ps1). Runs uvicorn --reload and the Vite dev server as
# background jobs of THIS script and installs a trap that kills the whole
# process group on Ctrl+C / exit — so uvicorn's reloader + render worker and
# vite's esbuild children are cleaned up together (no orphans). This is the Unix
# equivalent of the Windows Job Object trick in run-in-job.ps1.
#
# Usage:  bash scripts/start.sh      (Ctrl+C to stop both)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_PY="$PROJECT_ROOT/backend/.venv/bin/python"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

if [[ ! -x "$VENV_PY" ]]; then
    printf 'Virtual environment not found. Run  bash scripts/setup.sh  first.\n' >&2
    exit 1
fi

printf 'Starting Math Animation Studio...\n'
printf '  Backend:  http://localhost:8000\n'
printf '  Frontend: http://localhost:5173\n\n'

# Kill every child (and their descendants) when this script exits for any
# reason. `kill 0` targets the whole process group this script leads.
cleanup() {
    trap - INT TERM EXIT
    printf '\nStopping servers...\n'
    kill 0 2>/dev/null
}
trap cleanup INT TERM EXIT

# --- Backend: uvicorn with auto-reload (watches the app/ package only) ---
( cd "$BACKEND_DIR" && exec "$VENV_PY" -m uvicorn app.main:app \
    --host 127.0.0.1 --port 8000 --reload --reload-dir app ) &
BACKEND_PID=$!

# --- Frontend: Vite dev server (already hot-reloads) ---
( cd "$FRONTEND_DIR" && exec npm run dev ) &
FRONTEND_PID=$!

printf 'Backend  PID %s\n' "$BACKEND_PID"
printf 'Frontend PID %s\n\n' "$FRONTEND_PID"

# --- Wait for Vite to actually serve, then open the browser ---
open_url() {
    if command -v open >/dev/null 2>&1; then open "$1"        # macOS
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"  # Linux
    fi
}
if command -v curl >/dev/null 2>&1; then
    printf 'Waiting for the frontend to be ready...\n'
    for _ in $(seq 1 60); do
        if curl -sf -o /dev/null http://localhost:5173/; then
            printf 'Frontend is up. Opening browser...\n'
            open_url "http://localhost:5173/"
            break
        fi
        sleep 0.5
    done
fi

printf '\nApp URL: http://localhost:5173/   (use http://, not https)\n'
printf 'Press Ctrl+C to stop both servers.\n'

# Block until a server exits (or Ctrl+C fires the trap).
wait
