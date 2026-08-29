# Scripts — bootstrap, launch, package

Every user-facing script exists twice: PowerShell (`*.ps1`, Windows 10, **PS 5.1** — no `&&`/`||`
chains, no ternary) and POSIX shell (`*.sh`, macOS/Linux, bash). **The pairs are hand-mirrored —
there is no shared source, so when you change one, make the same change in its twin.** Root
`CLAUDE.md` has the usage overview; this file is the per-script map.

| Script | Role |
|--------|------|
| `setup.ps1` / `setup.sh` | One-time bootstrap: checks Python **3.11–3.13** and Node ≥ 18, installs ffmpeg + LaTeX (winget: MiKTeX / Homebrew: MacTeX), creates the venv at `backend/.venv/`, pip-installs backend deps + Manim (verified inline via `-m manim --version`), npm-installs the frontend. Also detects Node/npm TLS-interception cert failures and applies the `--use-system-ca` workaround. No admin/sudo needed on Windows. **Python is version-*bounded*, not just floored** — `requirements.txt` pins `pydantic==2.9.0`, whose `pydantic-core` wheels stop at cp313, so a 3.14+ interpreter sends pip into a from-source Rust build that fails. `setup.sh` therefore probes for `python3.13/3.12/3.11` explicitly instead of trusting bare `python3`, and both scripts **delete and recreate an existing venv** whose interpreter is broken or out of range (otherwise "venv already exists" masks an unfixable env). **macOS also needs `cairo` + `pkg-config`** (`setup.sh` brew-installs them): pycairo publishes *Windows-only* wheels, so it always compiles from source on macOS and its meson build shells out to pkg-config to find cairo. ManimPango *does* ship macOS wheels, so pango is not required. Every pip step is exit-code-checked and prints its captured output on failure — silent `--quiet` failures were what produced a baffling downstream `No module named manim`. |
| `check_deps.py` | Standalone dep verification (manim / pdflatex / ffmpeg on PATH required, sympy import optional; exit 0 only when all required pass). **Currently orphaned** — its docstring says "called from setup.ps1" but nothing invokes it anymore (setup verifies inline); it remains as a manual diagnostic. Distinct from the backend's `app/deps_check.py`, which feeds the frontend `DepGate` at runtime. |
| `start.ps1` | Dev launch (Windows): backend (uvicorn `--reload --reload-dir app`, port 8000) and frontend (vite, port 5173) each in its **own window** via `run-in-job.ps1`; command/dir/title are passed through `LOCUS_CMD`/`LOCUS_DIR`/`LOCUS_TITLE` env vars (inherited at launch) to dodge argument-quoting issues. **Preflights the venv by running it**, not by `Test-Path` alone (see the pyvenv.cfg gotcha below), then waits for *both* servers — backend on `/openapi.json`, frontend on `/` — before opening the browser, so a backend that died on launch is reported instead of silently leaving a broken app on screen. |
| `run-in-job.ps1` | Internal, not run directly: assigns its own process to a Windows **Job Object** with `KILL_ON_JOB_CLOSE` (P/Invoke via `Add-Type`) before running `LOCUS_CMD`, so closing the window — Ctrl+C, ✕, or `Stop-Process` — kills the whole child tree (uvicorn reloader + worker, node). |
| `start.sh` | Dev launch (macOS/Linux): both servers as background jobs of **one shell**; a `trap … kill 0` on Ctrl+C/exit tears down the process group — the Unix stand-in for the Job Object. Same ports, same browser-open, and the same run-the-venv preflight + two-server readiness wait as `start.ps1`. |
| `package.ps1` / `package.sh` | Single-process packaging, step 1: `vite build` → `frontend/dist`, which `app/main.py` mounts so one uvicorn on :8000 serves the whole app (no Vite). `package.ps1 -PyInstaller` additionally attempts a PyInstaller backend bundle — a documented skeleton only, because Manim, LaTeX and ffmpeg stay external host deps a frozen build must locate, not embed. |

Platform gotcha both start scripts encode: the venv interpreter is
`backend/.venv/Scripts/python.exe` on Windows but `backend/.venv/bin/python` on macOS/Linux —
scripts must use the right one explicitly, since the venv is never "activated".

## Keep every `.ps1` pure ASCII

BOM-less `.ps1` files are decoded by PS 5.1 as **Windows-1252, not UTF-8**. A UTF-8 em dash
(`—`, `E2 80 94`) therefore arrives as `â€"`, whose last byte is cp1252 `0x94` = a *curly closing
double quote* — and PowerShell honours curly quotes as string delimiters. One em dash inside a
`Write-Host` string silently unbalances every string after it, and the whole file stops parsing
(`package.ps1` was dead this way, failing with errors pointing 20 lines away from the real cause).
So: **ASCII hyphens only in `.ps1`**, even in comments. The `.sh` twins are read as UTF-8 by bash
and may keep their em dashes, which is the other reason the pairs are not byte-identical.
Check the whole set with:

```powershell
Get-ChildItem scripts\*.ps1 | ForEach-Object {
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs)
    "{0}: {1}" -f $_.Name, $(if ($errs) { "PARSE ERRORS" } else { "ok" })
}
```

## Two gotchas the start-script preflight exists for

**A venv can exist and still be dead.** If `backend/.venv/pyvenv.cfg` goes missing (easy to do by
copying or partially cleaning the tree — switching dev machines has produced it), `Scripts\python.exe`
is still there and still executable, but *every* invocation exits **106** with `failed to locate
pyvenv.cfg`. A `Test-Path` / `-x` check sails straight past that, so the start scripts run the
interpreter and `importlib.util.find_spec` the four core deps instead. **The fast repair is
`python -m venv backend/.venv` with no `--clear`** — it rewrites `pyvenv.cfg` and the launcher stubs
while leaving `Lib/site-packages` intact, so Manim is not re-downloaded. `setup.ps1`/`setup.sh` also
recover it, but by deleting and rebuilding the whole venv (several minutes).

**PS 5.1 eats double quotes bound for a native `.exe`.** Passing `-c "print(\"hi\")"` to `python.exe`
delivers `print(hi)` — the inner quotes are dropped and the program dies of `SyntaxError`. So any
Python one-liner in a `.ps1` must quote its string literals with **single** quotes inside a
double-quoted PowerShell string. `start.sh` needs the reverse (double inside single), which is why
that one line legitimately differs between the mirrored pair.
