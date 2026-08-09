"""File-based project storage under ~/Locus/projects/."""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from app.models.ir import Project, ProjectKind, ProjectSummary, Scene

PROJECTS_ROOT = Path.home() / "Locus" / "projects"

# Projects lived under ~/MathAnimStudio before the app was renamed to Locus.
# Move that tree across once so an upgrade doesn't strand anyone's work.
_LEGACY_ROOT = Path.home() / "MathAnimStudio" / "projects"

# Ids come from `new_id()` (uuid slug); anything else is refused before it can be
# turned into a path — deletion is the one operation where traversal would hurt.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _migrate_legacy_root() -> None:
    """One-time move of the pre-rename projects dir. Never merges or overwrites:
    it only runs when the new root doesn't exist yet, and a failure is non-fatal
    (the app starts with an empty list rather than refusing to boot)."""
    if PROJECTS_ROOT.exists() or not _LEGACY_ROOT.is_dir():
        return
    try:
        PROJECTS_ROOT.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(_LEGACY_ROOT), str(PROJECTS_ROOT))
        print(f"[locus] moved projects from {_LEGACY_ROOT} to {PROJECTS_ROOT}")
        _LEGACY_ROOT.parent.rmdir()  # only succeeds if nothing else was in there
    except OSError:
        pass


_migrate_legacy_root()


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
    for d in PROJECTS_ROOT.iterdir():
        f = d / "project.json"
        if not f.exists():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            # Most-recently-edited first. `updated_at` is stamped on every save;
            # fall back to the JSON file's mtime for projects missing it. (The
            # directory's mtime is useless here — on Windows it only changes when
            # a direct child is created/removed, not when project.json is saved.)
            updated = data.get("updated_at") or datetime.fromtimestamp(
                f.stat().st_mtime, timezone.utc).isoformat()
            summaries.append(ProjectSummary(
                id=data.get("id", d.name),
                name=data.get("metadata", {}).get("name", "Untitled"),
                updated_at=updated,
                scene_count=len(data.get("scenes", [])),
                # Projects saved before slideshows existed have no `kind`.
                kind=data.get("kind") or ProjectKind.ANIMATION,
            ))
        except Exception:
            continue
    summaries.sort(key=lambda s: s.updated_at, reverse=True)
    return summaries


def create_project(name: str, kind: ProjectKind = ProjectKind.ANIMATION) -> Project:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    now = _now()
    project = Project(created_at=now, updated_at=now, kind=kind)
    project.metadata["name"] = name
    # Start with one empty scene ("slide" in a slideshow project)
    first = "Slide 1" if kind == ProjectKind.SLIDESHOW else "Scene 1"
    project.scenes.append(Scene(name=first))
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


def delete_project(project_id: str) -> None:
    """Delete a project's whole directory — JSON, uploaded assets and renders.

    Irreversible: there is no trash. Callers must confirm with the user first.
    """
    if not _ID_RE.match(project_id):
        raise ValueError(f"Invalid project id {project_id!r}")
    d = _project_dir(project_id)
    # Belt and braces on top of the id check: only ever remove a direct child of
    # the projects root, and only one that actually holds a project.
    if d.resolve().parent != PROJECTS_ROOT.resolve():
        raise ValueError(f"Refusing to delete {d} — outside the projects root")
    if not _project_file(project_id).exists():
        raise FileNotFoundError(f"Project {project_id} not found")
    shutil.rmtree(d)


def renders_dir(project_id: str) -> Path:
    return _renders_dir(project_id)


def assets_dir(project_id: str) -> Path:
    """Uploaded media (audio voiceovers, images) for a project."""
    d = _project_dir(project_id) / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d
