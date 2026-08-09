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

if (-not (Test-Path $VenvPython)) {
    Write-Host "Virtual environment not found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
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

# --- Wait until Vite actually serves, then open the browser at the right URL ---
# (Avoids opening too early, the wrong port, or an https auto-upgrade.)
Write-Host ""
Write-Host "Waiting for the frontend to be ready..." -ForegroundColor Gray
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = Invoke-WebRequest "http://localhost:5173/" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
}

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
