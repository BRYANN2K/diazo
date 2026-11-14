/**
 * What the library routes and the agent tools both ask: which libraries a
 * person may use, a search across several of them, one item with its
 * variants. Every answer goes through `libraryRole`.
 */
import type { Canvas } from '../shared/types.ts'
import type { CanvasFindHit, CanvasFindResult } from '../shared/canvasFind.ts'
import {
  itemSummary,
  type LibraryFacet,
  type LibraryFacetName,
  type LibraryItem,
  type LibraryItemDetail,
  type LibraryItemSummary,
  type LibraryListEntry,
  type LibrarySearchHit,
  type LibrarySearchResult,
} from '../shared/library.ts'
import { searchIndex, type LibrarySort, type QueryFilters } from '../shared/librarySearch.ts'
import { store } from './store.ts'
import { getLibraryCanvasIds } from './referenceLibrary.ts'
import { canvasesFor } from './workspaces.ts'
import { getLibrary, infoOf, libraryAllows, libraryRole, type LibraryRole } from './libraries.ts'
import { indexFor, libraryItems } from './libraryIndex.ts'

/** The image of an item: its own thumbnail once it has a box, else the
 *  frame's preview (the client crops it to the item). */
export function thumbUrl(item: Pick<LibraryItem, 'frameId' | 'canvasId' | 'itemId' | 'hash' | 'box'>): string {
  if (item.box) {
    return `/api/libraries/${item.canvasId}/items/${encodeURIComponent(item.itemId)}/thumb.jpg?v=${encodeURIComponent(item.hash)}`
  }
  return `/i/${item.frameId}.jpg?preview`
}

/** An item on the wire with its image and its frame's size. */
export function summaryOf(item: LibraryItem): LibraryItemSummary {
  const frame = store.getFrame(item.frameId)
  return {
    ...itemSummary(item, thumbUrl(item)),
    ...(frame ? { frameSize: { w: frame.width, h: frame.height } } : {}),
  }
}

/** ⌘F everywhere on a library canvas: its items from the index, as name
 *  hits, so its frame HTML is never loaded. Null when the canvas is not a
 *  library, or its index is not built yet (the caller searches the HTML). */
export async function findInLibrary(
  canvas: Canvas,
  query: string,
  opts: { matchCase?: boolean; max?: number } = {},
): Promise<CanvasFindResult | null> {
  const record = getLibrary(canvas.id)
  if (!record) return null
  const index = await indexFor(canvas.id)
  if (!index) return null
  const q = query.trim()
  if (!q) return { hits: [], total: 0, frames: 0 }
  const result = searchIndex(index, q, { limit: opts.max ?? 200, synonyms: record.rules.search.synonyms })
  const pages = new Map((canvas.pages ?? []).map((p) => [p.id, p.name]))
  const hits: CanvasFindHit[] = []
  for (const { item } of result.hits) {
    if (opts.matchCase && !item.label.includes(q) && !item.itemId.includes(q)) continue
    const frame = canvas.frames.find((f) => f.id === item.frameId)
    if (!frame) continue
    const pageId = frame.pageId ?? item.pageId
    hits.push({
      frameId: frame.id,
      pageId,
      pageName: pages.get(pageId) ?? '',
      frameName: frame.name,
      where: 'name',
      n: -1,
      before: '',
      text: item.label || item.itemId,
      after: item.label && item.label !== item.itemId ? ` · ${item.itemId}` : '',
      item: summaryOf(item),
    })
  }
  return { hits, total: opts.matchCase ? hits.length : result.total, frames: new Set(hits.map((h) => h.frameId)).size }
}

/** Where a person opens an item. */
export function itemUrl(libraryId: string, itemId: string): string {
  return `/l/${libraryId}/i/${encodeURIComponent(itemId)}`
}

export function entryOf(canvas: Canvas, role: LibraryRole, listed: boolean): LibraryListEntry | null {
  const record = getLibrary(canvas.id)
  if (!record) return null
  return {
    id: canvas.id,
    name: canvas.name,
    library: infoOf(record),
    role,
    workspaceId: canvas.workspaceId ?? null,
    listed,
  }
}

/** The libraries a person may use: theirs, shared with them, their
 *  workspaces', and the ones picked in their reference library. */
export async function readableLibraries(userId: string): Promise<LibraryListEntry[]> {
  const listed = new Set(await getLibraryCanvasIds(userId))
  const ids = new Set<string>([...canvasesFor(userId).map((c) => c.id), ...listed])
  const out: LibraryListEntry[] = []
  for (const id of ids) {
    const canvas = store.getCanvas(id)
    const role = libraryRole(userId, canvas)
    if (!canvas || !role) continue
    const entry = entryOf(canvas, role, listed.has(id))
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** One library the person may use at `need`, or null: a library they may
 *  not reach reads exactly like one that does not exist. */
export function libraryFor(
  userId: string,
  libraryId: string,
  need: LibraryRole = 'read',
): { canvas: Canvas; role: LibraryRole } | null {
  const canvas = store.getCanvas(libraryId)
  const role = libraryRole(userId, canvas)
  if (!canvas || !libraryAllows(role, need)) return null
  return { canvas, role: role! }
}

export interface SearchRequest {
  query: string
  filters?: QueryFilters
  includeDrafts?: boolean
  limit?: number
  cursor?: string
  sort?: LibrarySort
}

const emptyFacets = (): Record<LibraryFacetName, LibraryFacet[]> => ({ kind: [], category: [], source: [], tag: [] })

function addFacets(into: Record<LibraryFacetName, LibraryFacet[]>, from: Record<LibraryFacetName, LibraryFacet[]>) {
  for (const name of Object.keys(into) as LibraryFacetName[]) {
    for (const facet of from[name]) {
      const known = into[name].find((f) => f.value === facet.value)
      if (known) known.count += facet.count
      else into[name].push({ ...facet })
    }
    into[name].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }
}

/** Search several libraries as one: each answers its best hits, merged by
 *  score; the cursor is an offset into the merged list. */
export async function searchLibraries(canvases: Canvas[], req: SearchRequest): Promise<LibrarySearchResult> {
  const limit = Math.max(1, Math.min(req.limit ?? 20, 60))
  const offset = Math.max(0, Number.parseInt(req.cursor ?? '0', 10) || 0)
  const merged: LibrarySearchHit[] = []
  const facets = emptyFacets()
  let total = 0
  for (const canvas of canvases) {
    const record = getLibrary(canvas.id)
    const index = await indexFor(canvas.id)
    if (!record || !index) continue
    const result = searchIndex(index, req.query, {
      limit: offset + limit,
      includeDrafts: req.includeDrafts,
      synonyms: record.rules.search.synonyms,
      filters: req.filters,
      sort: req.sort,
    })
    total += result.total
    addFacets(facets, result.facets)
    for (const hit of result.hits) {
      merged.push({
        libraryId: canvas.id,
        libraryName: canvas.name,
        item: summaryOf(hit.item),
        variants: hit.variants.map(summaryOf),
        variantCount: hit.variantCount,
        score: hit.score,
      })
    }
  }
  if (canvases.length > 1) merged.sort((a, b) => b.score - a.score)
  const hits = merged.slice(offset, offset + limit)
  const next = offset + limit
  return { hits, total, facets, ...(next < total ? { cursor: String(next) } : {}) }
}

/** One item, its variants and its family, as people see them. Hidden and
 *  draft items are there for curators only. */
export async function itemDetail(
  canvas: Canvas,
  itemId: string,
  role: LibraryRole,
): Promise<{ detail: LibraryItemDetail; item: LibraryItem } | null> {
  const items = await libraryItems(canvas.id)
  const curator = libraryAllows(role, 'curate')
  const visible = (it: LibraryItem) => curator || (it.status !== 'hidden' && it.status !== 'draft')
  const item =
    items.find((it) => it.itemId === itemId) ?? items.find((it) => it.itemId.toLowerCase() === itemId.toLowerCase())
  if (!item || !visible(item)) return null
  const familyId = item.parentId ?? item.itemId
  const variants = items
    .filter((it) => it.parentId === familyId && visible(it))
    .sort((a, b) => a.frameId.localeCompare(b.frameId) || a.position - b.position)
  const family = item.parentId ? items.find((it) => it.itemId === item.parentId) : undefined
  return {
    item,
    detail: {
      libraryId: canvas.id,
      libraryName: canvas.name,
      item: {
        ...summaryOf(item),
        description: item.description,
        sourceUrl: item.sourceUrl,
        license: item.license,
        findings: item.findings,
        useCount: item.useCount ?? 0,
      },
      variants: variants.map(summaryOf),
      family: family ? summaryOf(family) : null,
    },
  }
}
