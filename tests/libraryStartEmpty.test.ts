import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RULE_PRESETS } from '../shared/libraryRules'
import { fakeDb } from './libraryFakeDb'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const curation = await import('../server/libraryCuration.ts')
const { runLibraryTool } = await import('../server/libraryTools.ts')
const { searchLibraries } = await import('../server/libraryQueries.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  curation.resetCurationsForTest()
  fakeDb.reset()
  store.init([])
})

describe('starting categories', () => {
  it('cleans typed paths: tidy levels, three at most, parents listed, duplicates folded', () => {
    expect(
      curation.cleanCategoryPaths([
        '01 Components / Buttons',
        'components/buttons',
        'Sections/Pricing · A–L/Tiers/Too deep',
        '',
        42,
      ]),
    ).toEqual(['Components', 'Components/Buttons', 'Sections', 'Sections/Pricing', 'Sections/Pricing/Tiers'])
    expect(curation.cleanCategoryPaths('Heroes\nHeroes/AI')).toEqual(['Heroes', 'Heroes/AI'])
    expect(curation.cleanCategoryPaths(undefined)).toEqual([])
  })

  it('asks the person’s own model for a tree from one line', async () => {
    const seen: string[] = []
    curation.setCurationModels(async () => ({
      main: {
        label: 'Stub',
        complete: async (turn) => {
          seen.push(turn.user)
          return { text: '{"categories":[{"name":"Heroes","children":[{"name":"AI"}]},{"name":"Pricing"}]}' }
        },
      },
      bulk: { label: 'Stub', complete: async () => ({ text: '' }) },
    }))
    expect(await curation.suggestCategories('u1', 'Marketing sites for AI start-ups')).toEqual([
      'Heroes',
      'Heroes/AI',
      'Pricing',
    ])
    expect(seen[0]).toContain('Marketing sites for AI start-ups')
    curation.setCurationModels(async () => null)
    await expect(curation.suggestCategories('u1', 'x')).rejects.toMatchObject({ status: 409 })
  })
})

describe('an empty library', () => {
  it('indexes, searches and lists with no item', async () => {
    const canvas = store.createCanvas('Fresh library', 'u1')
    libraries.createLibrary(
      canvas.id,
      {
        rules: RULE_PRESETS.blank,
        taxonomy: { kinds: [], sources: [], categories: [{ path: 'Components' }] },
      },
      actor,
    )
    await indexer.reindexLibrary(canvas.id)
    expect(libraries.getLibrary(canvas.id)?.indexState).toMatchObject({ status: 'done', total: 0, done: 0 })
    expect(libraries.getLibrary(canvas.id)?.counts).toEqual({ items: 0, variants: 0 })
    const found = await searchLibraries([store.getCanvas(canvas.id)!], { query: 'button' })
    expect(found).toMatchObject({ hits: [], total: 0 })
    const context = {
      userId: 'u1',
      actor,
      libraries: async () => [store.getCanvas(canvas.id)!],
      canEdit: () => true,
    }
    const listed = await runLibraryTool('list_libraries', {}, context)
    expect(listed).toMatchObject({ ok: true, data: { libraries: [{ id: canvas.id, families: 0, variants: 0 }] } })
    const searched = await runLibraryTool('search_library', { query: 'button', library_id: canvas.id }, context)
    expect(searched.ok).toBe(true)
    const read = await runLibraryTool('get_library', { library_id: canvas.id }, context)
    expect(read.ok).toBe(true)
  })
})
