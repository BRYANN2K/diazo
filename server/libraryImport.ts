/**
 * Library imports: what the library's rules do to frames entering it, and
 * moving curation between libraries. Planning is pure; applying writes.
 * Spec: .context/specs/design-libraries.md, "Import rules" and "Migration".
 */
import type { Actor } from '../shared/types.ts'
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'
import type { ImportReport } from '../shared/library.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import { getLibrary, updateLibrary } from './libraries.ts'
import { itemMeta, libraryItems, saveMeta } from './libraryIndex.ts'
import * as actions from './actions.ts'
import { store } from './store.ts'
import { lintFrame } from './lint.ts'
import { updateFrameMeta } from './pageTools.ts'
import { markDraft, planImport, stageLint, type ImportFrame } from './libraryImportPlan.ts'
import { sectionCategory } from '../shared/libraryRules.ts'
import { readingOrder } from '../shared/frameOrder.ts'

/* ---- categories from another library (decision D2) ---- */

export interface TransferPlan {
  /** ids in both libraries, with the category each side gives */
  matched: { itemId: string; fromCategory: string; toCategory: string }[]
  /** ids only the source has, and only the target has */
  onlyFrom: string[]
  onlyTo: string[]
  /** matched ids whose category would change */
  changes: number
}

/** Match two libraries' items by id (ids are unique on both sides). */
export function planTransfer(from: LibraryItem[], to: LibraryItem[]): TransferPlan {
  const source = new Map(from.map((item) => [item.itemId, item]))
  const target = new Set(to.map((item) => item.itemId))
  const matched = to.flatMap((item) => {
    const other = source.get(item.itemId)
    return other ? [{ itemId: item.itemId, fromCategory: other.category, toCategory: item.category }] : []
  })
  return {
    matched,
    onlyFrom: from.filter((item) => !target.has(item.itemId)).map((item) => item.itemId),
    onlyTo: to.filter((item) => !source.has(item.itemId)).map((item) => item.itemId),
    changes: matched.filter((m) => m.fromCategory !== m.toCategory).length,
  }
}

/** Copy the source's categories onto the target's curation, and add the
 *  categories the target's taxonomy lacks. Only the target is written. */
export async function applyTransfer(
  fromCanvasId: string,
  toCanvasId: string,
  actor: Actor,
  opts: { dryRun?: boolean } = {},
): Promise<TransferPlan> {
  const plan = planTransfer(await libraryItems(fromCanvasId), await libraryItems(toCanvasId))
  if (opts.dryRun) return plan
  const now = Date.now()
  for (const m of plan.matched) {
    if (m.fromCategory === m.toCategory) continue
    const current = await itemMeta(toCanvasId, m.itemId)
    const meta: LibraryItemMeta = {
      canvasId: toCanvasId,
      itemId: m.itemId,
      label: null,
      description: null,
      tags: null,
      status: null,
      useCount: 0,
      lastUsedAt: null,
      ...current,
      category: m.fromCategory,
      updatedAt: now,
      updatedBy: actor.name,
    }
    await saveMeta(meta)
  }
  const record = getLibrary(toCanvasId)
  if (record) {
    const known = new Set(record.taxonomy.categories.map((c) => c.path))
    const added = [...new Set(plan.matched.map((m) => m.fromCategory))].filter((path) => !known.has(path))
    if (added.length) {
      updateLibrary(
        toCanvasId,
        {
          taxonomy: {
            ...record.taxonomy,
            categories: [...record.taxonomy.categories, ...added.map((path) => ({ path }))],
          },
        },
        actor,
      )
    }
  }
  return plan
}

/* ---- frames entering a library ---- */

/** Frames one import may bring. */
export const MAX_IMPORT_FRAMES = 20

export interface ImportRequest {
  libraryId: string
  frameIds: string[]
  category?: string
  tags?: string[]
  dryRun?: boolean
  actor: Actor
}

export interface ImportOutcome {
  report: ImportReport
  /** per frame: the library frame it became, or why it failed */
  applied: { frameId: string; libraryFrameId?: string; error?: string }[]
}

/** The section a frame sits under on its own page, by the library's rule. */
function sectionAbove(frameId: string, rule: string | null): string | null {
  const frame = store.getFrame(frameId)
  const canvas = frame && store.getCanvas(frame.canvasId)
  if (!frame || !canvas || !rule) return null
  const page = framePageId(canvas, frame)
  let section: string | null = null
  for (const f of readingOrder(canvas.frames.filter((x) => framePageId(canvas, x) === page))) {
    if (f.id === frameId) return section
    section = sectionCategory(rule, f.name) ?? section
  }
  return section
}

/** Plan an import and, unless it is a dry run, carry it out: frames from
 *  another canvas are copied, never moved; frames already in the library
 *  change in place. One frame failing leaves the ones before it in place. */
export async function runImport(req: ImportRequest): Promise<ImportOutcome> {
  const record = getLibrary(req.libraryId)
  const canvas = store.getCanvas(req.libraryId)
  if (!record || !canvas) throw new Error('not a library')
  const sources: ImportFrame[] = []
  const origin = new Map<string, string>()
  for (const frameId of req.frameIds.slice(0, MAX_IMPORT_FRAMES)) {
    const frame = await store.renderableFrame(frameId)
    if (!frame) continue
    const from = store.getCanvas(frame.canvasId)
    const page = from && canvasPages(from).find((p) => p.id === framePageId(from, frame))
    origin.set(frameId, frame.canvasId)
    sources.push({
      frameId,
      name: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pageName: page?.name,
      section: sectionAbove(frameId, record.rules.detect.section),
    })
  }
  const existing = (await libraryItems(req.libraryId))
    .filter((item) => !req.frameIds.includes(item.frameId))
    .map((item) => ({ itemId: item.itemId, hash: item.hash, frameId: item.frameId }))
  const planned = planImport({
    library: {
      canvasId: req.libraryId,
      rules: record.rules,
      taxonomy: record.taxonomy,
      pages: canvasPages(canvas).map((p) => ({ id: p.id, name: p.name })),
      frames: canvas.frames.map((f) => ({
        pageId: framePageId(canvas, f),
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
      })),
    },
    frames: sources,
    existing,
    ...(req.category ? { category: req.category } : {}),
    ...(req.tags?.length ? { tags: req.tags } : {}),
    tokens: canvas.tokens ?? [],
  })
  const htmlOf = (id: string) => sources.find((s) => s.frameId === id)?.html ?? ''
  const report = await stageLint(planned, htmlOf, record.rules, async (html, frameId) => {
    const source = store.getFrame(frameId)!
    return lintFrame({ ...source, html })
  })
  if (req.dryRun) return { report, applied: [] }

  const applied: ImportOutcome['applied'] = []
  const pagesByName = new Map<string, string>()
  for (const f of report.frames) {
    try {
      if (f.skipped) {
        applied.push({ frameId: f.frameId, error: 'left out: the same content is already in the library' })
        continue
      }
      let pageId = f.changes.pageId
      if (f.changes.newPage) {
        pageId = pagesByName.get(f.changes.newPage)
        if (!pageId) {
          pageId = actions.createCanvasPage(req.libraryId, f.changes.newPage, req.actor)?.page.id
          if (pageId) pagesByName.set(f.changes.newPage, pageId)
        }
      }
      const source = sources.find((s) => s.frameId === f.frameId)!
      let html = f.changes.html ?? source.html
      if (f.item?.status === 'draft') html = markDraft(html)
      if (origin.get(f.frameId) !== req.libraryId) {
        const copy = actions.createFrame(
          req.libraryId,
          {
            name: f.changes.name ?? source.name,
            ...(pageId ? { pageId } : {}),
            x: f.changes.x,
            y: f.changes.y,
            width: source.width,
            height: source.height,
            html,
          },
          req.actor,
          { reveal: false },
        )
        if (!copy) throw new Error('the copy could not be created')
        applied.push({ frameId: f.frameId, libraryFrameId: copy.id })
      } else {
        if (html !== source.html) {
          const onlyMarks = html.replace(/\sdata-doop-(item|variant|status)="[^"]*"/g, '') === source.html
          if (onlyMarks) actions.annotateFrame(f.frameId, html, req.actor)
          else actions.updateFrame(f.frameId, { html }, req.actor)
        }
        const meta = updateFrameMeta(
          canvas,
          f.frameId,
          { ...(f.changes.name ? { name: f.changes.name } : {}), ...(pageId ? { pageId } : {}) },
          req.actor,
        )
        if (!meta.ok && meta.error !== 'nothing to update') throw new Error(meta.error)
        applied.push({ frameId: f.frameId, libraryFrameId: f.frameId })
      }
    } catch (error) {
      applied.push({ frameId: f.frameId, error: error instanceof Error ? error.message : 'failed' })
    }
  }
  return { report, applied }
}
