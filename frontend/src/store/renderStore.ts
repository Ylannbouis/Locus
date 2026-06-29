import { create } from 'zustand';
import type { RenderJob } from '../types/ir';
import { startRender, startMorphPreview, wsRenderUrl } from '../api/client';

interface RenderState {
  job: RenderJob | null;
  videoUrl: string | null;
  isRendering: boolean;
  triggerRender: (projectId: string, sceneId: string | null, quality: 'preview' | 'final') => Promise<void>;
  triggerMorphPreview: (projectId: string, sceneId: string, keyframeId: string) => Promise<void>;
  reset: () => void;
}

export const useRenderStore = create<RenderState>((set) => {
  // Shared: open the WS for a job and stream status into the store.
  const followJob = (job_id: string, initial: RenderJob) => {
    set({ job: initial });
    const ws = new WebSocket(wsRenderUrl(job_id));
    ws.onmessage = (evt) => {
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
    ws.onerror = () => set(s => ({
      job: s.job ? { ...s.job, status: 'error', message: 'WebSocket error' } : s.job,
      isRendering: false,
    }));
    ws.onclose = () => set(s => ({ isRendering: s.job?.status !== 'done' && s.job?.status !== 'error' ? false : s.isRendering }));
  };

  return {
    job: null,
    videoUrl: null,
    isRendering: false,

    reset: () => set({ job: null, videoUrl: null, isRendering: false }),

    triggerRender: async (projectId, sceneId, quality) => {
      set({ isRendering: true, videoUrl: null, job: null });
      const { job_id } = await startRender({ project_id: projectId, scene_id: sceneId, quality });
      followJob(job_id, { job_id, project_id: projectId, scene_id: sceneId, quality, status: 'queued', progress: 0, message: 'Queued…' });
    },

    triggerMorphPreview: async (projectId, sceneId, keyframeId) => {
      set({ isRendering: true, videoUrl: null, job: null });
      const { job_id } = await startMorphPreview(projectId, sceneId, keyframeId);
      followJob(job_id, { job_id, project_id: projectId, scene_id: sceneId, quality: 'preview', status: 'queued', progress: 0, message: 'Rendering morph preview…' });
    },
  };
});
