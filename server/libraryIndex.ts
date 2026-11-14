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
  EMPTY_TAXONOMY,
  effectiveItem,
  type LibraryPreview,
  type LibraryTaxonomy,
  type LibraryIndexState,
  type LibraryItem,
  type LibraryItemMeta,
  type RuleFinding,
} from '../shared/library.ts'
import { parentIdOf } from '../shared/libraryIds.ts'
import { NON_INSERTABLE_KINDS, sectionCategory, tidyCategory, type LibraryRules } from '../shared/libraryRules.ts'
import { buildIndex, type LibraryIndex } from '../shared/librarySearch.ts'
import { readingOrder } from '../shared/frameOrder.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import { store, type FrameWrite } from './store.ts'
import { isFrameStreaming } from './actions.ts'
import { announceLibrary, getLibrary, onLibraryChange, setIndexState, type LibraryRecord } from './libraries.ts'
import { contentHash, extractFrameItems, type ExtractedItem } from './libraryExtract.ts'
import { loadFramePage, rendererAvailable } from './screenshot.ts'
import { collectExpression, type CollectedFrame } from '../shared/libraryCollect.ts'
import { parseItemId } from '../shared/libraryIds.ts'

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
function framesInOrder(record: Pick<LibraryRecord, 'canvasId' | 'rules'>): Placed[] {
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

/** A scripted frame's static pass finds its family alone: the variants the
 *  rendered pass read stay until the next rendered pass replaces them. */
function keepRendered(
  extracted: ExtractedItem[],
  frameId: string,
  previous: Map<string, LibraryItem>,
): ExtractedItem[] {
  const family = extracted.find((item) => !item.parentId)
  if (!family?.scripted || extracted.some((item) => item.parentId)) return extracted
  const rendered = [...previous.values()].filter(
    (row) => row.frameId === frameId && row.parentId === family.itemId && row.hash.startsWith('r:'),
  )
  return [...extracted, ...rendered.map(({ canvasId: _c, rev: _r, indexedAt: _i, useCount: _u, ...row }) => row)]
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

function extract(record: Pick<LibraryRecord, 'canvasId' | 'rules' | 'taxonomy'>, placed: Placed, frame: Frame) {
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
        const extracted = keepRendered(extract(record, placed, frame).items, frame.id, previous)
        items = finalize(canvasId, frame.id, extracted, taken, previous, now)
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
  queueRenderedPasses(canvasId, rows)
  if (!pendingPasses.get(canvasId)) indexed(canvasId)
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
    const extracted = keepRendered(extract(record, placed, frame).items, frame.id, previous)
    const items = finalize(canvasId, frame.id, extracted, taken, previous, now)
    /* a card joins its family among the other frames' rows */
    if (items.length === 1 && !items[0]!.scripted) {
      const families = cache.rows.filter((r) => r.frameId !== frame.id && !r.parentId).map((r) => r.itemId)
      items[0]!.parentId = parentIdOf(items[0]!.itemId, families)
    }
    await persist.replaceFrameItems(canvasId, frame.id, items)
    patchCache(canvasId, frame.id, items)
    queueRenderedPass(canvasId, frame.id)
  }
  if (getLibrary(canvasId) !== record) return
  const counts = countsOf(cache.rows)
  setIndexState(canvasId, record.indexState, counts)
}

/* ---- the rendered pass ---- */

/** What the rendered pass needs from the server renderer (swapped in tests). */
export interface LibraryRenderer {
  available(): boolean
  collect(frame: Frame, expression: string): Promise<CollectedFrame>
}

/** How long a page settles before it is read: late scripts fill their grids. */
export const RENDER_SETTLE_MS = 1700
const MAX_RENDERS = 2

const serverRenderer: LibraryRenderer = {
  available: () => rendererAvailable(),
  async collect(frame, expression) {
    const loaded = await loadFramePage(frame, { priority: 'background' })
    try {
      await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS))
      await loaded.page.evaluate('globalThis.__name = (target) => target')
      return (await loaded.page.evaluate(expression)) as CollectedFrame
    } finally {
      await loaded.close()
    }
  },
}

let renderer: LibraryRenderer = serverRenderer

/** For tests: render with something else than the headless browser. */
export function setLibraryRenderer(next: LibraryRenderer | null): void {
  renderer = next ?? serverRenderer
}

/** Listeners told when a library's items and boxes are settled: its full
 *  run and the rendered passes it queued are done (the thumbnail prewarm). */
type IndexedListener = (canvasId: string) => void
const indexedListeners: IndexedListener[] = []
export function onLibraryIndexed(listener: IndexedListener): () => void {
  indexedListeners.push(listener)
  return () => {
    const at = indexedListeners.indexOf(listener)
    if (at >= 0) indexedListeners.splice(at, 1)
  }
}
function indexed(canvasId: string) {
  for (const listener of indexedListeners) listener(canvasId)
}
/** rendered passes queued or running, per library */
const pendingPasses = new Map<string, number>()

const renderQueue: { canvasId: string; frameId: string }[] = []
const queued = new Set<string>()
let rendering = 0
let renderIdle: Promise<void> = Promise.resolve()
let renderIdleDone: (() => void) | null = null

/** Resolves once every queued rendered pass ran (tests). */
export function renderedPassesSettled(): Promise<void> {
  return rendering || renderQueue.length ? renderIdle : Promise.resolve()
}

function queueRenderedPass(canvasId: string, frameId: string) {
  if (!renderer.available()) return
  const key = `${canvasId}\n${frameId}`
  if (queued.has(key)) return
  if (!rendering && !renderQueue.length) renderIdle = new Promise((resolve) => (renderIdleDone = resolve))
  queued.add(key)
  pendingPasses.set(canvasId, (pendingPasses.get(canvasId) ?? 0) + 1)
  renderQueue.push({ canvasId, frameId })
  pumpRenders()
}

/** After a full run: scripted frames first (they have variants to find),
 *  then every frame whose items have no box yet. */
function queueRenderedPasses(canvasId: string, rows: LibraryItem[]) {
  const frames = new Map<string, { scripted: boolean; boxed: boolean }>()
  for (const row of rows) {
    const f = frames.get(row.frameId) ?? { scripted: false, boxed: true }
    f.scripted ||= row.scripted
    f.boxed &&= !!row.box
    frames.set(row.frameId, f)
  }
  const order = [...frames]
    .filter(([, f]) => f.scripted || !f.boxed)
    .sort(([, a], [, b]) => Number(b.scripted) - Number(a.scripted))
  for (const [frameId] of order) queueRenderedPass(canvasId, frameId)
}

function pumpRenders() {
  while (rendering < MAX_RENDERS && renderQueue.length) {
    const next = renderQueue.shift()!
    queued.delete(`${next.canvasId}\n${next.frameId}`)
    rendering++
    renderedPass(next.canvasId, next.frameId)
      .catch((error: unknown) => console.error('[library-index] rendered pass failed', next.frameId, error))
      .finally(() => {
        rendering--
        const left = (pendingPasses.get(next.canvasId) ?? 1) - 1
        if (left > 0) pendingPasses.set(next.canvasId, left)
        else {
          pendingPasses.delete(next.canvasId)
          if (!running.has(next.canvasId)) indexed(next.canvasId)
        }
        if (!rendering && !renderQueue.length) renderIdleDone?.()
        pumpRenders()
      })
  }
}

/** A variant only the rendered page shows has its hash marked so: the next
 *  rendered pass may drop it, never a variant the static pass read. */
const RENDERED = 'r:'
const isRendered = (row: LibraryItem) => row.hash.startsWith(RENDERED)

/** Box a variant of the rendered page, or a new one only the page shows. */
function renderedRow(
  family: LibraryItem,
  item: CollectedFrame['items'][number],
  position: number,
  previous: LibraryItem | undefined,
  now: number,
): LibraryItem {
  const parsed = parseItemId(item.id)
  const hash = RENDERED + contentHash(item.html)
  const same = previous && previous.hash === hash
  return {
    canvasId: family.canvasId,
    itemId: item.id,
    parentId: family.itemId,
    frameId: family.frameId,
    pageId: family.pageId,
    position,
    label: item.label || item.id,
    description: '',
    kind: parsed?.kind || family.kind,
    source: parsed?.source || family.source,
    category: family.category,
    tags: family.tags,
    mode: 'snapshot',
    locator: item.elementId ? { elementId: item.elementId } : { anchor: item.anchor },
    box: item.box,
    scripted: true,
    status: 'active',
    findings: [],
    hash,
    rev: previous ? (same ? previous.rev : previous.rev + 1) : 1,
    searchText: `${item.label} ${item.text}`.trim().slice(0, 2000),
    sourceUrl: family.sourceUrl,
    license: family.license,
    indexedAt: same ? previous.indexedAt : now,
  }
}

/**
 * Read one frame in the headless browser: a scripted sheet's variants (which
 * only exist once its scripts ran) and every item's box. A renderer failure
 * leaves the static items as they are and counts as `failed`.
 */
export async function renderedPass(canvasId: string, frameId: string): Promise<'rendered' | 'skipped' | 'failed'> {
  const record = getLibrary(canvasId)
  if (!record || !renderer.available()) return 'skipped'
  const frame = await store.renderableFrame(frameId)
  if (!frame) return 'skipped'
  const cache = await cacheFor(canvasId)
  const own = cache.rows.filter((r) => r.frameId === frameId)
  const family = own.find((r) => !r.parentId) ?? own.find((r) => !own.some((o) => o.itemId === r.parentId))
  if (!family) return 'skipped'
  const v = record.rules.detect.variants
  let collected: CollectedFrame
  try {
    collected = await renderer.collect(frame, collectExpression({ ...v, familyId: family.itemId }))
  } catch (error) {
    console.warn('[library-index] could not render', frameId, error)
    const state = getLibrary(canvasId)?.indexState
    if (state) setIndexState(canvasId, { ...state, failed: state.failed + 1 })
    return 'failed'
  }
  if (getLibrary(canvasId) !== record) return 'skipped'
  const now = Date.now()
  const byId = new Map(own.map((r) => [r.itemId, r]))
  const seen = new Set<string>()
  const rows: LibraryItem[] = []
  collected.items.forEach((item, position) => {
    if (seen.has(item.id) || item.id.toLowerCase() === family.itemId.toLowerCase()) return
    seen.add(item.id)
    const previous = byId.get(item.id)
    /* a static variant keeps what the static pass read; it gains its box */
    if (previous && !isRendered(previous)) rows.push({ ...previous, box: item.box })
    else if (family.scripted) rows.push(renderedRow(family, item, position, previous, now))
  })
  const familyBox = { x: 0, y: 0, w: collected.width || frame.width, h: collected.height || frame.height }
  /* static variants the page did not show keep their rows; a scripted
     sheet's variants are what the page shows, nothing else */
  const kept = own.filter((r) => r.itemId !== family.itemId && !seen.has(r.itemId) && !isRendered(r))
  const next = [{ ...family, box: family.box ?? familyBox }, ...rows, ...kept]
  await persist.replaceFrameItems(canvasId, frameId, next)
  patchCache(canvasId, frameId, next)
  const state = getLibrary(canvasId)?.indexState
  setIndexState(canvasId, state ? { ...state, rendered: state.rendered + 1 } : null, countsOf(cache.rows))
  return 'rendered'
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
  pendingPasses.clear()
}

/* ---- the dry run ---- */

/** Fold categories that differ only by case or by what `tidyCategory`
 *  removes into one, keeping the first spelling and adding the counts. */
export function mergeCategories(counts: Map<string, number>): Map<string, number> {
  const spelling = new Map<string, string>()
  const out = new Map<string, number>()
  for (const [raw, count] of counts) {
    const path = tidyCategory(raw) ?? raw
    const key = path.toLowerCase()
    const kept = spelling.get(key) ?? path
    spelling.set(key, kept)
    out.set(kept, (out.get(kept) ?? 0) + count)
  }
  return out
}

/** What indexing a canvas under `rules` would give, without writing
 *  anything: counts, frames it ignored, frames it could not read, ids
 *  claimed twice, and the categories it found. */
export async function previewIndex(
  canvasId: string,
  rules: LibraryRules,
  taxonomy: LibraryTaxonomy = EMPTY_TAXONOMY,
): Promise<LibraryPreview> {
  const record = { canvasId, rules, taxonomy }
  const order = framesInOrder(record)
  const report: LibraryPreview = {
    frames: order.length,
    families: 0,
    variants: 0,
    scripted: 0,
    ignored: [],
    unreadable: [],
    duplicates: [],
    categories: [],
    taxonomy: { kinds: [], sources: [], categories: [] },
  }
  const kinds = new Map<string, number>()
  const sources = new Map<string, number>()
  const taken = new Map<string, string>()
  const categories = new Map<string, number>()
  for (let at = 0; at < order.length; at += INDEX_BATCH) {
    for (const placed of order.slice(at, at + INDEX_BATCH)) {
      const frame = await store.renderableFrame(placed.frame.id)
      if (!frame) continue
      let result: ReturnType<typeof extract>
      try {
        result = extract(record, placed, frame)
      } catch (error) {
        report.unreadable.push({
          frameId: frame.id,
          name: frame.name,
          reason: String((error as Error).message ?? error),
        })
        continue
      }
      if (result.ignored) {
        report.ignored.push({
          frameId: frame.id,
          name: frame.name,
          ...(result.section ? { section: result.section } : {}),
        })
        continue
      }
      if (!result.items.length) {
        report.unreadable.push({ frameId: frame.id, name: frame.name, reason: 'no id could be read or assigned' })
        continue
      }
      if (result.scripted) report.scripted++
      for (const item of result.items) {
        if (item.parentId) report.variants++
        else report.families++
        const owner = taken.get(item.itemId.toLowerCase())
        if (owner !== undefined && owner !== frame.id)
          report.duplicates.push({ itemId: item.itemId, frameIds: [owner, frame.id] })
        else taken.set(item.itemId.toLowerCase(), frame.id)
        if (!item.parentId) categories.set(item.category, (categories.get(item.category) ?? 0) + 1)
        if (item.kind) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
        if (item.source) sources.set(item.source, (sources.get(item.source) ?? 0) + 1)
      }
    }
  }
  /* `Pricing` and `pricing` (or two pages tidied to one name) are one category */
  const merged = mergeCategories(categories)
  report.categories = [...merged]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  /* the section frames name categories too, even before anything sits under them */
  const paths = new Set(
    mergeCategories(
      new Map([...merged.keys(), ...report.ignored.flatMap((f) => (f.section ? [f.section] : []))].map((p) => [p, 0])),
    ).keys(),
  )
  const known = (id: string) => taxonomy.kinds.find((k) => k.id === id)
  report.taxonomy = {
    kinds: [...kinds.keys()].sort().map((id) => ({
      id,
      label: known(id)?.label ?? rules.categorise.kindMap[id] ?? id,
      insertable: known(id)?.insertable ?? !NON_INSERTABLE_KINDS.has(id),
    })),
    sources: [...sources.keys()].sort().map((id) => taxonomy.sources.find((s) => s.id === id) ?? { id, label: id }),
    categories: [...paths].sort((a, b) => a.localeCompare(b)).map((path) => ({ path })),
  }
  return report
}
