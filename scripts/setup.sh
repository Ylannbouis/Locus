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
# 1. Python 3.11–3.13
#   Upper bound matters: the pinned deps in backend/requirements.txt ship no
#   wheels past cp313 (pydantic 2.9.0 / pydantic-core 2.23.x), so on a newer
#   interpreter pip falls back to compiling Rust from source and dies. Prefer
#   the newest supported minor; only use a bare `python3` if it lands in range.
# ---------------------------------------------------------------------------
step "Checking Python"
PY_MIN_MINOR=11
PY_MAX_MINOR=13

# Minor version of a python binary, or empty if it isn't a usable python 3.
py_minor() { "$1" -c 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else "")' 2>/dev/null; }

PY_BIN=""
for cand in python3.13 python3.12 python3.11; do
    p="$(command -v "$cand" 2>/dev/null || true)"
    for prefix in /opt/homebrew/bin /usr/local/bin; do
        [[ -z "$p" && -x "$prefix/$cand" ]] && p="$prefix/$cand"
    done
    if [[ -n "$p" ]]; then PY_BIN="$p"; break; fi
done

if [[ -z "$PY_BIN" ]]; then
    # No versioned binary found — accept the default python3 only if in range.
    p="$(command -v python3 2>/dev/null || true)"
    if [[ -z "$p" ]]; then
        fail "python3 not found. Install it:  brew install python@3.12"
        exit 1
    fi
    m="$(py_minor "$p")"
    if [[ -z "$m" ]] || (( m < PY_MIN_MINOR || m > PY_MAX_MINOR )); then
        fail "Need Python 3.$PY_MIN_MINOR–3.$PY_MAX_MINOR; the only one found is $("$p" --version 2>&1)."
        warn "This project's pinned dependencies have no wheels outside that range."
        warn "Install a supported one:  brew install python@3.12"
        exit 1
    fi
    PY_BIN="$p"
fi

PY_VER="$("$PY_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
ok "Python $PY_VER ($PY_BIN)"

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
# 3b. cairo + pkg-config — build deps for pycairo, a hard Manim dependency.
#     pycairo publishes *Windows-only* wheels, so on macOS pip always compiles
#     it from source; that build shells out to pkg-config to locate cairo, and
#     without both it fails with "Dependency lookup for cairo ... failed".
#     (ManimPango does ship macOS wheels, so pango is not needed here.)
# ---------------------------------------------------------------------------
step "Checking cairo + pkg-config (needed to build pycairo)"
NEED_BUILD_DEPS=()
command -v pkg-config >/dev/null 2>&1 || NEED_BUILD_DEPS+=(pkg-config)
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists cairo 2>/dev/null; then
    :
else
    NEED_BUILD_DEPS+=(cairo)
fi

if (( ${#NEED_BUILD_DEPS[@]} == 0 )); then
    ok "cairo and pkg-config present"
elif (( HAS_BREW )); then
    warn "Missing: ${NEED_BUILD_DEPS[*]} — installing via Homebrew..."
    if brew install "${NEED_BUILD_DEPS[@]}"; then
        ok "Installed ${NEED_BUILD_DEPS[*]}"
    else
        fail "Could not install ${NEED_BUILD_DEPS[*]}; pycairo will fail to build."
        warn "Install manually:  brew install ${NEED_BUILD_DEPS[*]}"
        exit 1
    fi
else
    fail "Missing ${NEED_BUILD_DEPS[*]} and Homebrew is unavailable."
    warn "pycairo cannot build without them. Install:  brew install ${NEED_BUILD_DEPS[*]}"
    exit 1
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
VENV_PY="$VENV_PATH/bin/python"

# An existing venv built on an out-of-range interpreter can never install the
# pinned deps, so replace it rather than reporting "already exists" and then
# failing obscurely downstream.
if [[ -d "$VENV_PATH" ]]; then
    existing_minor="$(py_minor "$VENV_PY")"
    if [[ -z "$existing_minor" ]]; then
        warn "Existing venv at $VENV_PATH is broken — recreating it."
        rm -rf "$VENV_PATH"
    elif (( existing_minor < PY_MIN_MINOR || existing_minor > PY_MAX_MINOR )); then
        warn "Existing venv uses Python 3.$existing_minor (outside 3.$PY_MIN_MINOR–3.$PY_MAX_MINOR) — recreating it on $PY_VER."
        rm -rf "$VENV_PATH"
    fi
fi

if [[ ! -d "$VENV_PATH" ]]; then
    if ! "$PY_BIN" -m venv "$VENV_PATH"; then
        fail "Could not create the venv at $VENV_PATH"
        exit 1
    fi
    ok "Created venv at $VENV_PATH (Python $PY_VER)"
else
    ok "venv already exists (Python 3.$existing_minor)"
fi

# pip failures must be fatal and visible: a silent one here is what produces a
# baffling "No module named manim" at the verification step below.
pip_install() {
    local label="$1"; shift
    local out
    if ! out="$("$VENV_PY" -m pip install --quiet "$@" 2>&1)"; then
        fail "pip install failed: $label"
        printf '%s\n' "$out"
        exit 1
    fi
}

step "Installing Python dependencies (this may take a few minutes)"
pip_install "pip upgrade" --upgrade pip
pip_install "manim" manim
pip_install "backend requirements" -r "$PROJECT_ROOT/backend/requirements.txt"
ok "Python packages installed"

step "Verifying Manim"
# Capture first, then test: piping straight into `head` would report head's
# exit status (and can SIGPIPE), masking a genuine Manim import failure.
if MANIM_OUT="$("$VENV_PY" -m manim --version 2>&1)"; then
    ok "Manim: $(printf '%s\n' "$MANIM_OUT" | grep -m1 . || printf 'installed')"
else
    fail "Manim verification failed:"
    printf '%s\n' "$MANIM_OUT"
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
