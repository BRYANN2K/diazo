/**
 * ⌘F's Library scope: a library search answered by the index, turned into
 * the rows the find bar already lists. A family is a group, its matched
 * variants the entries under it.
 */
import type { LibraryItemSummary, LibrarySearchResult } from '../../shared/library'
import { NON_INSERTABLE_KINDS } from '../../shared/libraryRules'
import { rowItem, type FrameGroup, type ResultRow } from './findRows'
import type { ItemFocus } from './findPreviewRuntime'
import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from './store'

/* whether this person has any library, asked once per page load */
let hasLibraries: Promise<boolean> | null = null

/** Does this person have a design library? Asked once per page load. */
export function personHasLibraries(): Promise<boolean> {
  /* through a resolved promise: an api without the call (a test's mock) is a "no" */
  hasLibraries ??= Promise.resolve()
    .then(() => api.listLibraries())
    .then((r) => r.libraries.length > 0)
    .catch(() => false)
  return hasLibraries
}

/** For tests: forget whether this person has libraries. */
export function resetHasLibrariesForTest(): void {
  hasLibraries = null
}

/** True once this person is known to have a library (or the canvas is one). */
export function useHasLibraries(): boolean {
  const isLibrary = useStore((s) => !!s.canvas?.library)
  const [has, setHas] = useState(false)
  useEffect(() => {
    let stale = false
    void personHasLibraries().then((yes) => {
      if (!stale) setHas(yes)
    })
    return () => {
      stale = true
    }
  }, [])
  return isLibrary || has
}

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
 *  variant itself, or the family's first matched variant, else the family.
 *  Told where the item is (its locator), not a text to look for: an element
 *  id is a selector, an anchor the design next to the id, a whole-frame
 *  item the frame. */
export function libraryFocus(row: ResultRow): ItemFocus {
  const item = rowItem(row)
  const shown = row.variant ? item : (row.group.inside[0]?.item ?? item)
  if (!shown) return { key: row.group.id ?? row.group.label, text: row.group.id ?? row.group.label }
  return focusOfItem(shown)
}

/** An item's focus from its locator. */
export function focusOfItem(item: LibraryItemSummary): ItemFocus {
  const loc = item.locator
  if ('elementId' in loc) {
    return { key: item.id, text: item.id, selector: `[data-doop-id="${loc.elementId.replace(/["\\]/g, '')}"]` }
  }
  if ('anchor' in loc) return { key: item.id, text: loc.anchor, anchor: true }
  return { key: item.id, text: '' }
}

/** Where a person opens a library item: its canvas, on its frame. */
export function itemCanvasUrl(libraryId: string, item: LibraryItemSummary): string {
  return `/c/${libraryId}?frame=${item.frameId}`
}
