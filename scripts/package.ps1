#Requires -Version 5.1
<#
.SYNOPSIS
  Package Locus for distribution (post-v1 skeleton).

  Step 1 (works today): build the frontend to frontend/dist. The backend then
  serves it at http://localhost:8000 (main.py mounts frontend/dist if present),
  so the whole app runs from a single uvicorn process — no Vite needed.

  Step 2 (skeleton): bundle the backend with PyInstaller into a single folder.
  This is left as a documented skeleton because Manim + LaTeX + ffmpeg are large
  external/runtime dependencies that a PyInstaller bundle must locate on the host
  rather than embed. See the notes at the bottom.

.EXAMPLE
  .\scripts\package.ps1            # build frontend + run the embedded-server check
  .\scripts\package.ps1 -PyInstaller   # also attempt the PyInstaller backend bundle
#>
param(
    [switch]$PyInstaller
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$FrontendDir = Join-Path $ProjectRoot "frontend"
$BackendDir  = Join-Path $ProjectRoot "backend"
$VenvPython  = Join-Path $BackendDir ".venv\Scripts\python.exe"

Write-Host "== Locus — package ==" -ForegroundColor Cyan

# --- Step 1: build the frontend ------------------------------------------------
Write-Host "Building frontend (vite build)..." -ForegroundColor Gray
Push-Location $FrontendDir
try {
    if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = "--use-system-ca" }  # TLS interception on this machine
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
} finally { Pop-Location }

$Dist = Join-Path $FrontendDir "dist"
if (Test-Path $Dist) {
    Write-Host "Frontend built -> $Dist" -ForegroundColor Green
    Write-Host "Run the single-process app with:" -ForegroundColor Gray
    Write-Host "  & '$VenvPython' -m uvicorn app.main:app --app-dir '$BackendDir' --port 8000" -ForegroundColor DarkGray
    Write-Host "  then open http://localhost:8000" -ForegroundColor DarkGray
} else {
    throw "expected build output at $Dist"
}

# --- Step 2 (skeleton): PyInstaller backend bundle -----------------------------
if ($PyInstaller) {
    Write-Host "Attempting PyInstaller backend bundle (experimental)..." -ForegroundColor Yellow
    & $VenvPython -m pip install pyinstaller
    # --collect-all manim is required so Manim's data files / plugins are bundled.
    & $VenvPython -m PyInstaller `
        --name Locus `
        --collect-all manim `
        --add-data "$Dist;frontend/dist" `
        (Join-Path $BackendDir "app\main.py")
    Write-Host "PyInstaller output in .\dist\Locus (if it succeeded)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Notes / TODO for a real installer:" -ForegroundColor Cyan
Write-Host "  - Manim renders by shelling out to 'python -m manim'; a frozen build must ship a" -ForegroundColor Gray
Write-Host "    Python+Manim runtime or detect a system one. worker.py uses sys.executable." -ForegroundColor Gray
Write-Host "  - LaTeX (MiKTeX) and ffmpeg stay external system deps (see scripts/setup.ps1)." -ForegroundColor Gray
Write-Host "  - Wrap the uvicorn server + a webview (e.g. pywebview) for a desktop window." -ForegroundColor Gray
