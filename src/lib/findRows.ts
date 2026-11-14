/**
 * The rows of ⌘F's remote scopes: text hits grouped by frame (every page,
 * everywhere), or library families with their variants (the Library scope,
 * built by findLibrary.ts). Pure, so the list renders either the same way.
 */
import type { CanvasFindHit } from '../../shared/canvasFind'
import type { LibraryItemSummary } from '../../shared/library'
import { splitFrameName } from '../../shared/libraryIds'

/** Something matched inside a group: a text snippet, or a library variant. */
export interface InsideEntry {
  label: string
  hit?: CanvasFindHit
  item?: LibraryItemSummary
}

/** One group of the remote results: a frame with every match found in it,
 *  or a library family with its matched variants. */
export interface FrameGroup {
  /** what tells two groups apart (the frame id, unless several share it) */
  key?: string
  frameId: string
  pageId: string
  pageName: string
  canvasName?: string
  /** library frames are named `<library_id> — <label>` */
  id: string | null
  label: string
  hits: CanvasFindHit[]
  /** the distinct things matched inside */
  inside: InsideEntry[]
  /** set on a library family: the item, its library and its variant count */
  item?: LibraryItemSummary
  libraryId?: string
  variantCount?: number
}

export const groupKey = (g: FrameGroup) => g.key ?? g.frameId

export function groupByFrame(hits: CanvasFindHit[], query: string): FrameGroup[] {
  const q = query.trim().toLowerCase()
  const groups: FrameGroup[] = []
  const byId = new Map<string, FrameGroup>()
  for (const hit of hits) {
    let g = byId.get(hit.frameId)
    if (!g) {
      g = {
        frameId: hit.frameId,
        pageId: hit.pageId,
        pageName: hit.pageName,
        ...(hit.canvasName ? { canvasName: hit.canvasName } : {}),
        ...splitFrameName(hit.frameName),
        hits: [],
        inside: [],
      }
      byId.set(hit.frameId, g)
      groups.push(g)
    }
    g.hits.push(hit)
    if (hit.where === 'name') continue
    const label = `${hit.before.slice(-24)}${hit.text}${hit.after.slice(0, 24)}`.trim()
    if (!g.inside.some((x) => x.label === label)) g.inside.push({ label, hit })
  }
  return groups.sort((a, b) => relevance(b, q) - relevance(a, q))
}

/* what you searched for first: a frame named for it, then passing
   mentions; section headers (§) last */
export function relevance(g: FrameGroup, q: string): number {
  const id = (g.id ?? '').toLowerCase()
  const label = g.label.toLowerCase()
  let score = 0
  if (id.includes(q)) score += 1000
  if (id.split(/[.-]/).includes(q)) score += 400
  if (label.includes(q)) score += 300
  score += Math.min(g.hits.length, 20)
  if (g.label.startsWith('§') || id.startsWith('§')) score -= 2000
  return score
}

/** Groups listed in the remote results. */
export const MAX_GROUPS = 300

/** Entries listed under an expanded group. */
export const MAX_INSIDE = 40

/** One line of the remote results: a group, or an entry listed under it. */
export interface ResultRow {
  key: string
  group: FrameGroup
  groupIndex: number
  variant?: InsideEntry
}

export const rowKey = (g: FrameGroup, variant?: string) =>
  variant === undefined ? groupKey(g) : `${groupKey(g)}\n${variant}`
export const rowDomId = (key: string) => `find-row-${key.replace(/[^\w-]/g, '_')}`

/** Every visible row in list order: each group, then its entries when expanded. */
export function resultRows(groups: FrameGroup[], open: ReadonlySet<string>): ResultRow[] {
  return groups
    .slice(0, MAX_GROUPS)
    .flatMap((group, groupIndex) => [
      { key: rowKey(group), group, groupIndex },
      ...(open.has(groupKey(group))
        ? group.inside
            .slice(0, MAX_INSIDE)
            .map((variant) => ({ key: rowKey(group, variant.label), group, groupIndex, variant }))
        : []),
    ])
}

/** The library item a row stands for, if any. */
export function rowItem(row: ResultRow): LibraryItemSummary | null {
  return row.variant ? (row.variant.item ?? null) : (row.group.item ?? null)
}

/** What the preview frames, and an insert copies, for a text row. */
export function focusOf(row: ResultRow, query: string): string {
  if (row.variant?.item) return row.variant.item.id
  return row.variant?.label ?? defaultFocus(row.group, query)
}

/** What the preview frames when a group row (not an entry) is shown. */
export function defaultFocus(g: FrameGroup, query: string): string {
  const q = query.trim()
  if (g.item) return g.inside[0]?.item?.id ?? g.item.id
  return g.id && g.id.toLowerCase().includes(q.toLowerCase()) ? g.id : q
}
