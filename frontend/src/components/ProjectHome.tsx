import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../types/ir';
import { createProject, getProject, getProjects } from '../api/client';
import { useProjectStore } from '../store/projectStore';

export function ProjectHome() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
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
      const p = await createProject(newName.trim());
      setProject(p);
    } finally {
      setCreating(false);
      setShowForm(false);
      setNewName('');
    }
  };

  return (
    <div className="project-home">
      <header className="project-home__header">
        <h1>Math Animation Studio</h1>
        <button className="btn btn--primary" onClick={() => setShowForm(true)}>
          + New Project
        </button>
      </header>

      {showForm && (
        <div className="project-home__form">
          <input
            autoFocus
            type="text"
            placeholder="Project name…"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowForm(false); }}
            className="project-home__input"
          />
          <button className="btn btn--primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button className="btn" onClick={() => { setShowForm(false); setNewName(''); }}>Cancel</button>
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
              <span className="project-home__meta">{p.scene_count} scene{p.scene_count !== 1 ? 's' : ''}</span>
              <span className="project-home__meta">{p.updated_at ? new Date(p.updated_at).toLocaleString() : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
