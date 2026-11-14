/**
 * ⌘F's Library scope: a library search answered by the index, turned into
 * the rows the find bar already lists. A family is a group, its matched
 * variants the entries under it.
 */
import type { LibraryItemSummary, LibrarySearchResult } from '../../shared/library'
import { NON_INSERTABLE_KINDS } from '../../shared/libraryRules'
import { rowItem, type FrameGroup, type ResultRow } from './findRows'

/** Family groups, best first, each with its matched variants. */
export function libraryRows(result: LibrarySearchResult): FrameGroup[] {
  return result.hits.map((hit) => ({
    key: `${hit.libraryId}:${hit.item.id}`,
    frameId: hit.item.frameId,
    pageId: hit.item.pageId,
    pageName: hit.item.category,
    canvasName: hit.libraryName,
    id: hit.item.id,
    label: hit.item.label,
    hits: [],
    inside: hit.variants.map((v) => ({ label: v.id, item: v })),
    item: hit.item,
    libraryId: hit.libraryId,
    variantCount: hit.variantCount,
  }))
}

/** May this item be copied into a frame? Resources and rule cards may not. */
export function isInsertable(item: LibraryItemSummary | null | undefined): item is LibraryItemSummary {
  return !!item && !NON_INSERTABLE_KINDS.has(item.kind)
}

/** What the preview frames, and an insert copies, for a library row: the
 *  variant itself, or the family's first matched variant, else the family. */
export function libraryFocus(row: ResultRow): string {
  const item = rowItem(row)
  const shown = row.variant ? item : (row.group.inside[0]?.item ?? item)
  if (!shown) return row.group.id ?? row.group.label
  if ('anchor' in shown.locator) return shown.locator.anchor
  return shown.id
}

/** Where a person opens a library item: its canvas, on its frame. */
export function itemCanvasUrl(libraryId: string, item: LibraryItemSummary): string {
  return `/c/${libraryId}?frame=${item.frameId}`
}
