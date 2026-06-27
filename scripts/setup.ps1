#Requires -Version 5.1
<#
.SYNOPSIS
  Bootstrap Math Animation Studio on Windows 10.
  Installs missing system dependencies (MiKTeX, ffmpeg) and Python packages.
  Does NOT require elevated (admin) permissions.
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Python >= 3.10
# ---------------------------------------------------------------------------
Write-Step "Checking Python"
try {
    $pyVer = & python --version 2>&1
    $parts = ($pyVer -replace "Python ","").Split(".")
    if ([int]$parts[0] -lt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -lt 10)) {
        Write-Fail "Python 3.10+ required, found: $pyVer"
        Write-Host "  Install from https://www.python.org/downloads/ or run:"
        Write-Host "  winget install Python.Python.3.12"
        exit 1
    }
    Write-OK $pyVer
} catch {
    Write-Fail "Python not found. Install it: winget install Python.Python.3.12"
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Node.js >= 18
# ---------------------------------------------------------------------------
Write-Step "Checking Node.js"
try {
    $nodeVer = & node --version 2>&1
    $nodeMajor = [int]($nodeVer.TrimStart("v").Split(".")[0])
    if ($nodeMajor -lt 18) {
        Write-Fail "Node.js 18+ required, found: $nodeVer"
        Write-Host "  winget install OpenJS.NodeJS.LTS"
        exit 1
    }
    Write-OK "Node.js $nodeVer"
} catch {
    Write-Fail "Node.js not found. Install: winget install OpenJS.NodeJS.LTS"
    exit 1
}

# ---------------------------------------------------------------------------
# 2b. TLS / corporate-proxy handling for npm
#   Some machines run an HTTPS-intercepting proxy or antivirus that re-signs
#   traffic with a root CA trusted by Windows but NOT by Node's bundled CA
#   store. That makes `npm install` fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE
#   (and appear to hang on retries). Node 22.15+ can use the Windows cert
#   store via --use-system-ca, which fixes it.
# ---------------------------------------------------------------------------
Write-Step "Checking npm TLS to registry"
$nodeCanVerify = $false
try {
    & node -e "require('https').get('https://registry.npmjs.org/react',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))" 2>$null
    if ($LASTEXITCODE -eq 0) { $nodeCanVerify = $true }
} catch {}

if ($nodeCanVerify) {
    Write-OK "Node can verify the npm registry certificate"
} else {
    $nodeMinor = [int]($nodeVer.TrimStart("v").Split(".")[1])
    if ($nodeMajor -gt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -ge 15) -or $nodeMajor -ge 23) {
        $env:NODE_OPTIONS = "--use-system-ca"
        Write-Warn "TLS interception detected. Using Windows cert store (NODE_OPTIONS=--use-system-ca) for this session."
        Write-Host "  To make this permanent, set a user env var:"
        Write-Host "    setx NODE_OPTIONS `"--use-system-ca`""
    } else {
        Write-Warn "TLS interception detected and Node $nodeVer is too old for --use-system-ca (needs 22.15+)."
        Write-Host "  Export your proxy/antivirus root CA to a .pem and set:"
        Write-Host "    setx NODE_EXTRA_CA_CERTS `"C:\path\to\corp-root-ca.pem`""
    }
}

# ---------------------------------------------------------------------------
# 3. ffmpeg
# ---------------------------------------------------------------------------
Write-Step "Checking ffmpeg"
$ffmpegPath = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpegPath) {
    Write-Warn "ffmpeg not found. Installing via winget..."
    try {
        winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
        # Locate installed binary and add to user PATH
        $ffmpegDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
        if (Test-Path "$ffmpegDir\ffmpeg.exe") {
            $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
            if ($currentPath -notlike "*$ffmpegDir*") {
                [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$ffmpegDir", "User")
                $env:PATH = "$env:PATH;$ffmpegDir"
                Write-OK "Added ffmpeg to user PATH"
            }
        } else {
            Write-Warn "ffmpeg installed but binary location unclear."
            Write-Warn "If 'ffmpeg --version' fails, add its bin directory to your PATH manually."
        }
    } catch {
        Write-Fail "Could not install ffmpeg automatically: $_"
        Write-Host "  Download from https://ffmpeg.org/download.html and add to PATH."
        exit 1
    }
} else {
    Write-OK "ffmpeg found at $ffmpegPath"
}

# ---------------------------------------------------------------------------
# 4. MiKTeX (LaTeX)
# ---------------------------------------------------------------------------
Write-Step "Checking LaTeX (MiKTeX)"
$miktexPath = (Get-Command miktex -ErrorAction SilentlyContinue).Source
$pdflatexPath = (Get-Command pdflatex -ErrorAction SilentlyContinue).Source
if (-not $pdflatexPath) {
    Write-Warn "pdflatex not found. Installing MiKTeX via winget..."
    try {
        winget install --id MiKTeX.MiKTeX -e --accept-package-agreements --accept-source-agreements
        # Initialize MiKTeX package database
        $initCmd = Get-Command initexmf -ErrorAction SilentlyContinue
        if ($initCmd) {
            & initexmf --update-fndb 2>&1 | Out-Null
            Write-OK "MiKTeX installed and initialized"
        } else {
            Write-Warn "MiKTeX installed. You may need to restart your terminal for PATH changes to take effect."
        }
    } catch {
        Write-Fail "Could not install MiKTeX automatically: $_"
        Write-Host "  Download from https://miktex.org/download and install."
        exit 1
    }
} else {
    Write-OK "pdflatex found at $pdflatexPath"
}

# ---------------------------------------------------------------------------
# 5. Python virtual environment + Manim
# ---------------------------------------------------------------------------
Write-Step "Setting up Python virtual environment"
$venvPath = Join-Path $ProjectRoot "backend\.venv"
if (-not (Test-Path $venvPath)) {
    & python -m venv $venvPath
    Write-OK "Created venv at $venvPath"
} else {
    Write-OK "venv already exists"
}

$pip = Join-Path $venvPath "Scripts\pip.exe"
$python = Join-Path $venvPath "Scripts\python.exe"

Write-Step "Installing Python dependencies (this may take a few minutes)"
& $pip install --upgrade pip --quiet
& $pip install manim --quiet
& $pip install -r (Join-Path $ProjectRoot "backend\requirements.txt") --quiet
Write-OK "Python packages installed"

Write-Step "Verifying Manim"
try {
    $manimVer = & (Join-Path $venvPath "Scripts\manim.exe") --version 2>&1
    Write-OK "Manim: $manimVer"
} catch {
    Write-Fail "Manim verification failed: $_"
    exit 1
}

# ---------------------------------------------------------------------------
# 6. Frontend npm dependencies
# ---------------------------------------------------------------------------
Write-Step "Installing frontend npm dependencies"
Set-Location (Join-Path $ProjectRoot "frontend")
& npm install --silent
Write-OK "npm packages installed"

# ---------------------------------------------------------------------------
# 7. Write setup_result.json
# ---------------------------------------------------------------------------
$resultPath = Join-Path $ProjectRoot "setup_result.json"
$result = @{
    completed = $true
    timestamp = (Get-Date -Format "o")
} | ConvertTo-Json
Set-Content -Path $resultPath -Value $result -Encoding utf8
Write-OK "Setup result cached"

Write-Host "`n" -NoNewline
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Setup complete!  Run:  .\scripts\start.ps1" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
