---
name: verify
description: Build, launch and drive Locus end-to-end to verify a change — starts backend + frontend dev servers, drives the editor GUI with Playwright, and inspects the saved IR / generated Manim script via the REST API.
---

# Verifying Locus changes end-to-end

## Launch (headless-friendly; don't use scripts/start.ps1 — it opens windows)

```powershell
# backend (from backend/):
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000   # background
# frontend (from frontend/):
npm run dev                                                       # background, port 5173 strict
# ready when both return 200:
#   http://localhost:8000/api/projects   and   http://localhost:5173/
```

## Drive the GUI (Playwright)

- Install `playwright` (npm) in a scratch dir — **set `NODE_OPTIONS=--use-system-ca`**
  (this machine has TLS interception; plain npm/downloads fail cert checks).
  Browsers live in `%LOCALAPPDATA%\ms-playwright`; run `npx playwright install chromium`
  if the package/browser revisions mismatch.
- Project home: `+ New Project` → fill `.project-home__input` → `Create`.
- Add objects via the Add-panel buttons (exact names: `▭ Rectangle`, `∑ Expression`,
  `△ Polygon`, …). New objects land at Manim (0,0) = canvas center and are auto-selected.
- **Canvas coordinates**: get `.canvas-stage` boundingBox; initial view scale
  `s = clamp(min(w/(14.2222*80), h/(8*80)) * 0.92, 0.2, 5)`; Manim (x,y) → page
  `(box.x + w/2 + x*80*s, box.y + h/2 − y*80*s)`. Holds until you wheel-zoom/pan.
- Konva shapes are canvas pixels — drive them with `page.mouse` at computed coords
  (drag = down/move/up). LaTeX/text/matrix objects are HTML in `.latex-overlay`
  (normal locators work). The Transformer rotate anchor sits 26 screen px above the
  selected node's bbox top-center.
- Inspector fields: `page.locator('label.field', { hasText: '<Label>' }).locator('input')`.

## Assert on the data, not just pixels

- Autosave is debounced **2s** — wait ~2.5s, then `GET /api/projects` (list) and
  `GET /api/projects/{id}` (full IR JSON) to assert committed props.
- `GET /api/projects/{id}/scenes/{scene_id}/script` returns the generated Manim
  python — grep it to verify codegen output without rendering.

## Cleanup

- Delete the scratch project: `DELETE /api/projects/{id}` (removes the whole dir), or remove
  `~\Locus\projects\<id>` by hand.
- Kill both servers (they were started in background; match on
  `uvicorn app.main` / `locus\frontend` command lines).
