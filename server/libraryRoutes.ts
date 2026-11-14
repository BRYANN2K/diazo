/**
 * `/api/libraries`: turn a canvas into a library, read it, search it, read
 * and curate its items. Mounted behind the session gate. Every handler asks
 * `libraryRole` first, and a library the caller may not reach answers 404,
 * like a canvas. No handler loads a canvas's frame HTML: items come from the
 * index, one item's markup from `store.renderableFrame`.
 */
import express from 'express'
import type { LibraryItemMeta, LibraryItemPatch, LibraryTaxonomy } from '../shared/library.ts'
import { describeRules, parseLibraryRules, RULE_PRESETS, type RulePresetName } from '../shared/libraryRules.ts'
import type { QueryFilters } from '../shared/librarySearch.ts'
import { canEditCanvas, canManageCanvas } from './access.ts'
import { countUse, insertItem, InsertError } from './librarySnapshot.ts'
import { applyTransfer } from './libraryImport.ts'
import { resolveActor } from './actions.ts'
import { store } from './store.ts'
import { createLibrary, disableLibrary, getLibrary, libraryAllows, presetFor, updateLibrary } from './libraries.ts'
import { itemMeta, previewIndex, reindexLibrary, saveMeta } from './libraryIndex.ts'
import { entryOf, itemDetail, libraryFor, readableLibraries, searchLibraries } from './libraryQueries.ts'
import { itemThumb, NoThumbError } from './libraryThumbs.ts'
import { RendererBusyError } from './renderBrowser.ts'

export const libraryRouter = express.Router()

const notFound = (res: express.Response) => res.status(404).json({ error: 'library not found' })

function actorOf(req: express.Request) {
  return resolveActor({ name: req.user!.name, kind: 'user' })
}

/* ---- the search rate limit: 30 requests per 10 s per account ---- */

const SEARCH_WINDOW_MS = 10_000
export const SEARCH_LIMIT = 30
const searches = new Map<string, number[]>()

function rateLimited(userId: string, now = Date.now()): boolean {
  const recent = (searches.get(userId) ?? []).filter((at) => now - at < SEARCH_WINDOW_MS)
  if (recent.length >= SEARCH_LIMIT) {
    searches.set(userId, recent)
    return true
  }
  recent.push(now)
  searches.set(userId, recent)
  return false
}

const list = (v: unknown): string[] | undefined => {
  const values = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
  return values.length ? values.slice(0, 20) : undefined
}

function filtersOf(query: express.Request['query']): QueryFilters {
  const f: QueryFilters = {}
  const kind = list(query.kind)
  const category = list(query.category ?? query.in)
  const tag = list(query.tag)
  const source = list(query.source)
  if (kind) f.kind = kind
  if (category) f.category = category
  if (tag) f.tag = tag
  if (source) f.source = source
  return f
}

const isPreset = (v: unknown): v is RulePresetName => v === 'blank' || v === 'sheets'

/* ---- libraries ---- */

libraryRouter.get('/', async (req, res) => {
  res.json({ libraries: await readableLibraries(req.user!.id) })
})

/** The dry run of a conversion or a rules change: counts, nothing written. */
libraryRouter.post('/preview', async (req, res) => {
  const canvasId = String(req.body?.canvasId ?? '')
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !canManageCanvas(req.user!.id, canvas)) return notFound(res)
  const asked: unknown = req.body?.preset
  const preset: RulePresetName = isPreset(asked) ? asked : presetFor(canvas)
  let rules = (!isPreset(asked) && getLibrary(canvasId)?.rules) || RULE_PRESETS[preset]
  if (req.body?.rules !== undefined) {
    const parsed = parseLibraryRules(req.body.rules)
    if (!parsed.ok) return res.status(400).json({ error: 'invalid rules', errors: parsed.errors })
    rules = parsed.rules
  }
  const preview = await previewIndex(canvasId, rules, getLibrary(canvasId)?.taxonomy)
  res.json({ preset, rules, preview })
})

libraryRouter.post('/', (req, res) => {
  const canvasId = String(req.body?.canvasId ?? '')
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !canManageCanvas(req.user!.id, canvas)) return notFound(res)
  const taxonomy = req.body?.taxonomy as LibraryTaxonomy | undefined
  const asked: unknown = req.body?.preset
  const record = createLibrary(
    canvasId,
    { ...(isPreset(asked) ? { preset: asked } : {}), ...(taxonomy ? { taxonomy } : {}) },
    actorOf(req),
  )
  if (!record) return notFound(res)
  res.status(201).json(entryOf(canvas, 'manage', false))
})

/** Search every library the caller may use, or the ones `lib` names. */
libraryRouter.get('/search', async (req, res) => {
  if (rateLimited(req.user!.id)) {
    res.setHeader('Retry-After', '10')
    return res.status(429).json({ error: 'too many searches; wait a few seconds' })
  }
  const userId = req.user!.id
  const wanted = list(req.query.lib)
  const readable = (await readableLibraries(userId)).map((e) => e.id)
  const ids = wanted ? wanted.filter((id) => libraryFor(userId, id)) : readable
  const canvases = ids.flatMap((id) => {
    const c = store.getCanvas(id)
    return c ? [c] : []
  })
  const includeDrafts =
    req.query.status === 'draft' &&
    canvases.every((c) => libraryAllows(libraryFor(userId, c.id)?.role ?? null, 'curate'))
  const result = await searchLibraries(canvases, {
    query: String(req.query.q ?? ''),
    filters: filtersOf(req.query),
    includeDrafts,
    limit: Number(req.query.limit) || 20,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  })
  res.json(result)
})

libraryRouter.get('/:id', (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  const record = getLibrary(req.params.id)
  if (!found || !record) return notFound(res)
  const entry = entryOf(found.canvas, found.role, false)!
  res.json({ ...entry, rules: record.rules, rulesText: describeRules(record.rules), taxonomy: record.taxonomy })
})

libraryRouter.patch('/:id', (req, res) => {
  const body = req.body ?? {}
  const managing = body.rules !== undefined || body.visibility !== undefined
  const found = libraryFor(req.user!.id, req.params.id, managing ? 'manage' : 'curate')
  if (!found) return notFound(res)
  if (body.visibility !== undefined && body.visibility !== 'private') {
    return res.status(400).json({ error: 'only private libraries exist on this instance for now' })
  }
  const result = updateLibrary(
    req.params.id,
    {
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(body.rules !== undefined ? { rules: body.rules } : {}),
      ...(body.taxonomy ? { taxonomy: body.taxonomy as LibraryTaxonomy } : {}),
    },
    actorOf(req),
  )
  if (!result.ok) {
    if (result.status === 404) return notFound(res)
    return res.status(400).json({ error: 'invalid rules', errors: result.errors })
  }
  res.json(entryOf(found.canvas, found.role, false))
})

libraryRouter.delete('/:id', (req, res) => {
  if (!libraryFor(req.user!.id, req.params.id, 'manage')) return notFound(res)
  disableLibrary(req.params.id, actorOf(req))
  res.json({ ok: true })
})

/** Take the categories of another library for the items both hold (by id).
 *  Manage on this library, read on the other; the other is never written. */
libraryRouter.post('/:id/transfer', async (req, res) => {
  const userId = req.user!.id
  if (!libraryFor(userId, req.params.id, 'manage')) return notFound(res)
  const fromId = String(req.body?.fromLibraryId ?? '')
  if (!fromId || fromId === req.params.id || !libraryFor(userId, fromId)) return notFound(res)
  const plan = await applyTransfer(fromId, req.params.id, actorOf(req), { dryRun: req.body?.dryRun === true })
  res.json({
    matched: plan.matched.length,
    changes: plan.changes,
    onlyFrom: plan.onlyFrom.slice(0, 500),
    onlyTo: plan.onlyTo.slice(0, 500),
    onlyFromCount: plan.onlyFrom.length,
    onlyToCount: plan.onlyTo.length,
  })
})

libraryRouter.post('/:id/reindex', (req, res) => {
  if (!libraryFor(req.user!.id, req.params.id, 'curate')) return notFound(res)
  void reindexLibrary(req.params.id)
  res.status(202).json({ ok: true })
})

/* ---- items ---- */

/** Browse: the families of one library, filtered, a page at a time. */
libraryRouter.get('/:id/items', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  if (!found) return notFound(res)
  const result = await searchLibraries([found.canvas], {
    query: String(req.query.q ?? ''),
    filters: filtersOf(req.query),
    includeDrafts: req.query.status === 'draft' && libraryAllows(found.role, 'curate'),
    limit: Number(req.query.limit) || 60,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  })
  res.json(result)
})

libraryRouter.get('/:id/items/:itemId', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  res.json(out.detail)
})

/** One item's image. Immutable when asked with its hash (`?v=`), since the
 *  hash is in the storage key; 404 while it has no box, 503 when busy. */
libraryRouter.get('/:id/items/:itemId/thumb.jpg', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  try {
    const jpeg = await itemThumb(out.item)
    const current = req.query.v === out.item.hash
    res.set('Content-Type', 'image/jpeg')
    res.set('Cache-Control', current ? 'private, max-age=31536000, immutable' : 'private, max-age=60')
    res.send(jpeg)
  } catch (error) {
    if (error instanceof RendererBusyError) {
      res.set('Retry-After', '10')
      return res.status(503).json({ error: error.message })
    }
    if (error instanceof NoThumbError) return res.status(404).json({ error: error.message })
    console.error('[libraries] thumbnail failed', error)
    res.status(500).json({ error: 'thumbnail failed' })
  }
})

/** Insert an item into a frame the caller may edit: the server snapshots
 *  it (rendered, else static) and writes the frame. */
libraryRouter.post('/:id/items/:itemId/insert', async (req, res) => {
  const userId = req.user!.id
  const found = libraryFor(userId, req.params.id)
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  const frameId = String(req.body?.frameId ?? '')
  const target = store.getFrame(frameId)
  const targetCanvas = target && store.getCanvas(target.canvasId)
  if (!target || !targetCanvas || !canEditCanvas(userId, targetCanvas))
    return res.status(404).json({ error: 'frame not found' })
  try {
    const done = await insertItem({
      item: out.item,
      frameId,
      ...(typeof req.body?.afterElementId === 'string' ? { afterElementId: req.body.afterElementId } : {}),
      actor: actorOf(req),
    })
    res.json({
      elementId: done.elementId,
      fidelity: done.fidelity,
      frameId: done.frame.id,
      canvasId: done.frame.canvasId,
      approvalWithdrawn: done.approvalWithdrawn,
    })
  } catch (error) {
    if (error instanceof InsertError) return res.status(error.status).json({ error: error.message })
    throw error
  }
})

/** A browser insert counts as a use too. */
libraryRouter.post('/:id/items/:itemId/used', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  await countUse(out.item, req.user!.name)
  res.json({ ok: true })
})

/** One item's frame HTML (one frame read, never the canvas). */
libraryRouter.get('/:id/items/:itemId/html', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id)
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  const frame = await store.renderableFrame(out.item.frameId)
  if (!frame) return res.status(404).json({ error: 'item not found' })
  res.json({ html: frame.html, width: frame.width, height: frame.height, locator: out.item.locator, fidelity: 'frame' })
})

const ITEM_STATUSES = new Set(['active', 'deprecated', 'hidden'])

/** Validate a curation patch; null fields put the indexed value back. */
export function cleanItemPatch(body: unknown): { ok: true; patch: LibraryItemPatch } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const patch: LibraryItemPatch = {}
  const text = (key: 'label' | 'description' | 'category', max: number) => {
    if (!(key in b)) return true
    const v = b[key]
    if (v === null) patch[key] = null
    else if (typeof v === 'string' && v.trim().length <= max) patch[key] = v.trim() || null
    else return false
    return true
  }
  if (!text('label', 200) || !text('description', 2000) || !text('category', 200)) {
    return { ok: false, error: 'label, description and category are short strings' }
  }
  if ('tags' in b) {
    if (b.tags === null) patch.tags = null
    else if (Array.isArray(b.tags) && b.tags.every((t) => typeof t === 'string')) {
      patch.tags = [...new Set((b.tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    } else return { ok: false, error: 'tags is a list of strings' }
  }
  if ('status' in b) {
    if (b.status === null || (typeof b.status === 'string' && ITEM_STATUSES.has(b.status))) {
      patch.status = b.status as LibraryItemPatch['status']
    } else return { ok: false, error: 'status is active, deprecated or hidden' }
  }
  return { ok: true, patch }
}

/** Apply curation to an item and return what people now see. */
export async function patchItem(
  canvasId: string,
  itemId: string,
  patch: LibraryItemPatch,
  by: string,
): Promise<LibraryItemMeta> {
  const current = await itemMeta(canvasId, itemId)
  const meta: LibraryItemMeta = {
    canvasId,
    itemId,
    label: null,
    description: null,
    category: null,
    tags: null,
    status: null,
    useCount: 0,
    lastUsedAt: null,
    ...current,
    ...patch,
    updatedAt: Date.now(),
    updatedBy: by,
  }
  await saveMeta(meta)
  return meta
}

libraryRouter.patch('/:id/items/:itemId', async (req, res) => {
  const found = libraryFor(req.user!.id, req.params.id, 'curate')
  if (!found) return notFound(res)
  const out = await itemDetail(found.canvas, req.params.itemId, found.role)
  if (!out) return res.status(404).json({ error: 'item not found' })
  const cleaned = cleanItemPatch(req.body)
  if (!cleaned.ok) return res.status(400).json({ error: cleaned.error })
  await patchItem(found.canvas.id, out.item.itemId, cleaned.patch, req.user!.name)
  const after = await itemDetail(found.canvas, out.item.itemId, found.role)
  res.json(after?.detail ?? null)
})
