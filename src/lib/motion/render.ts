import { motionApi } from './api'
import { paintAt, type FilmStage } from './compositor'
import type { Composition, RenderFormat, RenderJob } from './contract'

/* Rendering a film to a video file, on either path the contract names:
   `browser` paints every frame with the compositor and records the canvas
   with MediaRecorder; `desktop` hands the job to the shell (Tauri), which
   drives the render harness page frame by frame and encodes with ffmpeg.
   Both finish the same way: the bytes go to PUT /api/renders/:id/upload. */

export type RenderPhase = 'prepare' | 'capture' | 'encode' | 'upload'
export interface RenderProgress {
  phase: RenderPhase
  /** 0..1 within the whole render */
  progress: number
}

const MIME: Record<RenderFormat, string[]> = {
  mp4: ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4'],
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  /* MediaRecorder cannot write a gif or a stills zip — the desktop target
     claims those formats (ffmpeg palette pass / zip_store) */
  gif: [],
  pngseq: [],
}

/** the recorder type this browser can write for a format, if any */
export function browserMime(format: RenderFormat): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  return MIME[format].find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

/* ---- desktop shell ---- */

type Bridge = {
  __DOOP_MOTION_RENDER__?: unknown
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
    event: { listen: <T>(name: string, callback: (event: { payload: T }) => void) => Promise<() => void> }
  }
}
const bridge = globalThis as Bridge

/** whether this window is a desktop shell that advertises the render bridge */
export function hasDesktopRender(): boolean {
  return !!bridge.__DOOP_MOTION_RENDER__ && !!bridge.__TAURI__
}

function base64ToBlob(data: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type })
}

/** the page the shell loads to draw each frame (src/pages/MotionRenderHarness.tsx) */
export function harnessUrl(canvasId: string, pageId: string, start: number): string {
  const url = new URL(`/c/${encodeURIComponent(canvasId)}/motion-render`, window.location.origin)
  url.searchParams.set('page', pageId)
  if (start > 0) url.searchParams.set('start', String(start))
  return url.toString()
}

export async function renderOnDesktop(
  job: RenderJob,
  onProgress: (p: RenderProgress) => void,
): Promise<{ job: RenderJob; url: string }> {
  const tauri = bridge.__TAURI__
  if (!tauri || !hasDesktopRender()) throw new Error('This desktop app cannot render films yet. Update it.')
  const frames = Math.max(1, Math.round((job.range.end - job.range.start) * job.fps))
  await motionApi.updateRender(job.id, { status: 'rendering', progress: 0 })
  /* desktop/src-tauri/src/motion.rs: the driver seeks t = i / fps, the
     harness adds the range start; progress names the job as `job` */
  const unlisten = await tauri.event.listen<{
    job: string
    phase: 'capture' | 'encode'
    done: number
    total: number
  }>('motion-render://progress', ({ payload }) => {
    if (payload.job !== job.id) return
    const part = payload.total ? payload.done / payload.total : 0
    onProgress({
      phase: payload.phase,
      progress: payload.phase === 'capture' ? part * 0.85 : 0.85 + part * 0.1,
    })
  })
  try {
    const out = await tauri.core.invoke<{ path: string; bytes: number }>('motion_render', {
      jobId: job.id,
      url: harnessUrl(job.canvasId, job.pageId, job.range.start),
      format: job.format,
      fps: job.fps,
      frames,
      width: job.width,
      height: job.height,
    })
    await motionApi.updateRender(job.id, { status: 'encoding', progress: 0.95 })
    onProgress({ phase: 'upload', progress: 0.95 })
    const data = await tauri.core.invoke<string>('motion_read_render', { path: out.path })
    const video = base64ToBlob(data, job.format === 'mp4' ? 'video/mp4' : 'video/webm')
    const done = await motionApi.uploadRender(job.id, video, job.format)
    onProgress({ phase: 'upload', progress: 1 })
    return { job: done.job, url: done.asset.url }
  } catch (err) {
    await motionApi.updateRender(job.id, { status: 'failed', error: String(err) }).catch(() => {})
    throw err
  } finally {
    unlisten()
  }
}

/* ---- browser ---- */

export async function renderInBrowser(
  job: RenderJob,
  comp: Composition,
  stage: FilmStage,
  onProgress: (p: RenderProgress) => void,
  signal?: AbortSignal,
): Promise<{ job: RenderJob; url: string }> {
  const mime = browserMime(job.format)
  if (!mime) throw new Error(`This browser cannot record ${job.format.toUpperCase()}. Try the other format.`)
  const canvas = document.createElement('canvas')
  canvas.width = job.width
  canvas.height = job.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas in this browser.')
  /* the film is drawn at the job's size; the composition is scaled to it */
  const film: Composition = { ...comp, width: job.width, height: job.height }
  const scaled: FilmStage = {
    ...stage,
    fallback: { ...stage.fallback, zoom: stage.fallback.zoom * (job.width / comp.width) },
  }
  const zoomFactor = job.width / comp.width
  const scaledComp: Composition =
    zoomFactor === 1
      ? film
      : {
          ...film,
          tracks: film.tracks.map((track) =>
            track.kind !== 'camera'
              ? track
              : {
                  ...track,
                  keyframes: track.keyframes?.map((k) =>
                    k.property === 'zoom' && typeof k.value === 'number' ? { ...k, value: k.value * zoomFactor } : k,
                  ),
                },
          ),
        }

  const stream = canvas.captureStream(0)
  const [videoTrack] = stream.getVideoTracks()
  const requestFrame = (videoTrack as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame?.bind(videoTrack)
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))

  await motionApi.updateRender(job.id, { status: 'rendering', progress: 0 })
  const total = Math.max(1, Math.round((job.range.end - job.range.start) * job.fps))
  const frameMs = 1000 / job.fps
  await paintAt(ctx, scaledComp, scaled, job.range.start, signal)
  recorder.start()
  let lastBeat = 0
  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('canceled', 'AbortError')
      const t = job.range.start + i / job.fps
      const began = performance.now()
      await paintAt(ctx, scaledComp, scaled, t, signal)
      requestFrame?.()
      /* MediaRecorder timestamps frames by wall clock, so frames are paced at
         the film's rate; the picture itself only ever depends on t */
      /* a frame that took longer to paint than its slot stretches the
         recording; the desktop render has exact timing */
      await new Promise((r) => setTimeout(r, Math.max(0, frameMs - (performance.now() - began))))
      const progress = ((i + 1) / total) * 0.9
      onProgress({ phase: 'capture', progress })
      if (performance.now() - lastBeat > 1000) {
        lastBeat = performance.now()
        void motionApi.updateRender(job.id, { progress }).catch(() => {})
      }
    }
  } finally {
    recorder.stop()
    videoTrack?.stop()
  }
  await stopped
  if (signal?.aborted) {
    await motionApi.cancelRender(job.id).catch(() => {})
    throw new DOMException('canceled', 'AbortError')
  }
  await motionApi.updateRender(job.id, { status: 'encoding', progress: 0.92 })
  onProgress({ phase: 'upload', progress: 0.92 })
  const video = new Blob(chunks, { type: job.format === 'mp4' ? 'video/mp4' : 'video/webm' })
  try {
    const done = await motionApi.uploadRender(job.id, video, job.format)
    onProgress({ phase: 'upload', progress: 1 })
    return { job: done.job, url: done.asset.url }
  } catch (err) {
    await motionApi.updateRender(job.id, { status: 'failed', error: String(err) }).catch(() => {})
    throw err
  }
}
