#Requires -Version 5.1
<#
.SYNOPSIS
  Launch the Locus dev servers (uvicorn --reload + vite).
  Each server runs in its OWN window, wrapped in a Windows Job Object (see
  run-in-job.ps1) so Ctrl+C, closing the window, or Stop-Process cleanly stops
  it AND every child process it spawned (no orphaned reloader/worker/node).
  Open http://localhost:5173 in your browser after both windows are up.
#>

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython  = Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe"
$BackendDir  = Join-Path $ProjectRoot "backend"
$FrontendDir = Join-Path $ProjectRoot "frontend"

# --- Preflight: the venv interpreter must actually RUN, with the deps present -
# Testing only that the .exe exists is not enough. A venv that has lost its
# pyvenv.cfg still has Scripts\python.exe, but every launch of it dies with
# "failed to locate pyvenv.cfg" (exit 106) -- which used to sail past this check
# and leave the backend window dead on arrival while the browser opened anyway.
if (-not (Test-Path $VenvPython)) {
    Write-Host "Virtual environment not found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
    exit 1
}
# The Python string literals below MUST be single-quoted: PS 5.1 does not escape
# double quotes when it hands an argument to a native .exe, so "fastapi" would
# reach python as a bare name and the probe would die of SyntaxError every time.
# (start.sh has the quoting the other way round -- bash needs it that way.)
$ProbeCode = "import importlib.util as u, sys; m=[n for n in ('fastapi','uvicorn','pydantic','manim') if u.find_spec(n) is None]; print(' '.join(m)); sys.exit(1 if m else 0)"
# 2>&1 wraps a native exe's stderr lines in ErrorRecords, and a *blank* stderr
# line renders as the literal "System.Management.Automation.RemoteException".
# Take .Exception.Message and drop the empties so the user sees only real text.
$probe = ((& $VenvPython -c $ProbeCode 2>&1) | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
} | Where-Object { $_ -and $_.Trim() }) -join " "
if ($LASTEXITCODE -ne 0) {
    Write-Host "The backend virtual environment at" -ForegroundColor Red
    Write-Host "  $VenvPython" -ForegroundColor Red
    Write-Host "is broken or incomplete:" -ForegroundColor Red
    Write-Host "  $probe" -ForegroundColor DarkGray
    Write-Host "Run .\scripts\setup.ps1 to repair it." -ForegroundColor Yellow
    exit 1
}

Write-Host "Starting Locus..." -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:8000   (its own window)" -ForegroundColor Gray
Write-Host "  Frontend: http://localhost:5173   (its own window)" -ForegroundColor Gray

# Each server runs through run-in-job.ps1, which puts the window's process (and
# all its children) in a Windows Job Object that is killed when the window exits.
# That lets us enable uvicorn --reload without leaking orphaned reloader/worker
# processes when the window is closed. The command + dir + title are passed via
# environment variables (inherited at launch) to avoid argument-quoting issues.
$Runner = Join-Path $PSScriptRoot "run-in-job.ps1"

# --- Backend window: uvicorn with auto-reload (watches the app/ package only) ---
$env:LOCUS_DIR   = $BackendDir
$env:LOCUS_TITLE = "Locus Backend (Ctrl+C to stop)"
$env:LOCUS_CMD   = "& '$VenvPython' -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir app"
$backend = Start-Process powershell `
    -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$Runner`"" `
    -PassThru

# --- Frontend window: vite dev server (already hot-reloads) ---
$env:LOCUS_DIR   = $FrontendDir
$env:LOCUS_TITLE = "Locus Frontend (Ctrl+C to stop)"
$env:LOCUS_CMD   = "npm run dev"
$frontend = Start-Process powershell `
    -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$Runner`"" `
    -PassThru

# Don't leave these lingering in the launching shell's environment.
Remove-Item Env:LOCUS_DIR, Env:LOCUS_TITLE, Env:LOCUS_CMD -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Two windows opened:" -ForegroundColor Green
Write-Host ("  Backend  PID {0}" -f $backend.Id)  -ForegroundColor Gray
Write-Host ("  Frontend PID {0}" -f $frontend.Id) -ForegroundColor Gray

# --- Wait for both servers, then open the browser at the right URL -----------
# (Avoids opening too early, the wrong port, or an https auto-upgrade.)
# The sleep lives outside the try so a non-200 answer paces itself too, and the
# loop is bounded by wall-clock rather than by attempt count -- each attempt can
# itself burn the 2s timeout, so 60 attempts was never really "30 seconds".
function Wait-ForHttp([string]$Url, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Write-Host ""
Write-Host "Waiting for the backend to be ready..." -ForegroundColor Gray
# /openapi.json is served by FastAPI itself, so it answers as soon as uvicorn is
# listening -- unlike /api/system/deps, which shells out to manim/pdflatex/ffmpeg.
if (Wait-ForHttp "http://127.0.0.1:8000/openapi.json" 30) {
    Write-Host "Backend is up." -ForegroundColor Green
} else {
    Write-Host "Backend did not answer on http://localhost:8000 within 30s." -ForegroundColor Yellow
    Write-Host "Check the 'Locus Backend' window. If it closed immediately, the venv is" -ForegroundColor Yellow
    Write-Host "broken - re-run .\scripts\setup.ps1." -ForegroundColor Yellow
}

Write-Host "Waiting for the frontend to be ready..." -ForegroundColor Gray
$ready = Wait-ForHttp "http://localhost:5173/" 30

if ($ready) {
    Write-Host "Frontend is up. Opening browser..." -ForegroundColor Green
    Start-Process "http://localhost:5173/"
} else {
    Write-Host "Frontend did not respond on http://localhost:5173 within 30s." -ForegroundColor Yellow
    Write-Host "Check the 'Locus Frontend' window for errors, then open http://localhost:5173/ manually." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "App URL: http://localhost:5173/   (use http://, not https)" -ForegroundColor Cyan
Write-Host "To stop: press Ctrl+C in each window, or close them." -ForegroundColor Yellow
Write-Host ("To stop both from here:  Stop-Process -Id {0},{1} -Force" -f $backend.Id, $frontend.Id) -ForegroundColor DarkGray
