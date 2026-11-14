import { describe, expect, it, vi } from 'vitest'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, syntheticItems } from './libraryFixtures'

/* The spec's budgets on 10,000 items, through the server's own path: rows
   loaded and indexed by indexFor, searched by searchLibraries (what
   GET /api/libraries/search answers). Times carry a 3x margin for a loaded
   machine; memory is measured on the heap with a wide margin. */

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { searchLibraries } = await import('../server/libraryQueries.ts')

const MARGIN = 3
const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }

describe('library budgets at 10,000 items', () => {
  it('builds, answers and stays small', async () => {
    fakeDb.reset()
    const items = syntheticItems(10_000)
    const rows = new Map(items.map((i) => [i.itemId, i]))
    fakeDb.items.set('lib1', rows)
    const canvas = libraryCanvas([], { id: 'lib1', ownerId: 'owner' })
    store.init([canvas])
    libraries.createLibrary('lib1', { preset: 'sheets' }, actor)

    const heapBefore = process.memoryUsage().heapUsed
    const t0 = performance.now()
    const index = await indexer.indexFor('lib1')
    const build = performance.now() - t0
    const heapDelta = process.memoryUsage().heapUsed - heapBefore
    expect(index?.items.length).toBe(10_000)
    expect(build).toBeLessThan(400 * MARGIN)
    expect(heapDelta).toBeLessThan(40 * 1024 * 1024 * MARGIN)

    const queries = ['login', 'card bu', 'otp', 'kind:cp table', 'in:"Auth/Log in" modal', 'toast dark', 'chart', 'x']
    const times: number[] = []
    let largest = 0
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      const result = await searchLibraries([store.getCanvas('lib1')!], {
        query: queries[i % queries.length]!,
        limit: 20,
      })
      times.push(performance.now() - t)
      largest = Math.max(largest, JSON.stringify(result).length)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(15 * MARGIN)
    expect(largest).toBeLessThan(60 * 1024)
  }, 60_000)
})
