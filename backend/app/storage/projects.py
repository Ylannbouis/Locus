"""File-based project storage under ~/MathAnimStudio/projects/."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from app.models.ir import Project, ProjectSummary, Scene

PROJECTS_ROOT = Path.home() / "MathAnimStudio" / "projects"


def _project_dir(project_id: str) -> Path:
    return PROJECTS_ROOT / project_id


def _project_file(project_id: str) -> Path:
    return _project_dir(project_id) / "project.json"


def _renders_dir(project_id: str) -> Path:
    d = _project_dir(project_id) / "renders"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def list_projects() -> list[ProjectSummary]:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    summaries = []
    for d in sorted(PROJECTS_ROOT.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        f = d / "project.json"
        if not f.exists():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            summaries.append(ProjectSummary(
                id=data.get("id", d.name),
                name=data.get("metadata", {}).get("name", "Untitled"),
                updated_at=data.get("updated_at", ""),
                scene_count=len(data.get("scenes", [])),
            ))
        except Exception:
            continue
    return summaries


def create_project(name: str) -> Project:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    now = _now()
    project = Project(created_at=now, updated_at=now)
    project.metadata["name"] = name
    # Start with one empty scene
    project.scenes.append(Scene(name="Scene 1"))
    _project_dir(project.id).mkdir(parents=True, exist_ok=True)
    _renders_dir(project.id)
    _project_file(project.id).write_text(
        project.model_dump_json(indent=2), encoding="utf-8"
    )
    return project


def load_project(project_id: str) -> Project:
    f = _project_file(project_id)
    if not f.exists():
        raise FileNotFoundError(f"Project {project_id} not found")
    data = json.loads(f.read_text(encoding="utf-8"))
    return Project.model_validate(data)


def save_project(project: Project) -> Project:
    project.updated_at = _now()
    _project_dir(project.id).mkdir(parents=True, exist_ok=True)
    _renders_dir(project.id)
    _project_file(project.id).write_text(
        project.model_dump_json(indent=2), encoding="utf-8"
    )
    return project


def renders_dir(project_id: str) -> Path:
    return _renders_dir(project_id)


def assets_dir(project_id: str) -> Path:
    """Uploaded media (audio voiceovers) for a project."""
    d = _project_dir(project_id) / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d
