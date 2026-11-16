import { req } from '../api'
import type { Composition, CompositionOp, RenderFormat, RenderJob, RenderTarget } from './contract'

/* The Motion Studio routes of docs/motion-api.md ("REST routes"). Writes
   carry the revision the editor last saw, so a timeline that moved under it
   answers 409 instead of being overwritten. */

const base = (canvasId: string, pageId: string) =>
  `/api/canvases/${encodeURIComponent(canvasId)}/pages/${encodeURIComponent(pageId)}/composition`

export const motionApi = {
  get: (canvasId: string, pageId: string) => req<{ composition: Composition | null }>(base(canvasId, pageId)),
  create: (
    canvasId: string,
    pageId: string,
    body: { duration: number; fps: number; width: number; height: number; expectedRevision?: number },
  ) => req<{ composition: Composition }>(base(canvasId, pageId), { method: 'PUT', body: JSON.stringify(body) }),
  patch: (canvasId: string, pageId: string, ops: CompositionOp[], expectedRevision?: number) =>
    req<{ composition: Composition }>(base(canvasId, pageId), {
      method: 'PATCH',
      body: JSON.stringify({ ops, expectedRevision }),
    }),
  remove: (canvasId: string, pageId: string) => req<{ ok: true }>(base(canvasId, pageId), { method: 'DELETE' }),
  listRenders: (canvasId: string, pageId: string) => req<{ jobs: RenderJob[] }>(`${base(canvasId, pageId)}/renders`),
  createRender: (
    canvasId: string,
    pageId: string,
    body: {
      format: RenderFormat
      target: RenderTarget
      width?: number
      height?: number
      fps?: number
      range?: { start: number; end: number }
    },
  ) => req<{ job: RenderJob }>(`${base(canvasId, pageId)}/renders`, { method: 'POST', body: JSON.stringify(body) }),
  updateRender: (
    jobId: string,
    body: {
      status?: 'rendering' | 'encoding' | 'failed' | 'canceled'
      progress?: number
      error?: string
      claimedBy?: string
    },
  ) =>
    req<{ job: RenderJob }>(`/api/renders/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  uploadRender: (jobId: string, video: Blob, format: RenderFormat) =>
    req<{ job: RenderJob; asset: { id: string; url: string } }>(`/api/renders/${encodeURIComponent(jobId)}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': format === 'mp4' ? 'video/mp4' : 'video/webm' },
      body: video,
    }),
  cancelRender: (jobId: string) =>
    req<{ job: RenderJob }>(`/api/renders/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
}
