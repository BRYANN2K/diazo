/**
 * The thumbnail prewarm: after a library is (re)indexed, and at boot, the
 * thumbnails missing from storage are rendered in the background, so the
 * gallery finds pictures instead of asking the renderer for each tile.
 *
 * - One job per library; asking again while one runs runs it once more
 *   after it (the items may have changed).
 * - Items go in gallery order (the first pages first), then the rest.
 * - Which keys exist is asked of storage cheaply (no bytes) and remembered:
 *   keys carry the content, so one that exists stays valid. A job cut off
 *   by a restart starts again from what storage holds, which is resuming.
 * - Renders go at background priority, a few at a time across every
 *   library (`RENDER_BACKGROUND_CONCURRENCY`), the items of a frame
 *   together on one page; a busy renderer is waited out, never counted as a
 *   failure, and an interactive render (a person, an agent) always goes
 *   first in the gate.
 * - Memory stays flat: the items are the index rows already held, and each
 *   render reads one frame's HTML (`store.renderableFrame`).
 */
import type { LibraryItem, ThumbProgress } from '../shared/library.ts'
import { searchIndex } from '../shared/librarySearch.ts'
import { announceLibrary, getLibrary, setThumbProgress } from './libraries.ts'
import { indexFor, libraryItems } from './libraryIndex.ts'
import { RendererBusyError } from './renderBrowser.ts'
import { backgroundConcurrency, rendererAvailable } from './screenshot.ts'
import { renderThumbs, serverThumbDeps, thumbKey } from './libraryThumbs.ts'
import type { Actor } from '../shared/types.ts'

/** Items of one frame rendered on one page. */
export const BATCH = 8
/** Existence checks in flight at once. */
const CHECKS = 16
/** A busy renderer: wait this long, doubling up to the cap. */
const BUSY_WAIT_MS = 5_000
const BUSY_WAIT_MAX_MS = 60_000
/** A request coalesces with the ones that follow it this closely. */
export const PREWARM_DELAY_MS = 10_000

const SYSTEM: Actor = { name: 'Library previews', kind: 'agent', color: '#888888' }

export interface PrewarmDeps {
  available(): boolean
  isLibrary(canvasId: string): boolean
  /** the items to picture, most wanted first */
  items(canvasId: string): Promise<LibraryItem[]>
  has(key: string): Promise<boolean>
  /** one promise per item (renderThumbs at background priority) */
  render(items: LibraryItem[]): Promise<Buffer>[]
  /** renders in flight at once, across libraries */
  concurrency(): number
  progress(canvasId: string, progress: ThumbProgress | null): void
  finished(canvasId: string): void
  sleep(ms: number): Promise<void>
}

/** Families in gallery order (the first page first), then everything else
 *  the index holds that people may see. */
export async function galleryOrder(canvasId: string): Promise<LibraryItem[]> {
  const items = (await libraryItems(canvasId)).filter((item) => item.status !== 'hidden')
  const index = await indexFor(canvasId)
  if (!index) return items
  const first: LibraryItem[] = []
  for (let cursor: string | undefined = '0'; cursor !== undefined && first.length < 600;) {
    const page = searchIndex(index, '', { limit: 200, cursor })
    first.push(...page.hits.map((hit) => hit.item))
    cursor = page.cursor
  }
  const seen = new Set(first.map((item) => item.itemId))
  return [...first.filter((item) => item.status !== 'hidden'), ...items.filter((item) => !seen.has(item.itemId))]
}

const defaultDeps: PrewarmDeps = {
  available: () => rendererAvailable(),
  isLibrary: (canvasId) => !!getLibrary(canvasId),
  items: galleryOrder,
  has: (key) => serverThumbDeps.has(key),
  render: (items) => renderThumbs(items, 'background'),
  concurrency: () => backgroundConcurrency,
  progress: setThumbProgress,
  finished: (canvasId) => announceLibrary(canvasId, SYSTEM),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

let deps: PrewarmDeps = defaultDeps

/** For tests: prewarm with something else than the server. */
export function setPrewarmDeps(next: Partial<PrewarmDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

const jobs = new Map<string, Promise<void>>()
const again = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** keys known to exist, per library */
const ready = new Map<string, Set<string>>()
const progress = new Map<string, ThumbProgress>()

/* the render slots every library's job shares */
let slots = 0
const slotWaiters: (() => void)[] = []
async function takeSlot(): Promise<() => void> {
  while (slots >= deps.concurrency()) await new Promise<void>((resolve) => slotWaiters.push(resolve))
  slots++
  let released = false
  return () => {
    if (released) return
    released = true
    slots--
    slotWaiters.shift()?.()
  }
}

/** The prewarm's progress for a library, or null when it never ran. */
export function thumbProgress(canvasId: string): ThumbProgress | null {
  return progress.get(canvasId) ?? null
}

/** Whether a library's prewarm is running (tests). */
export function isPrewarming(canvasId: string): boolean {
  return jobs.has(canvasId)
}

/** Ask for a library's missing thumbnails, `delay` ms from now (requests
 *  close together run once). */
export function schedulePrewarm(canvasId: string, delay = PREWARM_DELAY_MS): void {
  clearTimeout(timers.get(canvasId))
  const timer = setTimeout(() => {
    timers.delete(canvasId)
    void prewarmLibrary(canvasId)
  }, delay)
  timer.unref?.()
  timers.set(canvasId, timer)
}

/** Render a library's missing thumbnails now. A call while its job runs
 *  runs the job once more after it. */
export function prewarmLibrary(canvasId: string): Promise<void> {
  const current = jobs.get(canvasId)
  if (current) {
    again.add(canvasId)
    return current
  }
  const job = run(canvasId)
    .catch((error: unknown) => console.error('[library-thumbs] prewarm stopped', canvasId, error))
    .finally(() => {
      jobs.delete(canvasId)
      if (again.delete(canvasId)) void prewarmLibrary(canvasId)
    })
  jobs.set(canvasId, job)
  return job
}

function publish(canvasId: string, state: ThumbProgress) {
  const copy = { ...state }
  progress.set(canvasId, copy)
  deps.progress(canvasId, copy)
}

/** The missing items, grouped by frame in order, at most BATCH per group. */
function batches(items: LibraryItem[]): LibraryItem[][] {
  const byFrame = new Map<string, LibraryItem[][]>()
  const out: LibraryItem[][] = []
  for (const item of items) {
    const groups = byFrame.get(item.frameId) ?? []
    let last = groups.at(-1)
    if (!last || last.length >= BATCH) {
      last = []
      groups.push(last)
      byFrame.set(item.frameId, groups)
      out.push(last)
    }
    last.push(item)
  }
  return out
}

async function missingOf(canvasId: string, items: LibraryItem[]): Promise<LibraryItem[]> {
  const known = ready.get(canvasId) ?? new Set<string>()
  ready.set(canvasId, known)
  const missing: LibraryItem[] = []
  for (let at = 0; at < items.length; at += CHECKS) {
    const chunk = items.slice(at, at + CHECKS)
    const found = await Promise.all(
      chunk.map(async (item) => {
        const key = thumbKey(item.canvasId, item)
        if (known.has(key)) return true
        const exists = await deps.has(key).catch(() => false)
        if (exists) known.add(key)
        return exists
      }),
    )
    chunk.forEach((item, n) => {
      if (!found[n]) missing.push(item)
    })
  }
  return missing
}

async function run(canvasId: string): Promise<void> {
  if (!deps.available() || !deps.isLibrary(canvasId)) return
  const items = await deps.items(canvasId)
  const missing = await missingOf(canvasId, items)
  const state: ThumbProgress = { ready: items.length - missing.length, total: items.length, running: !!missing.length }
  publish(canvasId, state)
  if (!missing.length) return
  const known = ready.get(canvasId)!
  const queue = batches(missing)
  let busyWait = BUSY_WAIT_MS

  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      if (!deps.isLibrary(canvasId)) return
      const release = await takeSlot()
      let busy = false
      try {
        /* a person may have asked for some of these since the scan */
        const todo = group.filter((item) => !known.has(thumbKey(item.canvasId, item)))
        const results = await Promise.allSettled(deps.render(todo))
        const retry: LibraryItem[] = []
        results.forEach((result, n) => {
          const item = todo[n]!
          if (result.status === 'fulfilled') {
            known.add(thumbKey(item.canvasId, item))
            state.ready++
          } else if (result.reason instanceof RendererBusyError) retry.push(item)
          else {
            state.failed = (state.failed ?? 0) + 1
            console.warn('[library-thumbs] could not render', item.itemId, result.reason)
          }
        })
        state.ready += group.length - todo.length
        if (retry.length) {
          busy = true
          queue.unshift(retry)
        }
      } finally {
        release()
      }
      publish(canvasId, state)
      if (busy) {
        await deps.sleep(busyWait)
        busyWait = Math.min(BUSY_WAIT_MAX_MS, busyWait * 2)
      } else busyWait = BUSY_WAIT_MS
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency()) }, worker))
  publish(canvasId, { ...state, running: false })
  deps.finished(canvasId)
}

/** At boot: every library whose index is built gets its missing
 *  thumbnails (a library still indexing gets them when its run ends). */
export function prewarmAtBoot(canvasIds: string[], delay = 30_000): void {
  canvasIds.forEach((canvasId, n) => schedulePrewarm(canvasId, delay + n * 1000))
}

/** For tests: forget every job, timer and known key. */
export function resetPrewarmForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  jobs.clear()
  again.clear()
  ready.clear()
  progress.clear()
  slots = 0
  slotWaiters.length = 0
}
