/**
 * The rows of ⌘F's remote scopes (every page, everywhere): hits grouped by
 * frame, ranked, and the variants listed under an expanded frame. Pure, so
 * the list can take rows from another source than the text search.
 */
import type { CanvasFindHit } from '../../shared/canvasFind'
import { splitFrameName } from '../../shared/libraryIds'

/** One frame in the all-pages results, with every match found in it. */
export interface FrameGroup {
  frameId: string
  pageId: string
  pageName: string
  canvasName?: string
  /** library frames are named `<library_id> — <label>` */
  id: string | null
  label: string
  hits: CanvasFindHit[]
  /** the distinct things matched inside: library ids when the snippet holds one */
  inside: { label: string; hit: CanvasFindHit }[]
}

const LIBRARY_ID = /[a-z][\w-]*\.[\w.-]*[\w]/gi

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
    /* a library sheet's matches are its variants' ids: list those, once each */
    const around = hit.before + hit.text + hit.after
    const ids = [...around.matchAll(LIBRARY_ID)].map((m) => m[0]).filter((id) => id.toLowerCase().includes(q))
    const label = ids.find((id) => id !== g.id) ?? `${hit.before.slice(-24)}${hit.text}${hit.after.slice(0, 24)}`.trim()
    if (!g.inside.some((x) => x.label === label)) g.inside.push({ label, hit })
  }
  return groups.sort((a, b) => relevance(b, q) - relevance(a, q))
}

/* what you searched for first: a frame named for it, then a sheet holding
   variants of it, then passing mentions; section headers (§) last */
export function relevance(g: FrameGroup, q: string): number {
  const id = (g.id ?? '').toLowerCase()
  const label = g.label.toLowerCase()
  let score = 0
  if (id.includes(q)) score += 1000
  if (id.split(/[.-]/).includes(q)) score += 400
  if (label.includes(q)) score += 300
  score += Math.min(variantIds(g).length, 30) * 25
  score += Math.min(g.hits.length, 20)
  if (g.label.startsWith('§') || id.startsWith('§')) score -= 2000
  return score
}

export const looksLikeId = (s: string) => /^[a-z][\w-]*\.[\w.-]+$/i.test(s)
export const variantIds = (g: FrameGroup) => g.inside.filter((x) => looksLikeId(x.label))

/** Frames listed in the all-pages results. */
export const MAX_GROUPS = 300

/** Variants listed under an expanded frame. */
export const MAX_INSIDE = 40

/** One line of the all-pages results: a frame, or a variant listed under it. */
export interface ResultRow {
  key: string
  group: FrameGroup
  groupIndex: number
  variant?: { label: string; hit: CanvasFindHit }
}

export const rowKey = (g: FrameGroup, variant?: string) =>
  variant === undefined ? g.frameId : `${g.frameId}\n${variant}`
export const rowDomId = (key: string) => `find-row-${key.replace(/[^\w-]/g, '_')}`

/** Every visible row in list order: each frame, then its variants when expanded. */
export function resultRows(groups: FrameGroup[], open: ReadonlySet<string>): ResultRow[] {
  return groups
    .slice(0, MAX_GROUPS)
    .flatMap((group, groupIndex) => [
      { key: rowKey(group), group, groupIndex },
      ...(open.has(group.frameId)
        ? group.inside
            .slice(0, MAX_INSIDE)
            .map((variant) => ({ key: rowKey(group, variant.label), group, groupIndex, variant }))
        : []),
    ])
}

/** What the preview frames, and an insert copies, for a row. */
export function focusOf(row: ResultRow, query: string): string {
  return row.variant?.label ?? defaultFocus(row.group, query)
}

/** What the preview frames when a frame row (not a variant) is shown. */
export function defaultFocus(g: FrameGroup, query: string): string {
  const q = query.trim()
  return variantIds(g)[0]?.label ?? (g.id && g.id.toLowerCase().includes(q.toLowerCase()) ? g.id : q)
}
