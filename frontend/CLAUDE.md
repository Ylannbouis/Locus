# Frontend — Vite + React + TypeScript editor

The visual editor. Holds the `Project` IR in Zustand stores, renders the scene on a Konva canvas
(shapes) with a KaTeX HTML overlay (equations), and talks to the backend over the Vite proxy.

Stack: React 19 + react-konva + zustand + immer + katex + axios. Dev server on **5173**
(`strictPort` — fails loudly rather than drifting to 5174). Scripts: `npm run dev` / `build`
(`tsc -b && vite build`) / `lint`.

## Layout (`src/`)

| Path | What | More |
|------|------|------|
| `types/ir.ts` | **TS mirror of `backend/app/models/ir.py`.** Keep in sync by hand — no codegen between them. (`SlideManifest`/`SlideInfo` mirror the slideshow manifest, not the IR.) | below |
| `store/` | Zustand state: the `Project`, undo/redo, autosave, selection, clipboards, object factories + per-project Object Defaults, final-state baking. | `src/store/CLAUDE.md` |
| `canvas/` | Konva stage + KaTeX overlay: coordinate model, scene rendering, direct manipulation, ghost previews, camera overlay. | `src/canvas/CLAUDE.md` |
| `timeline/` | Keyframe / camera / audio lanes, snapping, ripple-editing breaks, Web Audio preview. | `src/timeline/CLAUDE.md` |
| `components/` | Shell, panels and modals: `DepGate`, `ProjectHome`, `EditorShell`, `AddPanel`, `ScenePanel`, `RenderPanel`, `ProjectSettings`, `Presenter`, `CodeView`. | `src/components/CLAUDE.md` |
| `sim/sampling.ts` | The **sampling simulator** (CLT): seeded RNG, population presets, bin fitting, a run → `update_data` keyframes + a normal-curve expression. Pure; its UI is `inspector/SimulatorPanel.tsx` (in a histogram's Inspector). **All randomness happens here, at authoring time** — the IR stores plain numbers, so preview = render and a seed reproduces a run. | — |
| `inspector/Inspector.tsx` | Per-type property editors (right sidebar). With 2+ objects selected it hands over to `MultiInspector.tsx`: align / distribute (equal gaps), plus shared stroke, fill / text colour, stroke width, fill opacity, font size and layer — "mixed" when values differ, every edit one undo step (`updateObjects`). | — |
| `outliner/Outliner.tsx` | Object tree: select, z-order, show/hide, delete, group/ungroup. | — |
| `api/client.ts` | Thin axios wrappers over the REST API + the WS URL helper. Calls same-origin `/api`, `/ws` (proxied). | — |
| `theme.ts` | UI theme (Chalkboard dark default / Paper & Ink light): `initTheme` (run in `main.tsx` before mount — no flash), `useTheme`, persisted in `localStorage` (`locus.theme`). `components/ThemeToggle.tsx` flips it. | below |
| `util/color.ts` | `parseHex` / `luminance` / `isLightColor` — shared by the canvas and the settings UI so overlays can flip on a light background. | — |

`App.tsx`: `DepGate` → (`EditorShell` if a project is loaded, else `ProjectHome`).

## The rules that cut across everything

Details live in the per-directory files above; these are the ones you can't work here without knowing.

- **`projectStore` is the source of truth** and mirrors the backend IR exactly. **All mutations go
  through `_mutate`** (snapshot → immer → history → autosave). Mutating `project` outside it breaks
  undo/redo and autosave. Anything driven by a drag or by typing must pass a `coalesceKey`, or one
  gesture becomes 100 undo entries and evicts the whole 50-deep stack.
- **Live gestures commit once.** Drag previews (canvas `groupDrag`/`endpointDrag`/`rotDrag`/`anchorDrag`,
  timeline drag state) live *outside* the store as component state and write on release — one undo entry
  per gesture. When clearing such an override alongside a store write, do both in one `flushSync` or the
  followers paint at `moved-position + stale-delta`.
- **One selection concept across two stores.** Selecting a scene object clears the timeline's keyframe /
  audio / break selection and vice-versa (`clearKf()`), because the right sidebar picks `Inspector` /
  `KeyframeInspector` / `AudioClipInspector` from what's selected.
- **The canvas mirrors the codegen by hand.** Equation alignment, LaTeX escaping, multi-line text,
  matrix scaling, baked `rotation`, tick-number formatting and rotation pivots all exist twice — in
  `canvas/` for the preview and in `backend/app/codegen/objects.py` for the render. **Change both**, or
  the preview quietly stops predicting the output. Same for `Presenter` vs the exported HTML player in
  `backend/app/render/slideshow.py`.
- **Previews are editor-only.** Ghosts, plot sampling and audio playback approximate the render; the
  backend codegen and ffmpeg are the truth. Never let preview state leak into the IR.

## Theming (`App.css` tokens + `theme.ts`)

Two themes, selected by `<html data-theme="chalkboard" | "paper">`: **Chalkboard** (default, dark,
Manim's palette — `--accent` is `BLUE_C`, danger `RED_C`, ok `GREEN_C`) and **Paper & Ink** (light,
warm paper, ink-blue accent, serif `--font-display` headings). Both are blocks of CSS custom properties
at the top of `App.css`, and **every colour in the stylesheet must be a token** — a literal hex looks
fine in one theme and breaks the other. Add a token to *both* blocks instead. Deliberate exceptions:
chrome drawn **over the canvas** (camera HUD, canvas toolbar, preview/record banners, `.canvas-empty`)
and the fullscreen **presenter** stay dark in both themes because they always sit on the scene; white
text on coloured keyframe/clip blocks; `VERB_META` colours (semantic, readable on both).

Buttons have three tiers: `.btn--primary` (one per area — solid accent, `--radius-primary`: 8px in
Chalkboard, a pill in Paper), `.btn--secondary` (tinted, borderless), `.btn--ghost` (no fill until
hover); plain `.btn` is a neutral fill. `.btn--danger` (solid) and `.btn--danger-ghost` for destructive
actions. Add-panel entries are icon tiles (`tile(icon, label)` in `AddPanel.tsx`; the glyph is
`aria-hidden`, so a button's accessible name is just its label).

## Where the editor's shape is decided

- **Add-panel button** → a factory in `store/objectFactory.ts`, an entry in `store/objectDefaults.ts`
  (or it silently opts out of Object Defaults), an `inspector/` editor, and a `canvas/` node.
- **Which verbs an object offers** → `timeline/timelineStore.ts` `timelineVerbsFor(obj)`, which takes
  the whole object so it can read props (Type On is Pango-`text`-only; images hide the drawing verbs).
- **Lane order = `scene.objects` order** = the order the codegen emits, which also breaks `z_index`
  ties. Dragging an object label reorders all three at once.

## When changing the IR

Edit **both** `types/ir.ts` and `backend/app/models/ir.py`, then update the relevant factory
(`store/objectFactory.ts`), inspector editor, and canvas node. New **props** need no backend schema
change (`props` is a free-form dict end-to-end) but still need a TS type + UI to be editable; a new prop
worth defaulting also wants a field in `store/objectDefaults.ts`.

Note the backend **drops unknown top-level fields on load** (Pydantic ignores extras), so adding one to
`ProjectSettings` in TS *without* adding it to `ir.py` means it round-trips to nothing — the editor looks
right until the next reload, then the setting is gone.
