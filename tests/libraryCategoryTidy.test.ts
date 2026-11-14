import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RULE_PRESETS, sectionCategory, tidyCategory, tidyCategoryPart } from '../shared/libraryRules'
import { pageCategory } from '../server/libraryExtract'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
})

describe('tidying a category', () => {
  it('drops page numbers, alphabetical ranges and continuations', () => {
    expect(tidyCategoryPart('16 Pricing')).toBe('Pricing')
    expect(tidyCategoryPart('00 · Index')).toBe('Index')
    expect(tidyCategoryPart('013. Inputs & forms')).toBe('Inputs & forms')
    expect(tidyCategoryPart('AI products · A–L')).toBe('AI products')
    expect(tidyCategoryPart('AI products · L–Z')).toBe('AI products')
    expect(tidyCategoryPart('Testimonials (S–E)')).toBe('Testimonials')
    expect(tidyCategoryPart('Heroes · 2')).toBe('Heroes')
    expect(tidyCategoryPart('Heroes part 2')).toBe('Heroes')
    expect(tidyCategoryPart('16')).toBe('')
  })

  it('keeps what only looks like numbering', () => {
    expect(tidyCategoryPart('3D effects')).toBe('3D effects')
    expect(tidyCategoryPart('404 pages')).toBe('404 pages')
    expect(tidyCategoryPart('Blog, team & about')).toBe('Blog, team & about')
    expect(tidyCategoryPart('Log in')).toBe('Log in')
  })

  it('tidies every level of a path and drops the empty ones', () => {
    expect(tidyCategory('16/Blog, team & about')).toBe('Blog, team & about')
    expect(tidyCategory('16/Pricing')).toBe('Pricing')
    expect(tidyCategory('01 Heroes/AI products · A–L')).toBe('Heroes/AI products')
    expect(tidyCategory('16')).toBeNull()
  })

  it('reads numbered sections and pages without their numbers', () => {
    expect(sectionCategory('§ * — {category}', '§ 16 — Blog, team & about')).toBe('Blog, team & about')
    expect(sectionCategory('§ * — {category}', '§ 21 Marketing sections — Pricing')).toBe('Marketing sections/Pricing')
    expect(sectionCategory('§ * — {category}', '§ Heroes — AI products · A–L')).toBe('Heroes/AI products')
    expect(pageCategory('01 Heroes · AI products · A–L')).toBe('Heroes')
    expect(pageCategory('21 Marketing sections · Blog, team & about')).toBe('Marketing sections')
    expect(pageCategory('00 · Index')).toBe('Index')
  })
})

describe('the proposed taxonomy', () => {
  it('merges the categories numbering and splitting made apart', async () => {
    const canvas = libraryCanvas(
      [
        { name: '§ 16 — Pricing', html: '<p>§</p>', page: 'a', y: 0, height: 88 },
        { name: 'bk.x-pricing-one — One', html: '<p>one</p>', page: 'a', y: 200 },
        { name: '§ Heroes — AI products · A–L', html: '<p>§</p>', page: 'b', y: 0, height: 88 },
        { name: 'hero.x-alpha — Alpha', html: '<p>alpha</p>', page: 'b', y: 200 },
        { name: '§ Heroes — AI products · L–Z', html: '<p>§</p>', page: 'c', y: 0, height: 88 },
        { name: 'hero.x-zeta — Zeta', html: '<p>zeta</p>', page: 'c', y: 200 },
        { name: '§ 17 — pricing', html: '<p>§</p>', page: 'd', y: 0, height: 88 },
        { name: 'bk.x-pricing-two — Two', html: '<p>two</p>', page: 'd', y: 200 },
      ],
      {
        pages: [
          { id: 'a', name: '16 Marketing sections · Pricing' },
          { id: 'b', name: '01 Heroes · AI products · A–L' },
          { id: 'c', name: '02 Heroes · AI products · L–Z' },
          { id: 'd', name: '17 Marketing sections · Pricing' },
        ],
      },
    )
    for (const f of canvas.frames) fakeDb.html.set(f.id, f.html)
    store.init([canvas])
    const preview = await indexer.previewIndex('lib1', RULE_PRESETS.sheets)
    const paths = preview.taxonomy.categories.map((c) => c.path)
    expect(paths).toEqual(['Heroes/AI products', 'Pricing'])
    expect(preview.categories).toEqual([
      { path: 'Heroes/AI products', count: 2 },
      { path: 'Pricing', count: 2 },
    ])
    expect(paths.some((p) => /\d|A–L|L–Z/.test(p))).toBe(false)
  })
})
