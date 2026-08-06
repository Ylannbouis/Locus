# Math Animation Studio (A Manim Wrapper)

**IMPORTANT DISCLAIMER**: This project was created almost entirely using AI. However, the tool itself does not use AI; any content you create is completely human-made.

This app is a GUI-driven 2D math animation editor that wraps Manim Community Edition. This tool is meant to be helpful for speeding up the creation of smaller animations. It lacks the many benefits of programmatic animations. For that, you'll have to export the code and write on it manually.

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

### Setup & launch (Windows)

```powershell
.\scripts\setup.ps1    # installs ffmpeg + MiKTeX via winget, venv, Manim, npm packages
.\scripts\start.ps1    # launches both dev servers, each in its own window
```

### Setup & launch (macOS / Linux)

```bash
bash scripts/setup.sh    # installs ffmpeg + MacTeX via Homebrew, venv, Manim, npm packages
bash scripts/start.sh    # launches both dev servers; Ctrl+C stops both
```

> On macOS the setup needs [Homebrew](https://brew.sh). MacTeX is large (~4 GB); the lighter
> BasicTeX works too but then needs `tlmgr install` for a few packages Manim uses. On Linux,
> install ffmpeg + a TeX distribution (TeX Live) with your package manager, then run
> `scripts/setup.sh` (it creates the venv and installs the Python/npm packages).

Then open **http://localhost:5173** in your browser.

## Project kinds: animation or slideshow

When you create a project you pick how its scenes are meant to be watched:

- **🎬 Animation** — the scenes form one continuous video. Exporting "all scenes" stitches
  them together (optionally with a crossfade).
- **🖥 Slideshow** — each scene is a **slide**. It plays, freezes on its last frame, and the
  next one starts when you click. Slides are never stitched. Exporting gives you a
  self-contained HTML deck (`index.html` + one mp4 per slide, zipped) that runs from a local
  file with no server, and **▶ Present** plays the deck straight from the editor. Keys in both
  players: `Space`/`→` next, `←` back, `R` replay the slide, `F` fullscreen. A slide can be set
  to **auto-advance** (⏩ on its tab) to roll into the next one without a click.

Everything else — objects, timeline, camera, voiceover — works the same in both kinds.

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
    ├── setup.ps1 / setup.sh     # Bootstrap (Windows / macOS-Linux)
    ├── start.ps1 / start.sh     # Launch both dev servers
    └── package.ps1 / package.sh # Build frontend for single-process serving
```

## Milestones

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Dev environment + project skeleton | ✓ Done |
| 1 | End-to-end pipeline (place objects → render MP4) | ✓ Done |
| 2 | Object catalog expansion | ✓ Done |
| 3 | Full animation system + timeline UI | ✓ Done |
| 4 | Math-specific features (equation morphing, plots) | ✓ Done |
| 5 | Camera system | ✓ Done |
| 6 | Multi-scene, export formats, packaging | ✓ Done |

## Save File Format

Projects are stored at `~/MathAnimStudio/projects/<id>/project.json`.
The JSON format is human-readable and diffable. See `backend/app/models/ir.py` for the full schema.
