import { previewWidthFor, type FramePreviewWidth } from '../../shared/framePreview'
import { loadThumb, MAX_TRIES, retryDelay, type ThumbLoad } from './thumbLoader'

/* The stage's frame images (frameLod.ts 'image'): the server's render of a
   frame at about its on-screen width, kept here decoded and ready, so a
   zoom-out shows every screen it showed before at once and a pan back over a
   frame never waits on the network. One entry per frame, the latest version
   at the widest width loaded; an edit (a new `updatedAt`) keeps showing the
   old picture until the new one is decoded. Requests go through
   `thumbLoader`: a few at a time, a busy renderer (503) or an over-budget
   viewer (429) asked again after its Retry-After. Nothing here reads or
   loads a frame's HTML. */

export type PreviewExt = 'jpg' | 'png'

export interface PreviewEntry {
  /** the frame's `updatedAt` the picture was asked for */
  version: number
  width: FramePreviewWidth
  ext: PreviewExt
  /** an object URL of the decoded picture */
  src: string
  /** the decoded bytes, for the cache's memory budget */
  bytes: number
  /** the element that decoded `src`, held so the <img> that shows it does
   *  not pay a second decode */
  image?: HTMLImageElement
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

/** Whether `entry` already answers `want`: the same version and format, at
 *  least as wide, and not a stand-in for a render still running. */
export function satisfies(entry: PreviewEntry | null | undefined, want: Omit<PreviewRequest, 'id'>): boolean {
  return (
    !!entry && entry.version === want.version && entry.ext === want.ext && entry.width >= want.width && !entry.stale
  )
}

/** Frames kept decoded. Beyond it the least recently shown go (their object
 *  URL revoked), never one a mounted frame is fetching or showing. */
export const MAX_PREVIEWS = 400
/** …and past this many decoded bytes the same eviction runs, whichever bound
 *  is hit first: a 128px tile is ~2 KB, a 1024px one of a tall page hundreds
 *  of KB, so a count alone does not bound memory. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024
/** How long a stale answer waits before the current render is asked again,
 *  and how many times. */
export const STALE_RETRY_MS = 4000
export const STALE_RETRIES = 3
/** A failed ask cools down this long before the same version is tried again:
 *  a 500 or a network blip is not a verdict for the session. */
export const FAILED_RETRY_MS = 30_000
/** `failed` and `staleTries` markers are pruned past this many entries, so a
 *  long session cannot grow them without bound. */
const MARKERS_MAX = 256

export interface DecodedPreview {
  src: string
  image?: HTMLImageElement
}

export interface PreviewDeps {
  load: (url: string, signal: AbortSignal) => Promise<ThumbLoad>
  /** turns the bytes into a URL an <img> paints without decoding on the main thread */
  decode: (blob: Blob) => Promise<DecodedPreview>
  revoke: (src: string) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  /** paint-adjacent batching: requestAnimationFrame in the browser */
  raf: (fn: () => void) => void
}

async function decodeInBrowser(blob: Blob): Promise<DecodedPreview> {
  const src = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    /* decoded off the main thread before it is ever shown, so 100 frames
       arriving at once do not stall a frame of the zoom; the element is
       kept on the entry so the <img> that shows the same URL reuses the
       decode rather than paying it again */
    await img.decode()
    return { src, image: img }
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
  raf: (fn) => requestAnimationFrame(fn),
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
  /** request keys that failed, and when — a blip earns another ask later */
  private failed = new Map<string, number>()
  /** stale answers taken per request key */
  private staleTries = new Map<string, number>()
  /** frames whose mounted image asked for a picture — eviction never drops
   *  what one of them could be showing */
  private holds = new Map<string, number>()
  /** decoded bytes held across `snapshots` */
  private bytes = 0
  /** ids changed since the last flush; listeners hear of them once a frame */
  private dirty = new Set<string>()
  private flushQueued = false

  constructor(
    private deps: PreviewDeps = browserDeps,
    private max = MAX_PREVIEWS,
    private maxBytes = MAX_PREVIEW_BYTES,
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
   *  already has it, or while this exact request cools down after a failure. */
  request(want: PreviewRequest): () => void {
    this.holds.set(want.id, (this.holds.get(want.id) ?? 0) + 1)
    let releaseJob: (() => void) | undefined
    const current = this.snapshots.get(want.id)
    if (satisfies(current?.entry, want)) {
      this.touch(want.id)
    } else {
      const key = `${want.id}:${want.version}:${want.width}:${want.ext}`
      const failedAt = this.failed.get(key)
      if (failedAt === undefined || Date.now() - failedAt >= FAILED_RETRY_MS) {
        this.failed.delete(key)
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
        const held = job
        held.holders++
        releaseJob = () => {
          held.holders--
          if (held.holders === 0) this.stop(held)
        }
      }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      releaseJob?.()
      this.unhold(want.id)
    }
  }

  /** Frames decoded now (tests and the bench). */
  size(): number {
    return this.snapshots.size
  }

  /** Decoded bytes held now (tests). */
  totalBytes(): number {
    return this.bytes
  }

  private unhold(id: string) {
    const left = (this.holds.get(id) ?? 1) - 1
    if (left > 0) {
      this.holds.set(id, left)
      return
    }
    this.holds.delete(id)
    this.evict()
    /* the frame left the screen: its failures and stale tries are worth
       another shot when it comes back */
    for (const key of this.failed.keys()) if (key.startsWith(`${id}:`)) this.failed.delete(key)
    for (const key of this.staleTries.keys()) if (key.startsWith(`${id}:`)) this.staleTries.delete(key)
  }

  private stop(job: Job) {
    job.abort.abort()
    this.deps.clearTimer(job.timer)
    this.staleTries.delete(job.key)
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
    let decoded: DecodedPreview
    try {
      decoded = await this.deps.decode(load.blob)
    } catch {
      return this.fail(job)
    }
    if (abort.signal.aborted) {
      this.deps.revoke(decoded.src)
      return
    }
    const previous = this.snapshots.get(want.id)?.entry
    /* a stale answer is still the closest picture there is, but it never
       replaces a current one */
    if (load.stale && previous && previous.version >= want.version && !previous.stale) {
      this.deps.revoke(decoded.src)
    } else {
      if (previous && previous.src !== decoded.src) this.deps.revoke(previous.src)
      this.set(want.id, {
        entry: {
          version: want.version,
          width: want.width,
          ext: want.ext,
          src: decoded.src,
          bytes: load.blob.size,
          image: decoded.image,
          stale: load.stale,
        },
        status: 'ready',
      })
    }
    const tries = this.staleTries.get(job.key) ?? 0
    if (load.stale && tries < STALE_RETRIES) {
      this.staleTries.set(job.key, tries + 1)
      this.prune(this.staleTries)
      job.timer = this.deps.setTimer(() => void this.run(job, 0), STALE_RETRY_MS)
      return
    }
    this.staleTries.delete(job.key)
    if (this.jobs.get(want.id) === job) this.jobs.delete(want.id)
  }

  private fail(job: Job) {
    this.failed.set(job.key, Date.now())
    this.prune(this.failed)
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
    const prev = this.snapshots.get(id)
    this.bytes += (snap.entry?.bytes ?? 0) - (prev?.entry?.bytes ?? 0)
    this.snapshots.delete(id)
    this.snapshots.set(id, snap)
    this.evict()
    this.notify(id)
  }

  private notify(id: string) {
    /* a burst of arrivals is one commit, not one per picture */
    this.dirty.add(id)
    if (this.flushQueued) return
    this.flushQueued = true
    this.deps.raf(() => {
      this.flushQueued = false
      const ids = this.dirty
      this.dirty = new Set()
      for (const id of ids) for (const listener of this.listeners.get(id) ?? []) listener()
    })
  }

  /* the least recently set or shown first, skipping what is being fetched
     or could be shown by a mounted frame */
  private evict() {
    if (this.snapshots.size <= this.max && this.bytes <= this.maxBytes) return
    for (const [id, snap] of this.snapshots) {
      if (this.snapshots.size <= this.max && this.bytes <= this.maxBytes) break
      if (this.holds.has(id) || this.jobs.has(id)) continue
      this.snapshots.delete(id)
      this.notify(id)
      this.bytes -= snap.entry?.bytes ?? 0
      if (snap.entry) this.deps.revoke(snap.entry.src)
    }
  }

  private prune<K>(map: Map<K, unknown>) {
    if (map.size <= MARKERS_MAX) return
    for (const key of [...map.keys()].slice(0, map.size - MARKERS_MAX)) map.delete(key)
  }
}

/** The page's one cache. */
export const framePreviews = new FramePreviewCache()
