import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem } from '../shared/library'
import { searchIndex } from '../shared/librarySearch'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

/* AI descriptions and tags (model mocked): off by default and silent when
   off, never over a person's words, 200 a day per library, a failure leaves
   the item alone, and an accepted suggestion becomes the item's own. */

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
const describerFor = vi.fn()
vi.mock('../server/imageDescriptions.ts', () => ({ describerFor: (...a: unknown[]) => describerFor(...a) }))

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const describing = await import('../server/libraryDescribe.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const model = vi.fn(async (item: LibraryItem) => ({ description: `About ${item.label}`, tags: ['shiny', 'thing'] }))

function setup(count: number) {
  const frames = Array.from({ length: count }, (_, i) => ({
    name: `cp.item-${i} — Item ${i}`,
    html: `<!doctype html><html><body><p>${i}</p></body></html>`,
    id: `f${i}`,
  }))
  store.init([libraryCanvas(frames, { id: 'lib1', ownerId: 'owner' })])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
}

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  describing.resetDescribeForTest()
  fakeDb.reset()
  model.mockClear()
  describerFor.mockClear()
  describing.setItemDescriber(model)
  setup(3)
  await indexer.reindexLibrary('lib1')
})

const meta = (id: string) => indexer.itemMeta('lib1', id)

describe('describing library items', () => {
  it('is off by default and calls no model while off', async () => {
    const off = describing.wireLibraryDescribe()
    describing.setItemDescriber(null) /* the real describer: it would ask describerFor */
    try {
      expect(libraries.getLibrary('lib1')!.describeItems ?? false).toBe(false)
      libraries.updateLibrary('lib1', { description: 'Kit' }, actor)
      expect(await describing.scheduleDescribe('lib1')).toBe(0)
      expect(describerFor).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('suggests where a person left fields empty, and never over their words', async () => {
    await indexer.saveMeta({
      canvasId: 'lib1',
      itemId: 'cp.item-1',
      label: null,
      description: null,
      category: null,
      tags: ['mine'],
      status: null,
      useCount: 0,
      lastUsedAt: null,
      updatedAt: 1,
      updatedBy: 'Owner',
    })
    libraries.updateLibrary('lib1', { describeItems: true }, actor)
    expect(await describing.describeLibrary('lib1')).toBe(3)
    expect((await meta('cp.item-0'))!.suggested).toMatchObject({
      description: 'About Item 0',
      tags: ['shiny', 'thing'],
    })
    const kept = (await meta('cp.item-1'))!
    expect(kept.tags).toEqual(['mine'])
    expect(kept.suggested).toMatchObject({ description: 'About Item 1', tags: null })
    /* findable at once */
    const index = (await indexer.indexFor('lib1'))!
    expect(searchIndex(index, 'shiny').hits.map((h) => h.item.itemId)).toContain('cp.item-0')
    /* a second pass asks nothing again */
    model.mockClear()
    expect(await describing.describeLibrary('lib1')).toBe(0)
    expect(model).not.toHaveBeenCalled()
  })

  it('accepts a suggestion into the item, or dismisses it for good', async () => {
    libraries.updateLibrary('lib1', { describeItems: true }, actor)
    await describing.describeLibrary('lib1')
    await describing.settleSuggestion('lib1', 'cp.item-0', true, 'Owner')
    const accepted = (await indexer.libraryItems('lib1')).find((i) => i.itemId === 'cp.item-0')!
    expect(accepted.description).toBe('About Item 0')
    expect(accepted.tags).toEqual(['shiny', 'thing'])
    await describing.settleSuggestion('lib1', 'cp.item-2', false, 'Owner')
    expect((await meta('cp.item-2'))!.description).toBeNull()
    model.mockClear()
    await describing.describeLibrary('lib1')
    expect(model).not.toHaveBeenCalled()
  })

  it('leaves an item as it was when the model fails', async () => {
    model.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    libraries.updateLibrary('lib1', { describeItems: true }, actor)
    expect(await describing.describeLibrary('lib1')).toBe(2)
    expect(await meta('cp.item-0')).toBeUndefined()
  })

  it('describes at most 200 items a day per library', async () => {
    libraries.resetLibrariesForTest()
    indexer.resetIndexerForTest()
    setup(205)
    await indexer.reindexLibrary('lib1')
    libraries.updateLibrary('lib1', { describeItems: true }, actor)
    const day = Date.UTC(2026, 10, 14, 12)
    expect(await describing.describeLibrary('lib1', day)).toBe(200)
    expect(model).toHaveBeenCalledTimes(200)
    expect(await describing.describeLibrary('lib1', day + 60_000)).toBe(0)
    expect(await describing.describeLibrary('lib1', day + 24 * 3600_000)).toBe(5)
  })

  it('reads the model answer strictly', () => {
    expect(describing.parseSuggestion('ok {"description":" A card ","tags":["Card","card","x"]}')).toEqual({
      description: 'A card',
      tags: ['card', 'x'],
    })
    expect(() => describing.parseSuggestion('no json')).toThrow()
  })
})
