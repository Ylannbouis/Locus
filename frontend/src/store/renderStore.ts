import { create } from 'zustand';
import type { RenderFormat, RenderJob, ResolutionPreset } from '../types/ir';
import { startRender, startMorphPreview, wsRenderUrl } from '../api/client';

export interface RenderOptions {
  quality: 'preview' | 'final';
  format?: RenderFormat;
  resolution?: ResolutionPreset | null;
  fps?: number | null;
  transparent?: boolean;
  transition?: boolean;
  range_start?: number | null;
  range_end?: number | null;
}

interface RenderState {
  job: RenderJob | null;
  videoUrl: string | null;
  isRendering: boolean;
  triggerRender: (projectId: string, sceneId: string | null, opts: RenderOptions) => Promise<void>;
  triggerMorphPreview: (projectId: string, sceneId: string, keyframeId: string) => Promise<void>;
  reset: () => void;
}

let activeWs: WebSocket | null = null;
let activeJobId: string | null = null;

function closeActiveWs() {
  if (!activeWs) return;
  activeWs.onmessage = null;
  activeWs.onerror = null;
  activeWs.onclose = null;
  activeWs.close();
  activeWs = null;
}

export const useRenderStore = create<RenderState>((set) => {
  const followJob = (job_id: string, initial: RenderJob) => {
    closeActiveWs();
    activeJobId = job_id;
    set({ job: initial });
    const ws = new WebSocket(wsRenderUrl(job_id));
    activeWs = ws;

    ws.onmessage = (evt) => {
      if (activeJobId !== job_id) return;
      try {
        const data = JSON.parse(evt.data);
        if (data.ping) return;
        set(s => ({
          job: s.job ? { ...s.job, ...data } : s.job,
          isRendering: data.status !== 'done' && data.status !== 'error',
          videoUrl: data.status === 'done' ? `/api/render/${job_id}/download` : s.videoUrl,
        }));
      } catch { /* ignore malformed frames */ }
    };
    ws.onerror = () => {
      if (activeJobId !== job_id) return;
      set(s => ({
        job: s.job ? { ...s.job, status: 'error', message: 'WebSocket error' } : s.job,
        isRendering: false,
      }));
    };
    ws.onclose = () => {
      if (activeJobId !== job_id) return;
      set(s => ({
        isRendering: s.job?.status !== 'done' && s.job?.status !== 'error' ? false : s.isRendering,
      }));
      if (activeWs === ws) activeWs = null;
    };
  };

  const launchJob = async (
    start: () => Promise<{ job_id: string }>,
    initial: RenderJob,
  ) => {
    set({ isRendering: true, videoUrl: null, job: null });
    try {
      const { job_id } = await start();
      followJob(job_id, { ...initial, job_id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Render failed';
      set({ isRendering: false, job: { ...initial, status: 'error', message } });
    }
  };

  return {
    job: null,
    videoUrl: null,
    isRendering: false,

    reset: () => {
      closeActiveWs();
      activeJobId = null;
      set({ job: null, videoUrl: null, isRendering: false });
    },

    triggerRender: (projectId, sceneId, opts) => launchJob(
      () => startRender({ project_id: projectId, scene_id: sceneId, ...opts }),
      {
        job_id: '',
        project_id: projectId,
        scene_id: sceneId,
        quality: opts.quality,
        format: opts.format,
        status: 'queued',
        progress: 0,
        message: 'Queued…',
      },
    ),

    triggerMorphPreview: (projectId, sceneId, keyframeId) => launchJob(
      () => startMorphPreview(projectId, sceneId, keyframeId),
      {
        job_id: '',
        project_id: projectId,
        scene_id: sceneId,
        quality: 'preview',
        status: 'queued',
        progress: 0,
        message: 'Rendering morph preview…',
      },
    ),
  };
});
