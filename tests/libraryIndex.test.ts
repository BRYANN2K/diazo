import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
import type { LibraryItem, LibraryItemMeta } from '../shared/library'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

/* an in-memory stand-in for the library tables */
const db = vi.hoisted(() => ({
  items: new Map<string, Map<string, LibraryItem>>(),
  meta: new Map<string, LibraryItemMeta[]>(),
  html: new Map<string, string>(),
  failReplaceAt: -1,
  replaceCalls: 0,
}))

vi.mock('../server/db/persist.ts', () => {
  const table = (canvasId: string) => {
    let t = db.items.get(canvasId)
    if (!t) db.items.set(canvasId, (t = new Map()))
    return t
  }
  return {
    saveCanvas: () => {},
    saveFrame: () => {},
    saveFramePage: () => {},
    saveActivity: () => {},
    deleteFrame: () => {},
    deleteCanvas: () => {},
    frameWritePending: () => false,
    loadFrameHtml: async () => [...db.html].map(([id, html]) => ({ id, html })),
    loadOneFrameHtml: async (id: string) => db.html.get(id) ?? null,
    saveLibrary: async () => {},
    loadLibraries: async () => [],
    copyItemMeta: async () => {},
    loadLibraryItems: async (canvasId: string) => [...table(canvasId).values()].map((r) => structuredClone(r)),
    loadItemMeta: async (canvasId: string) => db.meta.get(canvasId) ?? [],
    saveItemMeta: async () => {},
    replaceFrameItems: async (canvasId: string, frameId: string, items: LibraryItem[]) => {
      db.replaceCalls++
      if (db.replaceCalls === db.failReplaceAt) throw new Error('the database went away')
      const t = table(canvasId)
      for (const [id, row] of t) if (row.frameId === frameId) t.delete(id)
      for (const item of items) t.set(item.itemId, structuredClone(item))
    },
    deleteItemsOfFrame: async (canvasId: string, frameId: string) => {
      const t = table(canvasId)
      for (const [id, row] of t) if (row.frameId === frameId) t.delete(id)
    },
    deleteLibraryItems: async (canvasId: string) => {
      db.items.delete(canvasId)
    },
  }
})

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { unloadHtml } = await import('../server/frameHtml.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const rows = (canvasId = 'lib1') => [...(db.items.get(canvasId)?.values() ?? [])]
const byId = (id: string, canvasId = 'lib1') => rows(canvasId).find((r) => r.itemId === id)

/** Seed a library whose frame HTML is not in memory, as after a boot. */
function seed(frames: FrameSpec[], opts: Parameters<typeof libraryCanvas>[1] = {}): Canvas {
  const canvas = libraryCanvas(frames, opts)
  for (const frame of canvas.frames) {
    db.html.set(frame.id, frame.html)
    unloadHtml(frame)
  }
  store.init([canvas])
  libraries.createLibrary(canvas.id, { preset: 'sheets' }, actor)
  return store.getCanvas(canvas.id)!
}

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  db.items.clear()
  db.meta.clear()
  db.html.clear()
  db.failReplaceAt = -1
  db.replaceCalls = 0
  vi.restoreAllMocks()
})

const FIXTURES: FrameSpec[] = [{ fixture: 'sheet-static' }, { fixture: 'sheet-scripted' }, { fixture: 'card-exploded' }]

describe('a full run', () => {
  it('indexes the fixtures to their families and variants', async () => {
    seed([...FIXTURES, { name: 'Plain', html: '<p>Hello</p>' }])
    await indexer.reindexLibrary('lib1')
    expect(
      rows()
        .map((r) => r.itemId)
        .sort(),
    ).toEqual([
      'bk.scb-login',
      'bk.scb-login-minimal-email-password',
      'bk.scb-login-social-with-email-option',
      'cp.scb-login-button-passkey-dark',
      'cp.tuff-answers',
      'plain',
    ])
    /* a frame with no id is still an item, flagged */
    expect(byId('plain')?.findings.map((f) => f.kind)).toEqual(['no-id'])
    expect(store.getCanvas('lib1')!.library).toMatchObject({ items: 4, variants: 2, index: { status: 'done' } })
  })

  it('counts 1 + 2 + 1 + 1 with a plain frame under blank', async () => {
    const canvas = libraryCanvas([...FIXTURES, { name: 'Plain', html: '<p>Hello</p>' }])
    store.init([canvas])
    libraries.createLibrary(canvas.id, { preset: 'blank' }, actor)
    libraries.updateLibrary(
      canvas.id,
      {
        rules: {
          ...libraries.getLibrary(canvas.id)!.rules,
          detect: { ignore: [], section: null, variants: { mode: 'auto' } },
        },
      },
      actor,
    )
    await indexer.reindexLibrary(canvas.id)
    expect(rows()).toHaveLength(1 + 2 + 1 + 1 + 1)
  })

  it('finds the exploded card a family when one exists', async () => {
    seed(FIXTURES)
    await indexer.reindexLibrary('lib1')
    expect(byId('cp.scb-login-button-passkey-dark')?.parentId).toBeNull()

    seed([...FIXTURES, { name: 'cp.scb-login-button — shadcnblocks · Auth entry buttons (8)', html: '<p>Buttons</p>' }])
    await indexer.reindexLibrary('lib1')
    expect(byId('cp.scb-login-button-passkey-dark')?.parentId).toBe('cp.scb-login-button')
  })

  it('never loads the canvas and keeps no frame html', async () => {
    const load = vi.spyOn(store, 'load')
    seed(FIXTURES)
    const before = store.stats().loaded
    await indexer.reindexLibrary('lib1')
    expect(load).not.toHaveBeenCalled()
    expect(store.stats().loaded).toBe(before)
  })

  it('resumes a run cut off after one batch', async () => {
    const frames: FrameSpec[] = Array.from({ length: 120 }, (_, i) => ({
      name: `cp.gen-item-${i} — Item ${i}`,
      html: `<p>Item ${i}</p>`,
    }))
    seed(frames)
    db.failReplaceAt = indexer.INDEX_BATCH + 1
    await indexer.reindexLibrary('lib1')
    expect(libraries.getLibrary('lib1')!.indexState).toMatchObject({ status: 'running', done: indexer.INDEX_BATCH })
    expect(rows()).toHaveLength(indexer.INDEX_BATCH)

    const read = vi.spyOn(store, 'renderableFrame')
    await Promise.all(indexer.resumeIndexing(libraries.allLibraries()))
    expect(read).toHaveBeenCalledTimes(120 - indexer.INDEX_BATCH)
    expect(rows()).toHaveLength(120)
    expect(libraries.getLibrary('lib1')!.indexState).toMatchObject({ status: 'done', done: 120, total: 120 })
  })
})

describe('one frame at a time', () => {
  it('bumps only the edited variant', async () => {
    const canvas = seed(FIXTURES)
    await indexer.reindexLibrary('lib1')
    const sheet = canvas.frames.find((f) => f.name.startsWith('bk.scb-login'))!
    await store.load('lib1')
    const html = db.html.get(sheet.id)!.replace('>Log in<', '>Log in now<')
    store.updateFrame(sheet.id, { html }, 'Owner')
    await indexer.reindexFrame('lib1', sheet.id)
    expect(byId('bk.scb-login')?.rev).toBe(1)
    expect(byId('bk.scb-login-minimal-email-password')?.rev).toBe(1)
    expect(byId('bk.scb-login-social-with-email-option')?.rev).toBe(2)
  })

  it('removes a deleted frame', async () => {
    const canvas = seed(FIXTURES)
    await indexer.reindexLibrary('lib1')
    const card = canvas.frames.find((f) => f.name.startsWith('cp.scb-login-button'))!
    store.deleteFrame(card.id)
    await indexer.reindexFrame('lib1', card.id)
    expect(byId('cp.scb-login-button-passkey-dark')).toBeUndefined()
    expect(store.getCanvas('lib1')!.library?.items).toBe(2)
  })

  it('moves a frame under another section', async () => {
    const canvas = seed([
      { name: '§ Auth A — Log in', html: '', y: 0, height: 88 },
      { fixture: 'card-exploded', y: 200 },
      { name: '§ Inputs A — Text fields', html: '', y: 2000, height: 88 },
    ])
    await indexer.reindexLibrary('lib1')
    expect(byId('cp.scb-login-button-passkey-dark')?.category).toBe('Auth/Log in')
    const card = canvas.frames.find((f) => f.name.startsWith('cp.'))!
    await store.load('lib1')
    store.updateFrame(card.id, { y: 2400 }, 'Owner')
    await indexer.reindexFrame('lib1', card.id)
    expect(byId('cp.scb-login-button-passkey-dark')?.category).toBe('Inputs/Text fields')
  })

  it('does nothing for a canvas that is not a library', async () => {
    const stop = indexer.wireIndexer()
    const other = libraryCanvas([{ name: 'Home', html: '<p>x</p>' }], { id: 'plain' })
    store.init([other])
    store.updateFrame(other.frames[0]!.id, { html: '<p>y</p>' }, 'Owner')
    expect(indexer.pendingFrames()).toBe(0)
    stop()
  })

  it('debounces a library frame write', async () => {
    vi.useFakeTimers()
    try {
      const canvas = seed(FIXTURES)
      const stop = indexer.wireIndexer()
      await indexer.reindexLibrary('lib1')
      const sheet = canvas.frames[0]!
      await store.load('lib1')
      store.updateFrame(sheet.id, { name: sheet.name + ' ' }, 'Owner')
      store.updateFrame(sheet.id, { name: sheet.name + '  ' }, 'Owner')
      expect(indexer.pendingFrames()).toBe(1)
      vi.advanceTimersByTime(indexer.FRAME_DEBOUNCE_MS + 10)
      expect(indexer.pendingFrames()).toBe(0)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the search index', () => {
  it('is built from the rows and dropped when idle', async () => {
    seed(FIXTURES)
    await indexer.reindexLibrary('lib1')
    const index = await indexer.indexFor('lib1')
    expect(index?.items).toHaveLength(5)
    expect(indexer.cachedIndexCount()).toBe(1)
    expect(indexer.evictIdleIndexes(Date.now() + indexer.INDEX_IDLE_MS + 1)).toBe(1)
    expect(indexer.cachedIndexCount()).toBe(0)
    expect(await indexer.indexFor('plain-not-a-library')).toBeNull()
  })
})
