# Components — shell, panels, modals

| File | Role |
|------|------|
| `DepGate.tsx` | Blocks the app until `GET /api/system/deps` reports manim/ffmpeg/latex present (`POST /api/system/deps/refresh` re-checks). `sympy` is optional — its absence shows a banner, not a gate. |
| `ProjectHome.tsx` | Open / create / delete a project, including the animation-vs-slideshow **kind** picker. |
| `EditorShell.tsx` | Editor layout: topbar, Add panel, canvas, outliner, inspector, timeline, scene panel. |
| `AddPanel.tsx` | The Add Object buttons, grouped by category. |
| `ScenePanel.tsx` | Multi-scene (or multi-slide) list: add/delete/duplicate/reorder/inline-rename. |
| `RenderPanel.tsx` | Export options + job progress + download/preview. |
| `ProjectSettings.tsx` | The ⚙ project-wide settings modal (two tabs). |
| `ObjectDefaultsTab.tsx` | Second settings tab, driven by `store/objectDefaults.ts`. |
| `Presenter.tsx` | Fullscreen slideshow playback inside the editor. |
| `CodeView.tsx` | Read-only ejected Manim Python + project JSON. |
| `FontField.tsx` | The system-font `<select>` + its session-wide font cache. |

`App.tsx` is just `DepGate` → (`EditorShell` if a project is loaded, else `ProjectHome`).

**Deleting a project is confirmed and irreversible:** the per-row 🗑 in `ProjectHome` opens a
`.confirm-dialog` modal that must be confirmed before `DELETE /api/projects/{id}`, since deletion takes
the scenes, assets and renders with it and there is no undo.

**`FontField` is shared** by the Inspector (this object's font) and Settings → Object Defaults (what
new ones start as), so both draw on **one** module-level cache populated once per session from
`GET /api/fonts`. Keep it that way rather than re-fetching per picker — the backend scan is slow. The
empty option means "LaTeX", which is the default.

## Project settings (`ProjectSettings.tsx`)

Everything that belongs to the project rather than to one scene. **There is no Save button** — every
field writes straight through `updateMetadata` / `updateSettings`, so edits are live, undoable and
autosaved like any other mutation. All of them pass a `coalesceKey` (see `store/CLAUDE.md`), since
they're typed or dragged.

- **Project tab:** `metadata` (name / author / description), the background colour, the render
  defaults, and a read-only About block.
- **Background** is `settings.background_color`, and it is genuinely project-wide: `CanvasStage` and
  the codegen (`scene.py`) both resolve
  `scene.background_color || settings.background_color || '#000000'`. A scene-level override therefore
  *beats* the project colour, so the dialog lists any scene that has one with a per-scene Reset and a
  "Clear all overrides" — without that the setting would silently do nothing on those scenes. (Nothing
  in the editor sets a scene override today; they arrive via hand-edited JSON or
  `duplicateSceneFinal`, which copies its source's.)
- **Light backgrounds** flip editor chrome drawn *over* the scene: `isLightColor` (`util/color.ts`)
  switches the camera-frame guide to a dark dash, and the dialog warns that objects left at the
  default white stroke/fill will be invisible. Keep new canvas overlays on that helper.
- **Object Defaults tab** — see `store/CLAUDE.md` for the sparse-override rules. Field kinds are
  `color` / `number` / `check` / `font` (the last reuses `FontField`, so Text can default to a Pango
  system font — which also means new Text objects arrive eligible for the **Type On** verb). Setting a
  field to `undefined` *clears* that one override and drops the entry once it's empty; the font picker
  uses this so choosing "LaTeX (default)" returns to the built-in instead of pinning a redundant
  override that would show a misleading "customised" dot.
- **Render defaults** (`default_resolution` / `default_fps` / `transparent_background`) seed the
  `RenderPanel`. That panel stays mounted for as long as the project is open, so it **can't** read them
  in `useState` initialisers — it holds each as `null = follow the default` and only stores a value once
  the user picks one there. So editing a default shows up immediately, while an ad-hoc choice made in
  the Export panel still wins for the rest of the session.

## Scenes & export

- `ScenePanel` drives `addScene` / `removeScene` / `duplicateScene` / `duplicateSceneFinal` /
  `moveScene` / `renameScene`. `selectedSceneId` is the active scene; **always keep ≥ 1 scene.**
- `RenderPanel` builds a `RenderOptions` (format mp4/gif/png/still/slideshow, resolution preset, fps,
  transparent, crossfade) and calls `renderStore.triggerRender(projectId, sceneId|null, opts)` —
  **`sceneId === null` renders & stitches all scenes** (mp4 only; the panel disables "all scenes" for
  other formats). Quality derives from resolution (480p → `preview`, else `final`). The download
  extension and preview element adapt to the job's `format` (mp4 → `<video>`, gif/still → `<img>`,
  png → zip download).
- `CodeView` shows the ejected Manim Python (`getSceneScript`, which saves first so the backend sees
  the latest IR) and the project JSON, read-only. **The JSON is the source of truth; code export is
  one-way.**

## Slideshow (`Presenter.tsx`)

`project.kind` (`'animation' | 'slideshow'`, picked in `ProjectHome`, immutable afterwards) only
changes wording and export — the scene/timeline editor is identical. In a slideshow a scene *is* a
slide: `ScenePanel` says "Slides"/"+ Slide", `addScene` names them `Slide N`, and each tab gets a ⏩
toggle for `scene.auto_advance`. `RenderPanel` leads with the `slideshow` format, which always renders
every slide (`sceneId === null`) and never stitches or crossfades; other formats still export the
*current* slide. When the job finishes, **▶ Present** opens `Presenter`.

`Presenter` streams rendered slides from `/api/render/{job}/slides` (`getSlideManifest`) into one
`<video>` per slide, and is a **deliberate mirror of the exported HTML player** in
`backend/app/render/slideshow.py` — same keys (`Space`/`→` next, `←` back, `R` replay, `F` fullscreen),
same freeze-on-last-frame, same break handling. **Change both or they drift.**

- Stepping back seeks to `duration − 0.05` (the *last frame*, not a replay), which is why the backend
  slide route implements HTTP Range.
- **Break playback** (identical in both players): while a slide plays, a **rAF loop** watches
  `currentTime` against the next break and pauses exactly on it — `timeupdate` only fires ~4×/sec and
  overshoots visibly. A click then *resumes the same slide* rather than advancing (paused +
  not-at-the-end ⇒ resume, which also recovers from blocked autoplay); a click while playing jumps to
  the **next break** instead of the slide's end; `←` steps back to the previous break before leaving
  the slide.
- Neither player shows an on-screen "click to continue" prompt — a frozen slide is its own cue (the
  exported player keeps a no-op `showHint`, the Presenter keeps its `hint` state for the HUD's next
  button).
