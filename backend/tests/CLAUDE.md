# Tests — codegen regression harnesses

Not pytest. Each file is a **standalone script** that builds IR scenes, generates the real Manim script
through the real codegen, executes it **in-process frame by frame** (stub file writer, 64×36
resolution, Cairo renderer) and asserts on what actually happened. Run them with the backend venv
python, from `backend/`:

```
.venv/bin/python tests/stress_groups.py [scenario ...]      # macOS/Linux
.venv\Scripts\python.exe tests\stress_groups.py             # Windows
```

Scenario names (keys of each file's `SCENARIOS` dict) limit the run to those cases; no args runs
everything. `stress_camera.py` also takes `--src`, which prints the generated script.

| File | Covers | Run it after changing |
|------|--------|-----------------------|
| `stress_groups.py` | 23 adversarial group/fade scenarios: per-object **visibility over time** plus final-frame pixels. | fade/transform emission, the hide-until-creation pass, `LocusFade`/`LocusApply`/`LocusIntro`, `_object_tracks`. |
| `stress_camera.py` | 6 scenarios sampling the real `self.camera.frame` (center + width) frame by frame across **both** emission models: three moves in one play, pan-only / zoom-only keyframes, initial framing, focus on a moved object, tracking. | `_camera_anim`, `_bake`, or how camera units are chained. |

These exist because the bugs they catch are invisible in the generated *text* — the script looks right
and renders wrong. Two locked-in examples:

- **`.animate` parks its target in the mobject's single `m.target` slot**, and a builder only becomes an
  Animation when the enclosing `AnimationGroup`/`Succession` is constructed — after every builder in the
  play exists. So N camera moves in one play all animated to the *last* keyframe's framing.
  `stress_camera.py` is the reason that stays fixed.
- **`FadeOut`'s cleanup resets the mobject to full visibility** after `scene.remove`, and every play
  wraps its mobjects in helper `Group`s that still reach group children — so faded objects popped back
  at the end of a play. `stress_groups.py` samples visibility per frame, which is the only way to see it.

Both import `build_body` / `render_script` directly (`sys.path` is prepended with `backend/`), so they
test the codegen, not the HTTP layer. They need `manim` and `numpy` importable — i.e. the venv, not a
bare interpreter. See `../app/codegen/CLAUDE.md` for what the emitted helpers are supposed to do.
