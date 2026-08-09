# Planning Prompt — 2D Math Animation Studio (Manim CE wrapper)

I want to build a desktop/web app for creating animated math videos — think an interactive,
GUI-driven editor on top of Manim. This document is the brief. **Do not start writing application
code yet.** Your first job is to produce a written plan and a few design artifacts (listed at the
bottom under "Planning deliverables"). Once I've reviewed and approved the plan, we'll implement in
milestones.

---

## What we're building

A 2D math animation studio with three properties that are in tension, and resolving that tension is
the core design problem:

1. An **interactive, easy-to-understand UI** where I build animations visually (drag, click, set
   properties on a timeline) — not by writing code.
2. **Smooth, high-quality rendering** of LaTeX, shapes, and graphs, exported as video.
3. A workflow that goes **edit → preview → final render → download**.

I want to wrap **Manim** (the math animation engine) rather than build a renderer from scratch,
because its object/animation model already does the hard parts (LaTeX write-on, equation morphing,
smooth plotting). The GUI's job is to let me author scenes visually and drive Manim underneath.

---

## Recommended architecture (evaluate, then confirm or push back)

I'm leaning toward the pipeline below. In your plan, tell me whether you agree, and flag anything
you'd change.

```
Frontend (React + Canvas)         live editing, approximate real-time preview
        ⇅  (the scene model is synced between client and a local backend)
Scene model (JSON IR)             canonical source of truth = the save file
        ↓
Code generator                    transpiles the scene model into a Manim CE script
        ↓
Render queue + worker             async render jobs, progress streamed over WebSocket
        ↓
Manim CE (subprocess)             runs the generated script (requires LaTeX + ffmpeg)
        ↓
Video output                      preview (low quality) / final (high quality) → back to UI
```

Key decisions baked into this, with rationale:

- **Use Manim Community Edition (ManimCE), not ManimGL.** We're generating code against the library,
  so we need ManimCE's stable, documented API. ManimGL's API moves too much.
- **The JSON scene model is the single source of truth — not the generated Python.** The UI edits the
  scene model; the model *is* the save file; the code generator emits Manim Python as a one-way build
  artifact. Do **not** attempt to parse generated Python back into the editor. (See "eject to code"
  below for the one-way power-user escape hatch.)
- **The live preview is an approximation and that's fine.** Manim is an offline "code → render → file"
  pipeline; it can't drive a real-time canvas. So the editing canvas renders a *rough* version in real
  time (JS-side: shapes via a canvas lib, equations via KaTeX/MathJax, graphs via a JS plotting
  routine), and Manim is the source of truth only for final output. Do not try to make the live canvas
  pixel-identical to Manim — set that expectation in the UI instead.
- **Every render is an async job.** Manim renders take seconds to minutes, so a synchronous call would
  freeze the UI. Submit job → background worker runs Manim as a subprocess → stream progress over
  WebSocket → return the file. Use two quality tiers (Manim's fast preview flags vs. high-quality
  flags) and lean on Manim's partial-movie-file caching so unchanged scenes don't re-render.
- **System dependencies are the main packaging risk.** Manim needs a working LaTeX distribution
  (TeX Live / MiKTeX) and ffmpeg installed. Account for this in the plan.
- **Platform: default to a web frontend served on localhost for v1** (simplest — I run the Python env
  on my own machine), with an Electron-plus-Python-sidecar desktop build deferred to later. The
  architecture above is identical either way; only the shell changes. If you'd recommend a different
  default, say so and why.
- **"Eject to code" is a one-way feature:** a button that exports the generated Manim script for hand
  editing. We never round-trip edited Python back into the editor.

---

## Scope and constraints (important)

For this version, keep it tight:

- **2D only.** No 3D scenes, cameras, or objects.
- **No images.** No raster image import/placement. (Deferred to later.)
- **No audio or voiceover.** No sound, no narration, no audio-sync. (Deferred to later.)
- Also defer (call these out as explicitly out of scope for v1): real-time collaboration, plugin
  systems, and cloud rendering.

---

## Feature requirements

### Projects and scenes

- Create, open, and manage multiple **projects**.
- Within a project, create multiple **scenes**, each independently editable.
- **Scene reordering and duplication.**
- **Transitions between scenes.**
- A way to **stitch all of a project's scenes into one continuous video**.

### Save file format and persistence

- A defined, **JSON-based save file format** (the scene model is this format).
- **Autosave.**
- The format should be human-readable and diffable.

### Scene objects (the primitives I can place)

- **LaTeX / math text**, rendered cleanly, with smooth write-on.
- **Shapes**: rectangles, arrows, lines, circles, polygons, etc., with customizable render options.
- **Coordinate systems**: axes, number lines, polar coordinate systems, and grids.
- **Graphs / plotting**: function plots, parametric plots, implicit plots, and vector fields.
- **Geometry primitives**: vectors, angles, polygons — each with optional **labels**.
- **Matrices and tables.**

### Objects and styling

- **Grouping and nesting** of objects.
- **Relative positioning** — e.g. "place B to the right of A," "align B's center to A's center."
- **Alignment and snapping** while editing on the canvas.
- **Z-order / layers.**
- **Styling controls**: stroke width, fill, opacity, gradients, dashed lines, and **per-character
  coloring of equations** (color individual terms/symbols in a LaTeX expression).

### Animation system

This is the core. Build it around a **timeline with keyframes**.

- **Easing / interpolation functions** (selectable per animation).
- **Sequencing**: play animations **in parallel** or **in sequence**, with **delays** between them.
- **Per-object duration and timing control.**
- A set of **animation verbs**:
  - **Fade in / fade out**
  - **Write / draw-on** — drawing shapes and LaTeX **stroke by stroke**
  - **Transform / morph** one object into another
  - **Move / scale / rotate**
  - **Highlight**

### Math-specific power features

- **Equation morphing by matching shared terms** — transform one equation into another by matching
  common subexpressions (Manim's `TransformMatchingTex`). This is the single most important feature
  for math explainers; make it first-class.
- **Animating a curve being drawn**, and **sweeping a parameter** (e.g. animate a value driving a plot
  or geometric construction).
- Tight integration between the coordinate systems / plots above and the animation verbs (e.g. animate
  a function being drawn onto its axes).

### Camera

- Treat **pan, zoom, and focus as animatable actions**, not just a static viewport. Being able to
  animate the camera (push in on an equation, pan across a number line) is what makes math videos feel
  polished. The camera should have its own keyframeable track on the timeline.

### UI surfaces

- **Canvas** with pan and zoom (the main editing surface).
- **Outliner** — a list/tree of all objects in the scene.
- **Property inspector** — edit the selected object's properties.
- **Timeline editor** — arrange keyframes, durations, sequencing, and the camera track.
- Essentials: **undo/redo**, **copy/paste/duplicate**.
- Optional but desirable: a **code / JSON view** of the scene so it's scriptable and diffable.

### Preview and export

- Distinguish two paths clearly:
  - **Preview** — realtime, may drop frames, for fast iteration.
  - **Final render** — exact, queued as a job, with a **progress bar**.
- **Resolution presets** and configurable **frame rate**.
- **Transparent-background** export option.
- Output **formats**: **MP4** (primary), plus **GIF**, a **PNG sequence**, and a **single-frame still**.

---

## Planning deliverables (produce these before any code)

1. **Scene data model / JSON schema** — the canonical IR. Cover projects, scenes, objects and their
   properties, grouping/nesting, relative-position relationships, the timeline (keyframes, animation
   steps, sequencing, per-object timing, easing), the camera track, and styling. This is the most
   important artifact — everything else hangs off it.
2. **Codegen mapping** — a table showing how each scene-model concept maps to Manim CE (objects →
   Mobjects; timeline steps → `self.play(...)` with `run_time` / `rate_func`; parallel steps →
   `AnimationGroup` / `LaggedStart`; equation morph → `TransformMatchingTex`; camera moves → the
   relevant Manim camera API; etc.). Flag anything the GUI should expose that Manim can't cleanly do.
3. **Architecture decision record** — confirm or revise the pipeline above; pick the concrete tech
   stack (frontend framework + canvas lib, backend framework, job/queue approach, WebSocket layer);
   and give your localhost-vs-Electron recommendation with reasoning.
4. **System-dependency and packaging plan** — how LaTeX + ffmpeg + Manim get installed/bootstrapped,
   and what the v1 setup story looks like.
5. **MVP cut** — propose what ships first vs. later. (My instinct: first prove the spine end to end —
   place a couple of objects, put a fade and a write-on on a timeline, render an MP4 — before building
   out the full object/animation catalog. Adjust if you disagree.)
6. **Milestone breakdown** — an ordered implementation plan with rough phases.

Start with the plan. Ask me anything ambiguous before proposing the schema.
