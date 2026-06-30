import axios from 'axios';
import type { DepsResult, Project, ProjectSummary, RenderJob, RenderRequest } from '../types/ir';

// Vite dev proxy routes /api/* and /ws/* to http://localhost:8000
const http = axios.create({ baseURL: '' });

// Projects
export const getProjects = (): Promise<ProjectSummary[]> =>
  http.get('/api/projects').then(r => r.data);

export const createProject = (name: string): Promise<Project> =>
  http.post('/api/projects', { name }).then(r => r.data);

export const getProject = (id: string): Promise<Project> =>
  http.get(`/api/projects/${id}`).then(r => r.data);

export const saveProject = (project: Project): Promise<Project> =>
  http.put(`/api/projects/${project.id}`, project).then(r => r.data);

// Eject to code: the generated Manim script for one scene (one-way).
export const getSceneScript = (projectId: string, sceneId: string): Promise<string> =>
  http.get(`/api/projects/${projectId}/scenes/${sceneId}/script`).then(r => r.data.script);

// Deps
export const getDeps = (): Promise<DepsResult> =>
  http.get('/api/system/deps').then(r => r.data);

export const refreshDeps = (): Promise<DepsResult> =>
  http.post('/api/system/deps/refresh').then(r => r.data);

// Render
export const startRender = (req: RenderRequest): Promise<{ job_id: string }> =>
  http.post('/api/render', req).then(r => r.data);

export const startMorphPreview = (projectId: string, sceneId: string, keyframeId: string): Promise<{ job_id: string }> =>
  http.post('/api/render/morph-preview', { project_id: projectId, scene_id: sceneId, keyframe_id: keyframeId }).then(r => r.data);

export const getRenderStatus = (jobId: string): Promise<RenderJob> =>
  http.get(`/api/render/${jobId}`).then(r => r.data);

export const downloadUrl = (jobId: string): string =>
  `/api/render/${jobId}/download`;

// WebSocket — connect to Vite proxy which forwards to backend
export const wsRenderUrl = (jobId: string): string => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/render/${jobId}`;
};
