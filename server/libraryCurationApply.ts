/**
 * Apply a reviewed curation plan: a NEW canvas, owned by the requester, one
 * page per category in tree order (named by its path, which the library's
 * `page` rule reads back as the items' category), every kept frame copied
 * onto its category's page in a tidy grid, then the canvas turned into a
 * library with the plan's taxonomy, which starts its index.
 *
 * The sources are only read (`store.renderableFrame`). The run is
 * resumable and idempotent: the canvas, the page ids and every copied frame
 * are recorded on the job as they are made, and a frame already on its
 * computed spot (a copy whose record a restart lost) is taken as copied.
 */
import {
  flattenTree,
  pageNodes,
  type CurationApplyState,
  type CurationEntry,
  type CurationJob,
  type FrameRef,
} from '../shared/libraryCuration.ts'
import { UNSORTED, type LibraryKind, type LibrarySource, type LibraryTaxonomy } from '../shared/library.ts'
import { RULE_PRESETS, type LibraryRules } from '../shared/libraryRules.ts'
import type { Actor, CanvasPageInfo } from '../shared/types.ts'
import { nanoid } from 'nanoid'
import { withOrigin } from '../shared/libraryProvenance.ts'
import * as persist from './db/persist.ts'
import { canManageCanvas } from './access.ts'
import { store, MAX_LIBRARY_PAGES } from './store.ts'
import { createLibrary, getLibrary, presetFor } from './libraries.ts'
import { allCurations, CurationError, getCuration, saveCurationJob } from './libraryCuration.ts'

/** The widest a page's rows run before they wrap (a wider frame gets its own row). */
export const ROW_WIDTH = 6000
export const GAP = 120
/** Copies between two awaited writes: keeps the database queue short. */
const FLUSH_EVERY = 25

export interface PlacedFrame {
  ref: FrameRef
  pageKey: string
  x: number
  y: number
  width: number
  height: number
}

/** Shelf packing, left to right then down, a family's frames side by side.
 *  Pure: the same plan always gives the same spots (what resuming relies on). */
export function layoutPage(
  entries: CurationEntry[],
  pageKey: string,
  size: (ref: FrameRef, entry: CurationEntry) => { width: number; height: number },
): PlacedFrame[] {
  const out: PlacedFrame[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const entry of entries) {
    for (const ref of entry.frames) {
      const { width, height } = size(ref, entry)
      if (x > 0 && x + width > ROW_WIDTH) {
        x = 0
        y += rowHeight + GAP
        rowHeight = 0
      }
      out.push({ ref, pageKey, x, y, width, height })
      x += width + GAP
      rowHeight = Math.max(rowHeight, height)
    }
  }
  return out
}

/** The pages of the new canvas: one per category with items, plus
 *  Unsorted for what the plan left unfiled when it is kept. */
export function plannedPages(
  job: CurationJob,
  includeUnclassified: boolean,
): { key: string; name: string; entries: CurationEntry[] }[] {
  const plan = job.plan!
  const pages = pageNodes(plan).map((p) => ({ key: p.id, name: p.path, entries: p.entries }))
  if (includeUnclassified) {
    const ids = new Set(flattenTree(plan.tree).map((f) => f.node.id))
    const rest = plan.entries.filter((e) => !ids.has(plan.assignments[e.key] ?? ''))
    if (rest.length) pages.push({ key: 'unsorted', name: UNSORTED, entries: rest })
  }
  return pages
}

/** The library's rules: the first source library's (or the preset its
 *  names fit), reading the category from the page first. */
export function curatedRules(job: CurationJob): LibraryRules {
  const first = job.sourceIds.map((id) => getLibrary(id)?.rules).find(Boolean)
  const canvas = store.getCanvas(job.sourceIds[0]!)
  const base = structuredClone(first ?? RULE_PRESETS[canvas ? presetFor(canvas) : 'blank'])
  base.categorise = { ...base.categorise, by: ['page', 'marker', 'kind'], fallback: UNSORTED }
  base.placement = { ...base.placement, page: 'category' }
  return base
}

/** The taxonomy: every path of the tree, and the kinds and sources the
 *  source libraries declared. */
export function curatedTaxonomy(job: CurationJob, pageNames: string[]): LibraryTaxonomy {
  const kinds = new Map<string, LibraryKind>()
  const sources = new Map<string, LibrarySource>()
  for (const id of job.sourceIds) {
    const taxonomy = getLibrary(id)?.taxonomy
    for (const k of taxonomy?.kinds ?? []) if (!kinds.has(k.id)) kinds.set(k.id, k)
    for (const s of taxonomy?.sources ?? []) if (!sources.has(s.id)) sources.set(s.id, s)
  }
  const paths = [...new Set([...flattenTree(job.plan!.tree).map((f) => f.path), ...pageNames])]
  return { kinds: [...kinds.values()], sources: [...sources.values()], categories: paths.map((path) => ({ path })) }
}

const running = new Map<string, Promise<void>>()

export function applySettled(id: string): Promise<void> {
  return running.get(id) ?? Promise.resolve()
}

/**
 * Start applying a ready plan (or resume one a restart cut off). Checks
 * the requester still manages every source. Returns at once; the job's
 * progress tells how far the copy got.
 */
export async function applyCuration(
  id: string,
  requester: { id: string; name: string },
  opts: { includeUnclassified?: boolean } = {},
): Promise<CurationJob> {
  const job = getCuration(id)
  if (!job?.plan || job.ownerId !== requester.id) throw new CurationError('curation not found', 404)
  if (job.status === 'applied') return job
  if (job.status !== 'ready' && job.status !== 'applying' && !(job.status === 'failed' && job.applied)) {
    throw new CurationError('only a ready plan can be applied', 409)
  }
  for (const sourceId of job.sourceIds) {
    const canvas = store.getCanvas(sourceId)
    if (!canvas || !canManageCanvas(requester.id, canvas)) throw new CurationError(`canvas ${sourceId} not found`, 404)
  }
  const pages = plannedPages(job, opts.includeUnclassified ?? true)
  if (!pages.length) throw new CurationError('no category holds an item: file some items first')
  if (pages.length > MAX_LIBRARY_PAGES) {
    throw new CurationError(`a library holds at most ${MAX_LIBRARY_PAGES} pages: merge some categories`)
  }
  job.status = 'applying'
  job.error = null
  job.applied ??= { canvasId: null, pageIds: {}, copied: {}, libraryCreated: false }
  job.progress = { done: Object.keys(job.applied.copied).length, total: 0 }
  await saveCurationJob(job, true)
  if (!running.has(job.id)) {
    const actor: Actor = { name: requester.name, kind: 'user', color: '#888888' }
    const task = runApply(job, pages, actor)
      .catch(async (error: unknown) => {
        console.error('[curation] apply stopped', job.id, error)
        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        await saveCurationJob(job, true)
      })
      .finally(() => running.delete(job.id))
    running.set(job.id, task)
  }
  return job
}

const refKey = (ref: FrameRef) => `${ref.canvasId}:${ref.frameId}`

async function runApply(
  job: CurationJob,
  pages: { key: string; name: string; entries: CurationEntry[] }[],
  actor: Actor,
): Promise<void> {
  const state = job.applied as CurationApplyState
  /* the canvas */
  let canvas = state.canvasId ? store.getCanvas(state.canvasId) : undefined
  if (!canvas) {
    canvas = store.createCanvas(job.name, job.ownerId)
    state.canvasId = canvas.id
    state.pageIds = {}
    state.copied = {}
    await saveCurationJob(job, true)
  }
  await store.load(canvas.id)
  const release = store.hold(canvas.id)
  try {
    /* the pages, in tree order; the blank first page of a new canvas is reused */
    const current = store.getCanvas(canvas.id)!.pages ?? []
    const list: CanvasPageInfo[] = pages.map((p, i) => {
      const reuse = i === 0 && current[0] && !Object.keys(state.pageIds).length ? current[0].id : null
      const id = state.pageIds[p.key] ?? reuse ?? nanoid(10)
      state.pageIds[p.key] = id
      return { id, name: p.name.slice(0, 100) }
    })
    store.setPages(canvas.id, list)
    await saveCurationJob(job, true)

    /* the frames */
    const sizes = new Map<string, { width: number; height: number }>()
    for (const p of pages) {
      for (const e of p.entries) {
        for (const ref of e.frames) {
          const f = store.getFrame(ref.frameId)
          sizes.set(refKey(ref), f ? { width: f.width, height: f.height } : { width: e.width, height: e.height })
        }
      }
    }
    const placed = pages.flatMap((p) =>
      layoutPage(p.entries, p.key, (ref, e) => sizes.get(refKey(ref)) ?? { width: e.width, height: e.height }),
    )
    job.progress = { done: Object.keys(state.copied).length, total: placed.length }
    const target = store.getCanvas(canvas.id)!
    const already = new Map(target.frames.map((f) => [`${f.pageId}|${f.x}|${f.y}|${f.name}`, f.id] as const))
    let sinceFlush = 0
    for (const spot of placed) {
      const key = refKey(spot.ref)
      if (state.copied[key] && store.getFrame(state.copied[key])) continue
      if (getCuration(job.id) !== job) return
      const source = await store.renderableFrame(spot.ref.frameId)
      if (!source || source.canvasId !== spot.ref.canvasId) {
        job.progress = { ...job.progress, done: job.progress.done + 1 }
        continue
      }
      const pageId = state.pageIds[spot.pageKey]!
      const found = already.get(`${pageId}|${spot.x}|${spot.y}|${source.name}`)
      const frame =
        (found && store.getFrame(found)) ||
        store.createFrame(
          canvas.id,
          {
            name: source.name,
            pageId,
            x: spot.x,
            y: spot.y,
            width: source.width,
            height: source.height,
            html: withOrigin(source.html, key),
          },
          actor.name,
        )
      if (!frame) throw new Error('a frame could not be copied onto the new canvas')
      state.copied[key] = frame.id
      job.progress = { done: Object.keys(state.copied).length, total: placed.length }
      if (++sinceFlush >= FLUSH_EVERY) {
        sinceFlush = 0
        await persist.saveFrameNow(frame)
        await saveCurationJob(job)
      }
    }
    await saveCurationJob(job, true)

    /* the library */
    if (!state.libraryCreated) {
      createLibrary(
        canvas.id,
        {
          rules: curatedRules(job),
          taxonomy: curatedTaxonomy(
            job,
            pages.map((p) => p.name),
          ),
          description: `Curated from ${job.sourceIds.length} canvases by ${job.model ?? 'a model'}.`,
        },
        actor,
      )
      state.libraryCreated = true
    }
    job.status = 'applied'
    await saveCurationJob(job, true)
  } finally {
    release()
  }
}

/** At boot: finish the applies a restart cut off. */
export function resumeApplies(): void {
  for (const job of jobsApplying()) {
    void applyCuration(job.id, { id: job.ownerId, name: 'Library curation' }).catch((error: unknown) =>
      console.error('[curation] could not resume an apply', job.id, error),
    )
  }
}

function jobsApplying(): CurationJob[] {
  return allCurations().filter((j) => j.status === 'applying')
}
