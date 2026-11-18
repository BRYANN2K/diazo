/**
 * server/motionJobs.ts — render-job lifecycle for Motion Studio.
 *
 * Jobs are records, not a queue runner: the browser or the desktop claims
 * one via REST, reports progress, uploads the finished file — and every
 * transition broadcasts `render:progress` to the room so the whole canvas
 * sees the render advance. In-memory per canvas, write-through to
 * render_jobs; a job that stops heartbeating is released back to 'queued'
 * so another client can pick it up.
 */

import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import { EFFECT_COST_CAP } from '../shared/motionFx.ts'
import { isLayer, planLayers, sceneEffectBill } from '../shared/motionLayers.ts'
import type { ServerMessage } from '../shared/types.ts'
import {
  BLENDER_ENGINES,
  MOTION_LIMITS,
  RENDER_FORMATS,
  RENDER_TARGETS_MVP,
  type BlenderEngine,
  type Composition,
  type RenderJob,
} from '../shared/motion.ts'

/** a claim without a heartbeat for this long is released */
const CLAIM_TTL_MS = 10 * 60_000
/** finished jobs kept per canvas (the newest ones) */
const JOB_HISTORY = 50

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
let broadcast: Broadcast = () => {}

export function wireRenderJobs(b: Broadcast) {
  broadcast = b
}

const jobs = new Map<string, RenderJob>() // jobId -> job
const byCanvas = new Map<string, RenderJob[]>() // canvasId -> newest first

/** Fill from the boot hydrate; `interrupted` rows already read as failed. */
export function initRenderJobs(rows: Map<string, RenderJob[]>) {
  for (const [canvasId, list] of rows) {
    byCanvas.set(canvasId, list)
    for (const job of list) jobs.set(job.id, job)
  }
}

export function dropRenderJobs(canvasId: string) {
  for (const job of byCanvas.get(canvasId) ?? []) jobs.delete(job.id)
  byCanvas.delete(canvasId)
}

function expire(job: RenderJob): void {
  /* a claimed job whose heartbeat stopped goes back to the queue — the
     original claimant's next PATCH is told it lost the job */
  if (
    (job.status === 'rendering' || job.status === 'encoding') &&
    job.claimedAt != null &&
    Date.now() - job.claimedAt > CLAIM_TTL_MS
  ) {
    job.status = 'queued'
    job.claimedBy = undefined
    job.claimedAt = undefined
    job.updatedAt = Date.now()
    persist.saveRenderJob(job)
    broadcast(job.canvasId, { type: 'render:progress', job })
  }
}

export function getRenderJob(id: string): RenderJob | undefined {
  const job = jobs.get(id)
  if (job) expire(job)
  return job
}

export function listRenderJobs(canvasId: string): RenderJob[] {
  for (const job of byCanvas.get(canvasId) ?? []) expire(job)
  return byCanvas.get(canvasId) ?? []
}

export type CreateRenderJobInput = {
  composition: Composition
  format: string
  target: string
  engine?: string
  width?: number
  height?: number
  fps?: number
  range?: { start?: unknown; end?: unknown }
  by: { id: string; name: string }
}

export function createRenderJob(
  input: CreateRenderJobInput,
): { ok: true; job: RenderJob } | { ok: false; status: number; error: string; rule?: string } {
  const comp = input.composition
  if (typeof input.format !== 'string' || !(RENDER_FORMATS as readonly string[]).includes(input.format)) {
    return { ok: false, status: 400, error: `format must be one of ${RENDER_FORMATS.join(', ')}` }
  }
  const target = input.target ?? 'browser'
  if (typeof target !== 'string' || !(RENDER_TARGETS_MVP as readonly string[]).includes(target)) {
    return {
      ok: false,
      status: 400,
      error: `target must be one of ${RENDER_TARGETS_MVP.join(', ')}`,
    }
  }
  let engine: BlenderEngine | undefined
  if (target === 'blender') {
    engine = (input.engine ?? 'eevee') as BlenderEngine
    if (!BLENDER_ENGINES.includes(engine)) {
      return { ok: false, status: 400, error: `engine must be one of ${BLENDER_ENGINES.join(', ')}` }
    }
  } else if (input.engine !== undefined) {
    return { ok: false, status: 400, error: 'engine only applies to target blender' }
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  /* range fields default only when absent — a present-but-broken value
     (NaN, a string, Infinity) is a refused call, not a silent repair */
  const rangeField = (v: unknown, fallback: number): number | undefined =>
    v === undefined ? fallback : typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const start = rangeField(input.range?.start, 0)
  const end = rangeField(input.range?.end, comp.duration)
  if (
    start === undefined ||
    end === undefined ||
    !(start >= 0) ||
    !(end > start) ||
    end - start > MOTION_LIMITS.MAX_DURATION_S
  ) {
    return { ok: false, status: 400, error: 'range must satisfy 0 ≤ start < end ≤ duration' }
  }
  /* a film whose static layer plan already breaks a budget can never
     render right — refuse it here with the MO-15 text rather than letting
     a renderer find out mid-job (AC-9) */
  const layerFrameIds = [...new Set(comp.tracks.filter(isLayer).map((t) => t.frameId!))]
  const layerPlans =
    layerFrameIds.length > 0
      ? planLayers(
          comp,
          layerFrameIds.map((id) => ({ id })),
        )
      : []
  const breach = layerPlans.flatMap((p) => p.issues).find((i) => i.rule === 'MO-15' && i.severity === 'error')
  if (breach) return { ok: false, status: 400, error: breach.message, rule: breach.rule }
  if (target === 'server') {
    /* the phase-5 caps: short renders at background priority so the
       interactive gate always keeps a slot; mp4/gif need ffmpeg, which a
       server does not promise — the desktop keeps those formats */
    if (input.format !== 'webm' && input.format !== 'pngseq') {
      return { ok: false, status: 400, error: 'server renders emit webm or pngseq — mp4 and gif stay on the desktop' }
    }
    if (end - start > 60) return { ok: false, status: 400, error: 'server renders cap at 60 seconds' }
    const fpsCap = Math.round(num(input.fps, comp.fps))
    const wCap = Math.round(num(input.width, comp.width))
    const hCap = Math.round(num(input.height, comp.height))
    if (wCap > 1920 || hCap > 1080) return { ok: false, status: 400, error: 'server renders cap at 1080p' }
    if (fpsCap > 30) return { ok: false, status: 400, error: 'server renders cap at 30 fps' }
    /* a stack over the shared effect budget would hog the instance's GPU —
       the same cap check_scene reports as `cost_cap`, billed from the
       stacks that actually draw (suppressed element layers cost nothing) */
    const fxBill = sceneEffectBill(comp, layerPlans)
    if (fxBill > EFFECT_COST_CAP) {
      return {
        ok: false,
        status: 400,
        error: `the effect stack costs ${fxBill}, over the ${EFFECT_COST_CAP}-point render cap — trim or merge effects`,
      }
    }
    for (const list of byCanvas.values()) {
      const open = list.find(
        (j) =>
          j.target === 'server' &&
          j.createdBy === input.by.id &&
          (j.status === 'queued' || j.status === 'rendering' || j.status === 'encoding'),
      )
      if (open) return { ok: false, status: 429, error: 'one server render at a time — let the open one finish' }
    }
  }
  const width = Math.round(num(input.width, comp.width))
  const height = Math.round(num(input.height, comp.height))
  const fps = Math.round(num(input.fps, comp.fps))
  if (
    width < MOTION_LIMITS.MIN_SIZE ||
    width > MOTION_LIMITS.MAX_SIZE ||
    height < MOTION_LIMITS.MIN_SIZE ||
    height > MOTION_LIMITS.MAX_SIZE
  ) {
    return {
      ok: false,
      status: 400,
      error: `width/height must be in [${MOTION_LIMITS.MIN_SIZE}, ${MOTION_LIMITS.MAX_SIZE}]`,
    }
  }
  if (fps < MOTION_LIMITS.MIN_FPS || fps > MOTION_LIMITS.MAX_FPS) {
    return { ok: false, status: 400, error: `fps must be in [${MOTION_LIMITS.MIN_FPS}, ${MOTION_LIMITS.MAX_FPS}]` }
  }
  const active = listRenderJobs(comp.canvasId).filter(
    (j) => j.status === 'queued' || j.status === 'rendering' || j.status === 'encoding',
  )
  if (active.length >= MOTION_LIMITS.MAX_ACTIVE_JOBS) {
    return {
      ok: false,
      status: 429,
      error: `at most ${MOTION_LIMITS.MAX_ACTIVE_JOBS} open render jobs per canvas — finish or cancel one first`,
    }
  }
  const now = Date.now()
  const job: RenderJob = {
    id: nanoid(12),
    canvasId: comp.canvasId,
    pageId: comp.pageId,
    compositionId: comp.id,
    format: input.format as RenderJob['format'],
    target: target as RenderJob['target'],
    engine,
    width,
    height,
    fps,
    range: { start, end: Math.min(end, comp.duration) },
    status: 'queued',
    progress: 0,
    createdBy: input.by.id,
    createdByName: input.by.name,
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  const list = byCanvas.get(comp.canvasId) ?? []
  byCanvas.set(comp.canvasId, [job, ...list])
  pruneHistory(comp.canvasId)
  persist.saveRenderJob(job)
  broadcast(comp.canvasId, { type: 'render:progress', job })
  return { ok: true, job }
}

function pruneHistory(canvasId: string) {
  const list = byCanvas.get(canvasId) ?? []
  const finished = list.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled')
  for (const job of finished.slice(JOB_HISTORY)) {
    jobs.delete(job.id)
    list.splice(list.indexOf(job), 1)
    persist.deleteRenderJob(job.id)
  }
}

/**
 * The renderer's heartbeat: claim (`rendering`/`encoding`), report
 * `progress`, or end it (`failed`; `canceled` via DELETE). `done` is only
 * set by the upload path. Returns the updated job, an error to answer, or
 * 'notfound' when the id is unknown.
 */
export function patchRenderJob(
  job: RenderJob,
  patch: { status?: string; progress?: number; error?: string; claimedBy?: string },
  claimant: string,
): { ok: true; job: RenderJob } | { ok: false; status: number; error: string } {
  const { status } = patch
  if (
    status !== undefined &&
    status !== 'rendering' &&
    status !== 'encoding' &&
    status !== 'failed' &&
    status !== 'canceled'
  ) {
    return {
      ok: false,
      status: 400,
      error: 'status must be rendering, encoding, failed or canceled (done comes from the upload)',
    }
  }
  /* someone else owns the claim: only its heartbeat or an explicit
     cancel/failed may move it */
  if (
    (job.status === 'rendering' || job.status === 'encoding') &&
    job.claimedBy &&
    job.claimedBy !== claimant &&
    status !== 'canceled' &&
    status !== 'failed'
  ) {
    return { ok: false, status: 409, error: 'another client claimed this render — it is no longer yours' }
  }
  if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
    return { ok: false, status: 409, error: `the job is already ${job.status}` }
  }
  if (status === 'rendering' || status === 'encoding') {
    job.status = status
    job.claimedBy = patch.claimedBy ?? claimant
    job.claimedAt = Date.now()
  }
  if (patch.progress !== undefined) {
    if (typeof patch.progress !== 'number' || !(patch.progress >= 0) || patch.progress > 1) {
      return { ok: false, status: 400, error: 'progress must be a number in [0, 1]' }
    }
    job.progress = patch.progress
    job.claimedAt = Date.now()
  }
  if (patch.error !== undefined) {
    if (typeof patch.error !== 'string' || patch.error.length > 500)
      return { ok: false, status: 400, error: 'error must be a short string' }
    job.error = patch.error || undefined
  }
  if (status === 'failed' || status === 'canceled') {
    job.status = status
    if (status === 'failed' && !job.error) job.error = 'render failed'
    job.finishedAt = Date.now()
  }
  job.updatedAt = Date.now()
  persist.saveRenderJob(job)
  broadcast(job.canvasId, { type: 'render:progress', job })
  return { ok: true, job }
}

/** The upload landed: store the asset id, mark the job done. */
export function finishRenderJob(job: RenderJob, outputAssetId: string): RenderJob {
  job.status = 'done'
  job.progress = 1
  job.outputAssetId = outputAssetId
  job.finishedAt = Date.now()
  job.updatedAt = job.finishedAt
  persist.saveRenderJob(job)
  broadcast(job.canvasId, { type: 'render:progress', job })
  return job
}

/** DELETE: cancel a live job; a finished one is removed from the list. */
export function cancelRenderJob(job: RenderJob): RenderJob {
  if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') {
    jobs.delete(job.id)
    const list = byCanvas.get(job.canvasId)
    if (list) list.splice(list.indexOf(job), 1)
    persist.deleteRenderJob(job.id)
    return job
  }
  job.status = 'canceled'
  job.finishedAt = Date.now()
  job.updatedAt = job.finishedAt
  persist.saveRenderJob(job)
  broadcast(job.canvasId, { type: 'render:progress', job })
  return job
}
