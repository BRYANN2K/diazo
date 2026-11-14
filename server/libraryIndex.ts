/**
 * The library indexer: keeps `library_items` in step with a library's
 * frames, and one search index per library in memory.
 *
 * - A full run walks the frames page by page in reading order, 50 at a time
 *   through `store.renderableFrame` (one frame's HTML, never the canvas), so
 *   memory stays flat; it records its progress and resumes after a restart.
 * - A frame write is reindexed alone, 1.5 s after the last write to it, and
 *   never while it streams.
 * - The search index is built from the rows on first use and dropped after
 *   ten idle minutes.
 */
import type { Actor, Frame } from '../shared/types.ts'
import {
  effectiveItem,
  type LibraryIndexState,
  type LibraryItem,
  type LibraryItemMeta,
  type RuleFinding,
} from '../shared/library.ts'
import { parentIdOf } from '../shared/libraryIds.ts'
import { sectionCategory } from '../shared/libraryRules.ts'
import { buildIndex, type LibraryIndex } from '../shared/librarySearch.ts'
import { readingOrder } from '../shared/frameOrder.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import { store, type FrameWrite } from './store.ts'
import { isFrameStreaming } from './actions.ts'
import { announceLibrary, getLibrary, onLibraryChange, setIndexState, type LibraryRecord } from './libraries.ts'
import { extractFrameItems, type ExtractedItem } from './libraryExtract.ts'

export const INDEX_BATCH = 50
export const FRAME_DEBOUNCE_MS = 1500
export const INDEX_IDLE_MS = 10 * 60 * 1000

const SYSTEM: Actor = { name: 'Library index', kind: 'agent', color: '#888888' }

/* ---- the in-memory index ---- */

interface Cache {
  /** the rows as stored */
  rows: LibraryItem[]
  meta: Map<string, LibraryItemMeta>
  index: LibraryIndex | null
  usedAt: number
}

const caches = new Map<string, Cache>()
const cacheLoads = new Map<string, Promise<Cache>>()

async function cacheFor(canvasId: string): Promise<Cache> {
  const cached = caches.get(canvasId)
  if (cached) {
    cached.usedAt = Date.now()
    return cached
  }
  let pending = cacheLoads.get(canvasId)
  if (!pending) {
    pending = (async () => {
      const [rows, meta] = await Promise.all([persist.loadLibraryItems(canvasId), persist.loadItemMeta(canvasId)])
      const cache: Cache = { rows, meta: new Map(meta.map((m) => [m.itemId, m])), index: null, usedAt: Date.now() }
      caches.set(canvasId, cache)
      return cache
    })().finally(() => cacheLoads.delete(canvasId))
    cacheLoads.set(canvasId, pending)
  }
  return pending
}

/** A library's items as people see them (curation over the rows). */
export async function libraryItems(canvasId: string): Promise<LibraryItem[]> {
  if (!getLibrary(canvasId)) return []
  const cache = await cacheFor(canvasId)
  return cache.rows.map((row) => effectiveItem(row, cache.meta.get(row.itemId)))
}

/** The search index of a library, built on first use. Null for a canvas
 *  that is not a library. */
export async function indexFor(canvasId: string): Promise<LibraryIndex | null> {
  const record = getLibrary(canvasId)
  if (!record) return null
  const cache = await cacheFor(canvasId)
  if (!cache.index) {
    const items = cache.rows.map((row) => effectiveItem(row, cache.meta.get(row.itemId)))
    cache.index = buildIndex(items, record.taxonomy)
  }
  return cache.index
}

/** One item's curation, kept in step with the database. */
export async function itemMeta(canvasId: string, itemId: string): Promise<LibraryItemMeta | undefined> {
  return (await cacheFor(canvasId)).meta.get(itemId)
}

/** Write one item's curation and patch the live index. */
export async function saveMeta(meta: LibraryItemMeta): Promise<void> {
  await persist.saveItemMeta(meta)
  const cache = caches.get(meta.canvasId)
  if (cache) {
    cache.meta.set(meta.itemId, meta)
    cache.index = null
  }
}

/** Forget a library's in-memory index (a rules change, a disable). */
export function dropIndex(canvasId: string): void {
  caches.delete(canvasId)
}

/** Drop the indexes nobody used for ten minutes. */
export function evictIdleIndexes(now = Date.now(), idleMs = INDEX_IDLE_MS): number {
  let dropped = 0
  for (const [canvasId, cache] of caches) {
    if (now - cache.usedAt < idleMs) continue
    caches.delete(canvasId)
    dropped++
  }
  return dropped
}

export function cachedIndexCount(): number {
  return caches.size
}

function patchCache(canvasId: string, frameId: string, rows: LibraryItem[]) {
  const cache = caches.get(canvasId)
  if (!cache) return
  const ids = new Set(rows.map((r) => r.itemId))
  cache.rows = [...cache.rows.filter((r) => r.frameId !== frameId && !ids.has(r.itemId)), ...rows]
  cache.index = null
}

/* ---- reading a library's frames ---- */

interface Placed {
  frame: Frame
  pageName: string
  /** the category the last section frame above it started */
  section: string | null
}

/** Every frame of the library in reading order, page by page, with the
 *  section category carried down each page. Reads names only. */
function framesInOrder(record: LibraryRecord): Placed[] {
  const canvas = store.getCanvas(record.canvasId)
  if (!canvas) return []
  const pages = canvasPages(canvas)
  const out: Placed[] = []
  for (const page of pages) {
    const onPage = canvas.frames.filter((f) => framePageId(canvas, f) === page.id && !f.demo)
    let section: string | null = null
    for (const frame of readingOrder(onPage)) {
      const started = sectionCategory(record.rules.detect.section, frame.name)
      if (started) section = started
      out.push({ frame, pageName: page.name, section: started ? null : section })
    }
  }
  return out
}

/** Give a frame's extracted items unique ids, revisions and the library's
 *  canvas. `taken` maps ids already used to the frame using them. */
function finalize(
  canvasId: string,
  frameId: string,
  extracted: ExtractedItem[],
  taken: Map<string, string>,
  previous: Map<string, LibraryItem>,
  now: number,
): LibraryItem[] {
  const renamed = new Map<string, string>()
  const out: LibraryItem[] = []
  for (const item of extracted) {
    let id = item.itemId
    const findings: RuleFinding[] = [...item.findings]
    const owner = taken.get(id.toLowerCase())
    if (owner !== undefined && owner !== frameId) {
      let n = 2
      while (taken.has(`${id}-${n}`.toLowerCase())) n++
      findings.push({ kind: 'id-collision', message: `The id ${id} is already used by another frame.`, itemId: id })
      renamed.set(id, `${id}-${n}`)
      id = `${id}-${n}`
    } else if (owner === frameId && out.some((o) => o.itemId.toLowerCase() === id.toLowerCase())) {
      let n = 2
      while (taken.has(`${id}-${n}`.toLowerCase())) n++
      id = `${id}-${n}`
    }
    taken.set(id.toLowerCase(), frameId)
    const parentId = item.parentId ? (renamed.get(item.parentId) ?? item.parentId) : null
    const prev = previous.get(id)
    const same = prev && prev.hash === item.hash
    out.push({
      ...item,
      itemId: id,
      parentId,
      findings,
      canvasId,
      rev: prev ? (same ? prev.rev : prev.rev + 1) : 1,
      box: same ? prev.box : item.box,
      indexedAt: same ? prev.indexedAt : now,
    })
  }
  return out
}

/** Exploded cards (frames yielding one plain item) join the longest family
 *  their id extends. Returns the rows whose parent changed. */
function resolveParents(rows: LibraryItem[]): LibraryItem[] {
  const perFrame = new Map<string, number>()
  for (const row of rows) perFrame.set(row.frameId, (perFrame.get(row.frameId) ?? 0) + 1)
  const cards = rows
    .filter((r) => perFrame.get(r.frameId) === 1 && !r.scripted)
    .sort((a, b) => a.itemId.length - b.itemId.length)
  const cardIds = new Set(cards.map((c) => c.itemId))
  const families = new Set(rows.filter((r) => !r.parentId && !cardIds.has(r.itemId)).map((r) => r.itemId))
  const changed: LibraryItem[] = []
  for (const card of cards) {
    const parent = parentIdOf(card.itemId, families)
    /* a card with no family can be one for the longer ids after it */
    if (!parent) families.add(card.itemId)
    if (parent !== card.parentId) changed.push({ ...card, parentId: parent })
  }
  return changed
}

function countsOf(rows: LibraryItem[]) {
  let items = 0
  let variants = 0
  for (const row of rows) {
    if (row.parentId) variants++
    else items++
  }
  return { items, variants }
}

function extract(record: LibraryRecord, placed: Placed, frame: Frame) {
  return extractFrameItems({
    frame: { ...frame, pageId: framePageId(store.getCanvas(record.canvasId)!, frame) },
    pageName: placed.pageName,
    sectionCategory: placed.section,
    rules: record.rules,
    taxonomy: record.taxonomy,
  })
}

/* ---- full runs ---- */

const running = new Map<string, Promise<void>>()
const rerun = new Set<string>()
/** frames written while a full run was going: indexed once it ends */
const afterRun = new Map<string, Set<string>>()

/** Reindex a whole library. A second call while one runs queues one more
 *  run after it. */
export function reindexLibrary(canvasId: string, opts: { resume?: boolean } = {}): Promise<void> {
  const current = running.get(canvasId)
  if (current) {
    rerun.add(canvasId)
    return current
  }
  const task = runFull(canvasId, !!opts.resume)
    .catch((error: unknown) => {
      /* the state stays `running`: the next boot resumes where it stopped */
      console.error('[library-index] full run stopped', canvasId, error)
    })
    .finally(() => {
      running.delete(canvasId)
      if (rerun.delete(canvasId)) void reindexLibrary(canvasId)
      else {
        const pending = afterRun.get(canvasId)
        afterRun.delete(canvasId)
        for (const frameId of pending ?? []) scheduleFrame(canvasId, frameId)
      }
    })
  running.set(canvasId, task)
  return task
}

export function isIndexing(canvasId: string): boolean {
  return running.has(canvasId)
}

async function runFull(canvasId: string, resume: boolean): Promise<void> {
  const record = getLibrary(canvasId)
  if (!record) return
  const order = framesInOrder(record)
  const previousRows = await persist.loadLibraryItems(canvasId)
  const previous = new Map(previousRows.map((row) => [row.itemId, row]))
  const was = record.indexState
  const start = resume && was?.status === 'running' ? Math.min(was.done, order.length) : 0
  const taken = new Map<string, string>()
  const doneFrames = new Set(order.slice(0, start).map((p) => p.frame.id))
  for (const row of previousRows) if (doneFrames.has(row.frameId)) taken.set(row.itemId.toLowerCase(), row.frameId)
  const now = Date.now()
  const state: LibraryIndexState = {
    status: 'running',
    total: order.length,
    done: start,
    rendered: resume ? (was?.rendered ?? 0) : 0,
    failed: resume ? (was?.failed ?? 0) : 0,
    startedAt: resume && was?.startedAt ? was.startedAt : now,
  }
  setIndexState(canvasId, { ...state })

  for (let at = start; at < order.length; at += INDEX_BATCH) {
    if (getLibrary(canvasId) !== record) return
    for (const placed of order.slice(at, at + INDEX_BATCH)) {
      const frame = await store.renderableFrame(placed.frame.id)
      if (!frame) continue
      let items: LibraryItem[]
      try {
        items = finalize(canvasId, frame.id, extract(record, placed, frame).items, taken, previous, now)
      } catch (error) {
        console.error('[library-index] a frame could not be read', frame.id, error)
        state.failed++
        continue
      }
      await persist.replaceFrameItems(canvasId, frame.id, items)
    }
    state.done = Math.min(order.length, at + INDEX_BATCH)
    setIndexState(canvasId, { ...state })
  }

  /* frames gone since the last run */
  const live = new Set(order.map((p) => p.frame.id))
  for (const frameId of new Set(previousRows.map((r) => r.frameId))) {
    if (!live.has(frameId)) await persist.deleteItemsOfFrame(canvasId, frameId)
  }
  const rows = await persist.loadLibraryItems(canvasId)
  for (const changed of resolveParents(rows)) {
    await persist.replaceFrameItems(canvasId, changed.frameId, [changed])
    const at = rows.findIndex((r) => r.itemId === changed.itemId)
    if (at >= 0) rows[at] = changed
  }
  if (getLibrary(canvasId) !== record) return
  dropIndex(canvasId)
  setIndexState(canvasId, { ...state, status: 'done', finishedAt: Date.now() }, countsOf(rows))
  announceLibrary(canvasId, SYSTEM)
}

/* ---- one frame at a time ---- */

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Reindex a frame 1.5 s after its last write; a streaming frame waits. */
export function scheduleFrame(canvasId: string, frameId: string, delay = FRAME_DEBOUNCE_MS): void {
  const key = `${canvasId}\n${frameId}`
  clearTimeout(timers.get(key))
  const timer = setTimeout(() => {
    timers.delete(key)
    if (isFrameStreaming(frameId)) return scheduleFrame(canvasId, frameId, delay)
    reindexFrame(canvasId, frameId).catch((error: unknown) =>
      console.error('[library-index] frame reindex failed', frameId, error),
    )
  }, delay)
  timer.unref?.()
  timers.set(key, timer)
}

/** Frames waiting for their debounce. */
export function pendingFrames(): number {
  return timers.size
}

/** Reindex one frame now. A section frame reindexes its whole page, since
 *  it sets the category of every frame below it. */
export async function reindexFrame(canvasId: string, frameId: string): Promise<void> {
  const record = getLibrary(canvasId)
  if (!record) return
  if (running.has(canvasId)) {
    const pending = afterRun.get(canvasId) ?? new Set<string>()
    pending.add(frameId)
    afterRun.set(canvasId, pending)
    return
  }
  const order = framesInOrder(record)
  const placed = order.find((p) => p.frame.id === frameId)
  if (!placed) return removeFrameItems(canvasId, frameId)
  const isSection = !!sectionCategory(record.rules.detect.section, placed.frame.name)
  const pageId = framePageId(store.getCanvas(canvasId)!, placed.frame)
  const targets = isSection
    ? order.filter((p) => framePageId(store.getCanvas(canvasId)!, p.frame) === pageId)
    : [placed]
  await indexFrames(record, targets)
}

async function indexFrames(record: LibraryRecord, targets: Placed[]): Promise<void> {
  const canvasId = record.canvasId
  const cache = await cacheFor(canvasId)
  const targetIds = new Set(targets.map((p) => p.frame.id))
  const taken = new Map<string, string>()
  for (const row of cache.rows) if (!targetIds.has(row.frameId)) taken.set(row.itemId.toLowerCase(), row.frameId)
  const previous = new Map(cache.rows.filter((r) => targetIds.has(r.frameId)).map((r) => [r.itemId, r]))
  const now = Date.now()
  for (const placed of targets) {
    const frame = await store.renderableFrame(placed.frame.id)
    if (!frame) continue
    const items = finalize(canvasId, frame.id, extract(record, placed, frame).items, taken, previous, now)
    /* a card joins its family among the other frames' rows */
    if (items.length === 1 && !items[0]!.scripted) {
      const families = cache.rows.filter((r) => r.frameId !== frame.id && !r.parentId).map((r) => r.itemId)
      items[0]!.parentId = parentIdOf(items[0]!.itemId, families)
    }
    await persist.replaceFrameItems(canvasId, frame.id, items)
    patchCache(canvasId, frame.id, items)
  }
  if (getLibrary(canvasId) !== record) return
  const counts = countsOf(cache.rows)
  setIndexState(canvasId, record.indexState, counts)
}

/** A frame left the library: its items go. */
export async function removeFrameItems(canvasId: string, frameId: string): Promise<void> {
  await persist.deleteItemsOfFrame(canvasId, frameId)
  if (!getLibrary(canvasId)) return
  const cache = await cacheFor(canvasId)
  patchCache(canvasId, frameId, [])
  setIndexState(canvasId, getLibrary(canvasId)?.indexState ?? null, countsOf(cache.rows))
}

/* ---- wiring ---- */

function onFrameWrite(write: FrameWrite) {
  if (!getLibrary(write.canvasId)) return
  scheduleFrame(write.canvasId, write.frameId)
}

/** Follow frame writes and library changes (once, at boot). */
export function wireIndexer(): () => void {
  const stopFrames = store.onFrameWrite(onFrameWrite)
  const stopLibraries = onLibraryChange((canvasId, change, rulesChanged) => {
    if (change === 'disabled') {
      dropIndex(canvasId)
      void persist.deleteLibraryItems(canvasId)
    } else if (change === 'created' || rulesChanged) {
      dropIndex(canvasId)
      void reindexLibrary(canvasId)
    } else dropIndex(canvasId)
  })
  const sweep = setInterval(() => evictIdleIndexes(), 60_000)
  sweep.unref?.()
  return () => {
    stopFrames()
    stopLibraries()
    clearInterval(sweep)
  }
}

/** At boot: finish the full runs a restart cut off. */
export function resumeIndexing(libraries: LibraryRecord[]): Promise<void>[] {
  return libraries
    .filter((record) => record.indexState?.status === 'running')
    .map((record) => reindexLibrary(record.canvasId, { resume: true }))
}

/** For tests: forget every cache, timer and run. */
export function resetIndexerForTest(): void {
  caches.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  rerun.clear()
  afterRun.clear()
}
