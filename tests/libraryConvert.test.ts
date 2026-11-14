import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RULE_PRESETS } from '../shared/libraryRules'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, names } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const DAY = 24 * 60 * 60 * 1000

/** The live layout, reduced: a page of a domain with a § section and a
 *  sheet under it, a card with no section, and every real name besides. */
function seed() {
  const canvas = libraryCanvas(
    [
      { name: '§ Inputs A — Text fields & core inputs', html: '<p>§</p>', page: 'p13', y: 0, height: 88 },
      { fixture: 'sheet-static', page: 'p13', y: 200 },
      { fixture: 'card-exploded', page: 'p14', y: 0 },
      ...names()
        .filter((n) => !n.name.startsWith('bk.scb-login —') && !n.name.startsWith('cp.scb-login-button-passkey-dark'))
        .map((n, i) => ({ name: n.name, html: `<p>${i}</p>`, page: 'p99', y: i * 700 })),
    ],
    {
      pages: [
        { id: 'p13', name: '013 Inputs & forms · Checkboxes & choice cards + Whole forms & validation + Switches' },
        { id: 'p14', name: '013 Inputs & forms · Checkboxes & choice cards + Whole forms & validation + Switches' },
        { id: 'p99', name: 'Everything else' },
      ],
    },
  )
  for (const f of canvas.frames) fakeDb.html.set(f.id, f.html)
  store.init([canvas])
  return store.getCanvas(canvas.id)!
}

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
})

describe('converting a canvas', () => {
  it('proposes the taxonomy from the sections and the pages', async () => {
    seed()
    const preview = await indexer.previewIndex('lib1', RULE_PRESETS.sheets)
    const paths = preview.taxonomy.categories.map((c) => c.path)
    expect(paths).toContain('Inputs/Text fields & core inputs')
    expect(paths).toContain('Inputs & forms')
    expect(preview.taxonomy.kinds.map((k) => k.id)).toEqual(expect.arrayContaining(['bk', 'cp', 'mo']))
    expect(preview.taxonomy.kinds.find((k) => k.id === 'rs')?.insertable).toBe(false)
    expect(preview.taxonomy.sources.map((s) => s.id)).toContain('scb')
  })

  it('changes no frame', async () => {
    const canvas = seed()
    const before = canvas.frames.map((f) => [f.id, f.updatedAt])
    libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
    await indexer.reindexLibrary('lib1')
    expect(store.getCanvas('lib1')!.frames.map((f) => [f.id, f.updatedAt])).toEqual(before)
  })

  it('restores the curation when converted again within 30 days', async () => {
    seed()
    libraries.createLibrary('lib1', { preset: 'sheets' }, actor, 1_000)
    await indexer.reindexLibrary('lib1')
    await indexer.saveMeta({
      canvasId: 'lib1',
      itemId: 'bk.scb-login',
      label: null,
      description: null,
      category: null,
      tags: ['curated'],
      status: null,
      useCount: 0,
      lastUsedAt: null,
      updatedAt: 1,
      updatedBy: 'Owner',
    })
    libraries.disableLibrary('lib1', actor, 2_000)
    indexer.dropIndex('lib1')
    libraries.createLibrary('lib1', {}, actor, 2_000 + 5 * DAY)
    await indexer.reindexLibrary('lib1')
    const items = await indexer.libraryItems('lib1')
    expect(items.find((i) => i.itemId === 'bk.scb-login')?.tags).toEqual(['curated'])
  })

  it('purges a library disabled more than 30 days ago, and keeps a 29-day-old one', async () => {
    seed()
    const other = libraryCanvas([{ name: 'Home', html: '<p>x</p>' }], { id: 'lib2' })
    store.init([other])
    libraries.createLibrary('lib1', { preset: 'blank' }, actor, 0)
    libraries.createLibrary('lib2', { preset: 'blank' }, actor, 0)
    libraries.disableLibrary('lib1', actor, 1_000)
    libraries.disableLibrary('lib2', actor, 1_000 + 2 * DAY)
    const purged = await libraries.purgeDisabledLibraries(1_000 + 31 * DAY)
    expect(purged).toEqual(['lib1'])
    expect(libraries.allRecords().map((r) => r.canvasId)).toEqual(['lib2'])
  })
})
