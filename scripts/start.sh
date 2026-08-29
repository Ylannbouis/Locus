#!/usr/bin/env bash
#
# Launch the Locus dev servers on macOS/Linux (the Unix
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

# --- Preflight: the venv interpreter must actually RUN, with the deps present -
# Testing only that the file is executable is not enough. A venv that has lost
# its pyvenv.cfg still has an executable python that dies on every launch, which
# would leave the backend dead on arrival while the browser still opened.
if [[ ! -x "$VENV_PY" ]]; then
    printf 'Virtual environment not found. Run  bash scripts/setup.sh  first.\n' >&2
    exit 1
fi
PROBE='import importlib.util as u, sys; m=[n for n in ("fastapi","uvicorn","pydantic","manim") if u.find_spec(n) is None]; print(" ".join(m)); sys.exit(1 if m else 0)'
if ! probe_out="$("$VENV_PY" -c "$PROBE" 2>&1)"; then
    printf 'The backend virtual environment at\n  %s\nis broken or incomplete:\n  %s\nRun  bash scripts/setup.sh  to repair it.\n' \
        "$VENV_PY" "$probe_out" >&2
    exit 1
fi

printf 'Starting Locus...\n'
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
# Bounded by wall-clock rather than attempt count: each attempt can itself burn
# the 2s timeout, so a fixed number of tries was never really "30 seconds".
wait_for_http() {
    local url="$1" timeout="$2" deadline
    deadline=$(( $(date +%s) + timeout ))
    while (( $(date +%s) < deadline )); do
        curl -sf -o /dev/null --max-time 2 "$url" && return 0
        sleep 0.5
    done
    return 1
}

if command -v curl >/dev/null 2>&1; then
    # /openapi.json is served by FastAPI itself, so it answers as soon as uvicorn
    # is listening -- unlike /api/system/deps, which shells out to manim/ffmpeg.
    printf 'Waiting for the backend to be ready...\n'
    if wait_for_http "http://127.0.0.1:8000/openapi.json" 30; then
        printf 'Backend is up.\n'
    else
        printf 'Backend did not answer on http://localhost:8000 within 30s.\n'
        printf 'Scroll up for its error output; if the venv is broken, re-run  bash scripts/setup.sh\n'
    fi

    printf 'Waiting for the frontend to be ready...\n'
    if wait_for_http "http://localhost:5173/" 30; then
        printf 'Frontend is up. Opening browser...\n'
        open_url "http://localhost:5173/"
    else
        printf 'Frontend did not answer on http://localhost:5173 within 30s.\n'
    fi
fi

printf '\nApp URL: http://localhost:5173/   (use http://, not https)\n'
printf 'Press Ctrl+C to stop both servers.\n'

# Block until a server exits (or Ctrl+C fires the trap).
wait
