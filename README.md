# Math Animation Studio

A GUI-driven 2D math animation editor that wraps Manim Community Edition.

## Architecture

```
frontend (React + Konva + KaTeX)   ←→   backend (FastAPI)
                                            ↓
                              Manim CE (subprocess) → MP4
```

The JSON scene model is the source of truth. A code generator transpiles it to a Manim Python script; the backend renders it asynchronously and streams progress over WebSocket.

## Quick Start

### Prerequisites

- Python ≥ 3.10
- Node.js ≥ 18
- MiKTeX (Windows) or TeX Live (Mac/Linux)
- ffmpeg

### Setup (Windows)

```powershell
.\scripts\setup.ps1
```

This installs missing dependencies (ffmpeg, MiKTeX via winget), creates the Python venv, installs Manim, and installs npm packages.

### Launch

```powershell
.\scripts\start.ps1
```

Then open **http://localhost:5173** in your browser.

## Project Structure

```
mas/
├── frontend/          # Vite + React + TypeScript
│   └── src/
│       ├── types/ir.ts          # TypeScript IR schema
│       ├── store/               # Zustand stores
│       ├── api/client.ts        # REST + WebSocket client
│       ├── components/          # DepGate, ProjectHome, EditorShell
│       ├── canvas/              # Konva stage (Phase 1)
│       ├── timeline/            # Timeline editor (Phase 1)
│       └── inspector/           # Property panel (Phase 1)
├── backend/           # FastAPI + Python
│   └── app/
│       ├── main.py              # App entry point + routes
│       ├── models/ir.py         # Pydantic IR models
│       ├── deps_check.py        # System dependency checker
│       ├── codegen/             # JSON IR → Manim Python (Phase 1)
│       ├── render/              # Async render queue + worker (Phase 1)
│       └── storage/projects.py  # File I/O
└── scripts/
    ├── setup.ps1     # Windows 10 bootstrap
    └── start.ps1     # Launch both dev servers
```

## Milestones

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Dev environment + project skeleton | ✓ Done |
| 1 | End-to-end pipeline (place objects → render MP4) | ✓ Done |
| 2 | Object catalog expansion | ✓ Done |
| 3 | Full animation system + timeline UI | Pending |
| 4 | Math-specific features (equation morphing, plots) | Pending |
| 5 | Camera system | Pending |
| 6 | Multi-scene, export formats, packaging | Pending |

## Save File Format

Projects are stored at `~/MathAnimStudio/projects/<id>/project.json`.
The JSON format is human-readable and diffable. See `backend/app/models/ir.py` for the full schema.
