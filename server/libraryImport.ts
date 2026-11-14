/**
 * Library imports: what the library's rules do to frames entering it, and
 * moving curation between libraries. Planning is pure; applying writes.
 * Spec: .context/specs/design-libraries.md, "Import rules" and "Migration".
 */
import type { Actor } from '../shared/types.ts'
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'
import { getLibrary, updateLibrary } from './libraries.ts'
import { itemMeta, libraryItems, saveMeta } from './libraryIndex.ts'

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
