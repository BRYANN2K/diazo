import { previewWidthFor, type FramePreviewWidth } from '../../shared/framePreview'
import { loadThumb, MAX_TRIES, retryDelay, type ThumbLoad } from './thumbLoader'

/* The stage's frame images (frameLod.ts 'image'): the server's render of a
   frame at about its on-screen width, kept here decoded and ready, so a
   zoom-out shows every screen it showed before at once and a pan back over a
   frame never waits on the network. One entry per frame, the latest version
   at the widest width loaded; an edit (a new `updatedAt`) keeps showing the
   old picture until the new one is decoded. Requests go through
   `thumbLoader`: a few at a time, a busy renderer (503) asked again after
   its Retry-After. Nothing here reads or loads a frame's HTML. */

export type PreviewExt = 'jpg' | 'png'

export interface PreviewEntry {
  /** the frame's `updatedAt` the picture was asked for */
  version: number
  width: FramePreviewWidth
  /** an object URL of the decoded picture */
  src: string
  /** the server sent an older render while drawing this version */
  stale: boolean
}

export interface PreviewSnapshot {
  entry: PreviewEntry | null
  /** `failed`: the server could not draw it (or stayed busy); the stage keeps
   *  its neutral fill and asks again for the next version */
  status: 'idle' | 'loading' | 'ready' | 'failed'
}

export interface PreviewRequest {
  id: string
  version: number
  width: FramePreviewWidth
  ext: PreviewExt
}

/** The URL of a frame's stage image. `v` makes each version its own URL, so
 *  the browser may keep it for good. */
export function framePreviewUrl({ id, version, width, ext }: PreviewRequest): string {
  return `/i/${id}.${ext}?lod=${width}&v=${version}`
}

/** The width to ask for a frame `frameWidth` design px wide at `zoom`, on a
 *  screen of `dpr` device pixels per CSS px. */
export function previewWidth(frameWidth: number, zoom: number, dpr = 1): FramePreviewWidth {
  return previewWidthFor(frameWidth * zoom * dpr)
}

/** Whether `entry` already answers `want`: the same version, at least as
 *  wide, and not a stand-in for a render still running. */
export function satisfies(entry: PreviewEntry | null | undefined, want: Omit<PreviewRequest, 'id' | 'ext'>): boolean {
  return !!entry && entry.version === want.version && entry.width >= want.width && !entry.stale
}

/** Frames kept decoded. Beyond it the least recently shown go (their object
 *  URL revoked), never one a mounted frame is showing. */
export const MAX_PREVIEWS = 400
/** How long a stale answer waits before the current render is asked again,
 *  and how many times. */
export const STALE_RETRY_MS = 4000
export const STALE_RETRIES = 3

export interface PreviewDeps {
  load: (url: string, signal: AbortSignal) => Promise<ThumbLoad>
  /** turns the bytes into a URL an <img> paints without decoding on the main thread */
  decode: (blob: Blob) => Promise<string>
  revoke: (src: string) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

async function decodeInBrowser(blob: Blob): Promise<string> {
  const src = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    /* decoded off the main thread before it is ever shown, so 100 frames
       arriving at once do not stall a frame of the zoom */
    await img.decode()
    return src
  } catch (error) {
    URL.revokeObjectURL(src)
    throw error
  }
}

const browserDeps: PreviewDeps = {
  load: loadThumb,
  decode: decodeInBrowser,
  revoke: (src) => URL.revokeObjectURL(src),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (timer) => window.clearTimeout(timer as number),
}

interface Job {
  key: string
  want: PreviewRequest
  /** components asking; the job stops when the last one lets go */
  holders: number
  abort: AbortController
  timer: unknown
}

const IDLE: PreviewSnapshot = { entry: null, status: 'idle' }

export class FramePreviewCache {
  private snapshots = new Map<string, PreviewSnapshot>()
  private listeners = new Map<string, Set<() => void>>()
  private jobs = new Map<string, Job>()
  /** request keys that failed, so a frame does not ask again and again */
  private failed = new Set<string>()
  /** stale answers taken per request key */
  private staleTries = new Map<string, number>()

  constructor(
    private deps: PreviewDeps = browserDeps,
    private max = MAX_PREVIEWS,
  ) {}

  snapshot = (id: string): PreviewSnapshot => this.snapshots.get(id) ?? IDLE

  subscribe = (id: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** Ask for `want`; returns the release. Nothing is fetched when the cache
   *  already has it, or when this exact request failed before. */
  request(want: PreviewRequest): () => void {
    const current = this.snapshots.get(want.id)
    if (satisfies(current?.entry, want)) {
      this.touch(want.id)
      return () => {}
    }
    const key = `${want.id}:${want.version}:${want.width}:${want.ext}`
    if (this.failed.has(key)) return () => {}
    let job = this.jobs.get(want.id)
    if (job && job.key !== key) {
      /* one job per frame: a newer version or a wider step replaces it */
      this.stop(job)
      job = undefined
    }
    if (!job) {
      job = { key, want, holders: 0, abort: new AbortController(), timer: null }
      this.jobs.set(want.id, job)
      this.set(want.id, { entry: current?.entry ?? null, status: 'loading' })
      void this.run(job, 0)
    }
    job.holders++
    const held = job
    let released = false
    return () => {
      if (released) return
      released = true
      held.holders--
      if (held.holders === 0) this.stop(held)
    }
  }

  /** Frames decoded now (tests and the bench). */
  size(): number {
    return this.snapshots.size
  }

  private stop(job: Job) {
    job.abort.abort()
    this.deps.clearTimer(job.timer)
    if (this.jobs.get(job.want.id) !== job) return
    this.jobs.delete(job.want.id)
    const snap = this.snapshots.get(job.want.id)
    if (snap?.status === 'loading') this.set(job.want.id, { entry: snap.entry, status: snap.entry ? 'ready' : 'idle' })
  }

  private async run(job: Job, attempt: number): Promise<void> {
    const { want, abort } = job
    let load: ThumbLoad
    try {
      load = await this.deps.load(framePreviewUrl(want), abort.signal)
    } catch {
      return /* aborted: the frame left the screen or changed */
    }
    if (abort.signal.aborted) return
    if (load.kind === 'busy') {
      if (attempt + 1 < MAX_TRIES) {
        job.timer = this.deps.setTimer(
          () => void this.run(job, attempt + 1),
          retryDelay(attempt + 1, load.retryAfterMs),
        )
        return
      }
      return this.fail(job)
    }
    if (load.kind === 'failed') return this.fail(job)
    let src: string
    try {
      src = await this.deps.decode(load.blob)
    } catch {
      return this.fail(job)
    }
    if (abort.signal.aborted) {
      this.deps.revoke(src)
      return
    }
    const previous = this.snapshots.get(want.id)?.entry
    /* a stale answer is still the closest picture there is, but it never
       replaces a current one */
    if (load.stale && previous && previous.version >= want.version && !previous.stale) {
      this.deps.revoke(src)
    } else {
      if (previous && previous.src !== src) this.deps.revoke(previous.src)
      this.set(want.id, {
        entry: { version: want.version, width: want.width, src, stale: load.stale },
        status: 'ready',
      })
    }
    const tries = this.staleTries.get(job.key) ?? 0
    if (load.stale && tries < STALE_RETRIES) {
      this.staleTries.set(job.key, tries + 1)
      job.timer = this.deps.setTimer(() => void this.run(job, 0), STALE_RETRY_MS)
      return
    }
    this.staleTries.delete(job.key)
    if (this.jobs.get(want.id) === job) this.jobs.delete(want.id)
  }

  private fail(job: Job) {
    this.failed.add(job.key)
    if (this.jobs.get(job.want.id) === job) this.jobs.delete(job.want.id)
    const entry = this.snapshots.get(job.want.id)?.entry ?? null
    this.set(job.want.id, { entry, status: entry ? 'ready' : 'failed' })
  }

  private touch(id: string) {
    const snap = this.snapshots.get(id)
    if (!snap) return
    this.snapshots.delete(id)
    this.snapshots.set(id, snap)
  }

  private set(id: string, snap: PreviewSnapshot) {
    this.snapshots.delete(id)
    this.snapshots.set(id, snap)
    this.evict()
    for (const listener of this.listeners.get(id) ?? []) listener()
  }

  /* the least recently set or shown first, skipping what is on the stage */
  private evict() {
    if (this.snapshots.size <= this.max) return
    for (const [id, snap] of this.snapshots) {
      if (this.snapshots.size <= this.max) break
      if (this.listeners.has(id) || this.jobs.has(id)) continue
      this.snapshots.delete(id)
      if (snap.entry) this.deps.revoke(snap.entry.src)
    }
  }
}

/** The page's one cache. */
export const framePreviews = new FramePreviewCache()
