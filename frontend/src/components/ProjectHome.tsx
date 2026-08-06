import { useEffect, useState } from 'react';
import type { ProjectKind, ProjectSummary } from '../types/ir';
import { createProject, getProject, getProjects } from '../api/client';
import { useProjectStore } from '../store/projectStore';

const KINDS: { value: ProjectKind; label: string; blurb: string }[] = [
  {
    value: 'animation',
    label: '🎬 Animation',
    blurb: 'Scenes play back-to-back as one continuous video.',
  },
  {
    value: 'slideshow',
    label: '🖥 Slideshow',
    blurb: 'Each scene is a slide: it plays, holds on its last frame, and you click for the next.',
  },
];

export function ProjectHome() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('animation');
  const [showForm, setShowForm] = useState(false);

  const setProject = useProjectStore(s => s.setProject);

  const load = async () => {
    setLoading(true);
    try { setProjects(await getProjects()); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleOpen = async (id: string) => {
    const p = await getProject(id);
    setProject(p);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const p = await createProject(newName.trim(), kind);
      setProject(p);
    } finally {
      setCreating(false);
      setShowForm(false);
      setNewName('');
    }
  };

  const closeForm = () => { setShowForm(false); setNewName(''); setKind('animation'); };

  return (
    <div className="project-home">
      <header className="project-home__header">
        <h1>Math Animation Studio</h1>
        <button className="btn btn--primary" onClick={() => setShowForm(true)}>
          + New Project
        </button>
      </header>

      {showForm && (
        <div className="project-home__create">
          <div className="project-home__kinds">
            {KINDS.map(k => (
              <button
                key={k.value}
                type="button"
                className={`kind-card ${kind === k.value ? 'is-active' : ''}`}
                onClick={() => setKind(k.value)}
              >
                <span className="kind-card__label">{k.label}</span>
                <span className="kind-card__blurb">{k.blurb}</span>
              </button>
            ))}
          </div>

          <div className="project-home__form">
            <input
              autoFocus
              type="text"
              placeholder={kind === 'slideshow' ? 'Slideshow name…' : 'Project name…'}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') closeForm(); }}
              className="project-home__input"
            />
            <button className="btn btn--primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button className="btn" onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="project-home__empty">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="project-home__empty">No projects yet. Create your first one above.</p>
      ) : (
        <ul className="project-home__list">
          {projects.map(p => (
            <li key={p.id} className="project-home__item" onClick={() => handleOpen(p.id)}>
              <span className="project-home__name">{p.name}</span>
              {p.kind === 'slideshow' && <span className="project-home__kind">Slideshow</span>}
              <span className="project-home__meta">
                {p.scene_count} {p.kind === 'slideshow' ? 'slide' : 'scene'}{p.scene_count !== 1 ? 's' : ''}
              </span>
              <span className="project-home__meta">{p.updated_at ? new Date(p.updated_at).toLocaleString() : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
