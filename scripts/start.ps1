#Requires -Version 5.1
<#
.SYNOPSIS
  Launch the Math Animation Studio dev servers (uvicorn + vite).
  Each server runs in its OWN window so Ctrl+C (or closing the window)
  cleanly stops it and all of its child processes. Open
  http://localhost:5173 in your browser after both windows are up.
#>

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython  = Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe"
$BackendDir  = Join-Path $ProjectRoot "backend"
$FrontendDir = Join-Path $ProjectRoot "frontend"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Virtual environment not found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host "Starting Math Animation Studio..." -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:8000   (its own window)" -ForegroundColor Gray
Write-Host "  Frontend: http://localhost:5173   (its own window)" -ForegroundColor Gray

# --- Backend window: uvicorn (no --reload; reload spawns extra processes that
#     survive Ctrl+C). The title makes the window easy to find/close. ---
$backendCmd = "`$host.UI.RawUI.WindowTitle='MAS Backend (Ctrl+C to stop)'; " +
              "Set-Location '$BackendDir'; " +
              "& '$VenvPython' -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
$backend = Start-Process powershell `
    -ArgumentList "-NoExit", "-Command", $backendCmd `
    -PassThru

# --- Frontend window: vite dev server ---
$frontendCmd = "`$host.UI.RawUI.WindowTitle='MAS Frontend (Ctrl+C to stop)'; " +
               "Set-Location '$FrontendDir'; " +
               "npm run dev"
$frontend = Start-Process powershell `
    -ArgumentList "-NoExit", "-Command", $frontendCmd `
    -PassThru

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
    Write-Host "Check the 'MAS Frontend' window for errors, then open http://localhost:5173/ manually." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "App URL: http://localhost:5173/   (use http://, not https)" -ForegroundColor Cyan
Write-Host "To stop: press Ctrl+C in each window, or close them." -ForegroundColor Yellow
Write-Host ("To stop both from here:  Stop-Process -Id {0},{1} -Force" -f $backend.Id, $frontend.Id) -ForegroundColor DarkGray
