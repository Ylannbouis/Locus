#!/usr/bin/env bash
#
# Bootstrap Math Animation Studio on macOS (the Unix counterpart of setup.ps1).
# Installs missing system dependencies (ffmpeg, LaTeX) via Homebrew and sets up
# the Python venv + Manim + frontend npm packages. Does NOT need root; the LaTeX
# cask install may prompt for your password.
#
# Usage:  bash scripts/setup.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '  [OK] %s\n' "$1"; }
warn() { printf '  [!!] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; }

# ---------------------------------------------------------------------------
# 0. Platform sanity + Homebrew (used to install ffmpeg / LaTeX)
# ---------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
    warn "This script targets macOS. On Linux, install ffmpeg + a TeX distribution"
    warn "with your package manager, then create the venv as below (see the README)."
fi

step "Checking Homebrew"
HAS_BREW=0
if command -v brew >/dev/null 2>&1; then
    HAS_BREW=1
    ok "brew $(brew --version | head -n1)"
else
    warn "Homebrew not found — can't auto-install ffmpeg / LaTeX."
    warn "Install it from https://brew.sh, or install ffmpeg + MacTeX manually."
fi

# ---------------------------------------------------------------------------
# 1. Python >= 3.10
# ---------------------------------------------------------------------------
step "Checking Python"
PY_BIN="$(command -v python3 || true)"
if [[ -z "$PY_BIN" ]]; then
    fail "python3 not found. Install it:  brew install python@3.12"
    exit 1
fi
PY_VER="$("$PY_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
PY_OK="$("$PY_BIN" -c 'import sys; print(1 if sys.version_info[:2] >= (3, 10) else 0)')"
if [[ "$PY_OK" != "1" ]]; then
    fail "Python 3.10+ required, found $PY_VER.  brew install python@3.12"
    exit 1
fi
ok "Python $PY_VER"

# ---------------------------------------------------------------------------
# 2. Node.js >= 18
# ---------------------------------------------------------------------------
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not found. Install:  brew install node"
    exit 1
fi
NODE_VER="$(node --version)"          # e.g. v20.11.0
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if (( NODE_MAJOR < 18 )); then
    fail "Node.js 18+ required, found $NODE_VER.  brew install node"
    exit 1
fi
ok "Node.js $NODE_VER"

# ---------------------------------------------------------------------------
# 2b. TLS / corporate-proxy handling for npm (usually a no-op on macOS)
#   An HTTPS-intercepting proxy or AV can re-sign traffic with a root CA that
#   the OS trusts but Node's bundled CA store doesn't, making `npm install` fail
#   with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Node 22.15+ can use the system trust
#   store via --use-system-ca.
# ---------------------------------------------------------------------------
step "Checking npm TLS to registry"
if node -e "require('https').get('https://registry.npmjs.org/react',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
    ok "Node can verify the npm registry certificate"
else
    NODE_MINOR="${NODE_VER#v*.}"; NODE_MINOR="${NODE_MINOR%%.*}"
    if (( NODE_MAJOR > 22 || (NODE_MAJOR == 22 && NODE_MINOR >= 15) )); then
        export NODE_OPTIONS="--use-system-ca"
        warn "TLS interception detected. Using the system cert store (NODE_OPTIONS=--use-system-ca) for this run."
        warn "Make it permanent by adding to your shell profile:  export NODE_OPTIONS=--use-system-ca"
    else
        warn "TLS interception detected and Node $NODE_VER is too old for --use-system-ca (needs 22.15+)."
        warn "Export your proxy/AV root CA to a .pem and:  export NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem"
    fi
fi

# ---------------------------------------------------------------------------
# 3. ffmpeg
# ---------------------------------------------------------------------------
step "Checking ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
    ok "ffmpeg found at $(command -v ffmpeg)"
elif (( HAS_BREW )); then
    warn "ffmpeg not found. Installing via Homebrew..."
    if brew install ffmpeg; then ok "ffmpeg installed"; else
        fail "Could not install ffmpeg. Install it manually:  brew install ffmpeg"
    fi
else
    fail "ffmpeg not found and Homebrew is unavailable. Install ffmpeg manually."
fi

# ---------------------------------------------------------------------------
# 4. LaTeX (MacTeX). Manim shells out to latex/dvisvgm to typeset equations.
#    mactex-no-gui is large (~4GB) but is the reliable, complete option; the
#    lighter BasicTeX works too but then needs `tlmgr install` for several
#    packages Manim uses. The cask install prompts for your password.
# ---------------------------------------------------------------------------
step "Checking LaTeX (pdflatex)"
if command -v pdflatex >/dev/null 2>&1; then
    ok "pdflatex found at $(command -v pdflatex)"
elif (( HAS_BREW )); then
    warn "pdflatex not found. Installing MacTeX (mactex-no-gui, ~4GB) via Homebrew..."
    if brew install --cask mactex-no-gui; then
        # TeX binaries land in /Library/TeX/texbin, not always on PATH yet.
        [[ -d /Library/TeX/texbin ]] && export PATH="/Library/TeX/texbin:$PATH"
        ok "MacTeX installed (open a new terminal so /Library/TeX/texbin is on PATH)"
    else
        fail "Could not install MacTeX automatically."
        warn "Install it from https://www.tug.org/mactex/ or:  brew install --cask mactex-no-gui"
        warn "Lighter alternative: brew install --cask basictex, then tlmgr install the packages Manim needs."
    fi
else
    fail "pdflatex not found and Homebrew is unavailable."
    warn "Install MacTeX from https://www.tug.org/mactex/"
fi

# ---------------------------------------------------------------------------
# 5. Python virtual environment + Manim
# ---------------------------------------------------------------------------
step "Setting up Python virtual environment"
VENV_PATH="$PROJECT_ROOT/backend/.venv"
if [[ ! -d "$VENV_PATH" ]]; then
    "$PY_BIN" -m venv "$VENV_PATH"
    ok "Created venv at $VENV_PATH"
else
    ok "venv already exists"
fi

VENV_PY="$VENV_PATH/bin/python"

step "Installing Python dependencies (this may take a few minutes)"
"$VENV_PY" -m pip install --upgrade pip --quiet
"$VENV_PY" -m pip install manim --quiet
"$VENV_PY" -m pip install -r "$PROJECT_ROOT/backend/requirements.txt" --quiet
ok "Python packages installed"

step "Verifying Manim"
if MANIM_VER="$("$VENV_PY" -m manim --version 2>&1 | head -n1)"; then
    ok "Manim: $MANIM_VER"
else
    fail "Manim verification failed: $MANIM_VER"
    exit 1
fi

# ---------------------------------------------------------------------------
# 6. Frontend npm dependencies
# ---------------------------------------------------------------------------
step "Installing frontend npm dependencies"
( cd "$PROJECT_ROOT/frontend" && npm install --silent )
ok "npm packages installed"

# ---------------------------------------------------------------------------
# 7. Cache the setup result
# ---------------------------------------------------------------------------
printf '{\n  "completed": true,\n  "timestamp": "%s"\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PROJECT_ROOT/setup_result.json"
ok "Setup result cached"

printf '\n================================================================\n'
printf '  Setup complete!  Run:  bash scripts/start.sh\n'
printf '================================================================\n'
