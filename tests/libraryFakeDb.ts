/**
 * An in-memory stand-in for server/db/persist.ts in the design-library unit
 * tests: the library tables as maps, frame HTML by id, and no-ops for the
 * rest of what the store writes. Use as
 *   vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
 */
import type { LibraryItem, LibraryItemMeta } from '../shared/library'

export const fakeDb = {
  items: new Map<string, Map<string, LibraryItem>>(),
  meta: new Map<string, Map<string, LibraryItemMeta>>(),
  html: new Map<string, string>(),
  savedLibraries: [] as unknown[],
  versions: [] as { frameId: string; html: string }[],
  reset() {
    this.versions.length = 0
    this.items.clear()
    this.meta.clear()
    this.html.clear()
    this.savedLibraries.length = 0
  },
}

function table(canvasId: string) {
  let t = fakeDb.items.get(canvasId)
  if (!t) fakeDb.items.set(canvasId, (t = new Map()))
  return t
}

function metaTable(canvasId: string) {
  let t = fakeDb.meta.get(canvasId)
  if (!t) fakeDb.meta.set(canvasId, (t = new Map()))
  return t
}

export function fakePersist() {
  return {
    saveCanvas: () => {},
    saveCanvasCopy: async () => {},
    saveFrame: () => {},
    saveFramePage: () => {},
    saveActivity: () => {},
    saveFrameVersion: (v: { frameId: string; html: string }) => {
      fakeDb.versions.push({ frameId: v.frameId, html: v.html })
    },
    deleteFrame: () => {},
    deleteCanvas: () => {},
    frameWritePending: () => false,
    pendingVersionWrites: async () => {},
    loadFrameHtml: async () => [...fakeDb.html].map(([id, html]) => ({ id, html })),
    loadOneFrameHtml: async (id: string) => fakeDb.html.get(id) ?? null,
    saveLibrary: async (row: unknown) => {
      fakeDb.savedLibraries.push(structuredClone(row))
    },
    loadLibraries: async () => [],
    copyItemMeta: async (from: string, to: string) => {
      for (const m of metaTable(from).values()) metaTable(to).set(m.itemId, { ...m, canvasId: to })
    },
    loadLibraryItems: async (canvasId: string) => [...table(canvasId).values()].map((r) => structuredClone(r)),
    loadItemMeta: async (canvasId: string) => [...metaTable(canvasId).values()].map((m) => structuredClone(m)),
    saveItemMeta: async (meta: LibraryItemMeta) => {
      metaTable(meta.canvasId).set(meta.itemId, structuredClone(meta))
    },
    replaceFrameItems: async (canvasId: string, frameId: string, items: LibraryItem[]) => {
      const t = table(canvasId)
      for (const [id, row] of t) if (row.frameId === frameId) t.delete(id)
      for (const item of items) t.set(item.itemId, structuredClone(item))
    },
    deleteItemsOfFrame: async (canvasId: string, frameId: string) => {
      const t = table(canvasId)
      for (const [id, row] of t) if (row.frameId === frameId) t.delete(id)
    },
    deleteLibraryItems: async (canvasId: string) => {
      fakeDb.items.delete(canvasId)
    },
  }
}
