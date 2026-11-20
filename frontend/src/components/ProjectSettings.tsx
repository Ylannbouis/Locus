import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { isLightColor } from '../util/color';
import { ObjectDefaultsTab } from './ObjectDefaultsTab';
import type { ResolutionPreset } from '../types/ir';

type Tab = 'project' | 'objects';

// Backgrounds worth one click. Black is Manim's own default; the light two are
// there for print/handout exports (see the contrast hint below).
const SWATCHES: { hex: string; name: string }[] = [
  { hex: '#000000', name: 'Black (Manim default)' },
  { hex: '#1E1E1E', name: 'Charcoal' },
  { hex: '#0F172A', name: 'Midnight' },
  { hex: '#123524', name: 'Chalkboard' },
  { hex: '#FAF3E0', name: 'Cream' },
  { hex: '#FFFFFF', name: 'White' },
];

const RESOLUTIONS: ResolutionPreset[] = ['480p', '720p', '1080p', '4k'];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function ProjectSettings({ onClose }: { onClose: () => void }) {
  const project = useProjectStore(s => s.project);
  const updateMetadata = useProjectStore(s => s.updateMetadata);
  const updateSettings = useProjectStore(s => s.updateSettings);
  const setSceneBackground = useProjectStore(s => s.setSceneBackground);
  const clearSceneBackgrounds = useProjectStore(s => s.clearSceneBackgrounds);

  const bg = project?.settings.background_color ?? '#000000';

  // The hex box is free-typed, so it holds a draft while it's being edited —
  // half-typed input like "#12" must stay on screen without reaching the store.
  // `null` means "just show the real colour", so a swatch, the picker or an undo
  // shows up here with no syncing effect needed.
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('project');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!project) return null;

  const isSlideshow = project.kind === 'slideshow';
  const unit = isSlideshow ? 'slide' : 'scene';
  const overrides = project.scenes.filter(s => !!s.background_color);
  const lightBg = isLightColor(bg);

  const setHex = (v: string) => {
    setHexDraft(v);
    if (HEX_RE.test(v)) updateSettings({ background_color: v.toUpperCase() });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`settings-view${tab === 'objects' ? ' settings-view--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="settings-view__head">
          <h2 id="project-settings-title">Project Settings</h2>
          <div className="code-view__tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'project'}
              className={`code-view__tab ${tab === 'project' ? 'is-active' : ''}`}
              onClick={() => setTab('project')}>Project</button>
            <button role="tab" aria-selected={tab === 'objects'}
              className={`code-view__tab ${tab === 'objects' ? 'is-active' : ''}`}
              onClick={() => setTab('objects')}>Object Defaults</button>
          </div>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="settings-view__body">
          {tab === 'objects' ? <ObjectDefaultsTab /> : <>
          {/* ---- Project ---------------------------------------------- */}
          <section className="settings-section">
            <h3 className="panel-title">Project</h3>
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                type="text"
                autoFocus
                value={project.metadata.name ?? ''}
                onChange={e => updateMetadata({ name: e.target.value })}
                // An empty name would show as a blank title everywhere and sort
                // oddly on the project list — fall back rather than allow it.
                onBlur={e => { if (!e.target.value.trim()) updateMetadata({ name: 'Untitled Project' }); }}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span className="field__label">Author</span>
                <input className="field__input" type="text" value={project.metadata.author ?? ''}
                  onChange={e => updateMetadata({ author: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field__label">Description</span>
              <textarea className="field__textarea" rows={2} value={project.metadata.description ?? ''}
                onChange={e => updateMetadata({ description: e.target.value })} />
            </label>
          </section>

          {/* ---- Background ------------------------------------------- */}
          <section className="settings-section">
            <h3 className="panel-title">Background</h3>
            <p className="panel-hint">
              Applies to every {unit} in the project, on the canvas and in the render.
            </p>
            <div className="settings-swatches">
              {SWATCHES.map(s => (
                <button
                  key={s.hex}
                  type="button"
                  title={s.name}
                  aria-label={s.name}
                  aria-pressed={bg.toUpperCase() === s.hex}
                  className={`settings-swatch${bg.toUpperCase() === s.hex ? ' is-active' : ''}`}
                  style={{ background: s.hex }}
                  onClick={() => updateSettings({ background_color: s.hex })}
                />
              ))}
            </div>
            <div className="field-row">
              <label className="field" style={{ flex: '0 0 64px' }}>
                <span className="field__label">Custom</span>
                <input className="field__color" type="color" value={bg}
                  onChange={e => updateSettings({ background_color: e.target.value.toUpperCase() })} />
              </label>
              <label className="field">
                <span className="field__label">Hex</span>
                <input
                  className="field__input"
                  type="text"
                  spellCheck={false}
                  value={hexDraft ?? bg}
                  onChange={e => setHex(e.target.value)}
                  onBlur={() => setHexDraft(null)}
                />
              </label>
            </div>

            {lightBg && (
              <p className="settings-view__warn">
                On a light background, objects left at the default white stroke/fill
                will be invisible — recolour them in the Inspector.
              </p>
            )}

            {overrides.length > 0 && (
              <div className="settings-overrides">
                <p className="panel-hint">
                  {overrides.length} {overrides.length === 1 ? `${unit} overrides` : `${unit}s override`} this
                  colour and won't change:
                </p>
                <ul className="settings-overrides__list">
                  {overrides.map(s => (
                    <li key={s.id} className="settings-overrides__row">
                      <span className="settings-swatch settings-swatch--sm" style={{ background: s.background_color! }} />
                      <span className="settings-overrides__name">{s.name}</span>
                      <button className="btn btn--ghost" onClick={() => setSceneBackground(s.id, null)}>Reset</button>
                    </li>
                  ))}
                </ul>
                <button className="btn" onClick={clearSceneBackgrounds}>Clear all overrides</button>
              </div>
            )}
          </section>

          {/* ---- Render defaults --------------------------------------- */}
          <section className="settings-section">
            <h3 className="panel-title">Render defaults</h3>
            <p className="panel-hint">Starting values for the Export panel — change them there per render.</p>
            <div className="field-row">
              <label className="field">
                <span className="field__label">Resolution</span>
                <select className="field__input" value={project.settings.default_resolution}
                  onChange={e => updateSettings({ default_resolution: e.target.value as ResolutionPreset })}>
                  {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field__label">FPS</span>
                <input className="field__input" type="number" min={1} max={120}
                  value={project.settings.default_fps}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateSettings({ default_fps: Math.min(120, Math.max(1, v)) });
                  }} />
              </label>
            </div>
            <label className="field field--check">
              <input type="checkbox" checked={project.settings.transparent_background}
                onChange={e => updateSettings({ transparent_background: e.target.checked })} />
              <span className="field__label" style={{ margin: 0 }}>
                Transparent background by default (GIF / PNG / still — MP4 can't carry alpha)
              </span>
            </label>
          </section>

          {/* ---- Animation ---------------------------------------------- */}
          <section className="settings-section">
            <h3 className="panel-title">Animation</h3>
            <label className="field field--check">
              <input type="checkbox" checked={!!project.settings.auto_intro}
                onChange={e => updateSettings({ auto_intro: e.target.checked })} />
              <span className="field__label" style={{ margin: 0 }}>
                Animate new objects in — each object you add gets a Write / Create / Fade In keyframe
                right after the scene's last animation (also toggled at the bottom of the Add panel)
              </span>
            </label>
          </section>

          {/* ---- About ------------------------------------------------- */}
          <section className="settings-section">
            <h3 className="panel-title">About</h3>
            <dl className="settings-about">
              <dt>Type</dt><dd>{isSlideshow ? 'Slideshow' : 'Animation'} (fixed at creation)</dd>
              <dt>{isSlideshow ? 'Slides' : 'Scenes'}</dt><dd>{project.scenes.length}</dd>
              <dt>Created</dt><dd>{fmtDate(project.created_at)}</dd>
              <dt>Last saved</dt><dd>{fmtDate(project.updated_at)}</dd>
              <dt>ID</dt><dd><code>{project.id}</code></dd>
            </dl>
          </section>
          </>}
        </div>

        <div className="settings-view__foot">
          <span className="panel-hint">Changes apply immediately and autosave.</span>
          <button className="btn btn--primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
