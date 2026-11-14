import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { applyTransfer, planTransfer } = await import('../server/libraryImport.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const frame = (id: string, page: string): FrameSpec => ({ name: `${id} — ${id}`, html: `<p>${id}</p>`, page })

async function seed() {
  /* "Design Library": sheets on one page; "by function": the same ids sorted into pages */
  const target = libraryCanvas(
    ['cp.a-one', 'cp.a-two', 'cp.a-three', 'cp.a-only-here'].map((id) => frame(id, 'p1')),
    {
      id: 'sheets',
      pages: [{ id: 'p1', name: 'Everything' }],
    },
  )
  const source = libraryCanvas(
    [frame('cp.a-one', 'f1'), frame('cp.a-two', 'f1'), frame('cp.a-three', 'f2'), frame('cp.a-only-there', 'f2')],
    {
      id: 'byfn',
      pages: [
        { id: 'f1', name: '001 Inputs & forms · OTP' },
        { id: 'f2', name: '002 Auth · Log in' },
      ],
    },
  )
  source.frames = source.frames.map((f) => ({ ...f, id: `byfn-${f.id}`, canvasId: 'byfn' }))
  for (const f of [...target.frames, ...source.frames]) fakeDb.html.set(f.id, f.html)
  store.init([target, source])
  libraries.createLibrary('sheets', { preset: 'sheets' }, actor)
  libraries.createLibrary('byfn', { preset: 'sheets' }, actor)
  await indexer.reindexLibrary('sheets')
  await indexer.reindexLibrary('byfn')
}

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  await seed()
})

describe('taking categories from another library', () => {
  it('moves the shared ids and reports the rest', async () => {
    const before = structuredClone([...(fakeDb.items.get('byfn')?.values() ?? [])])
    const sourceMeta = fakeDb.meta.get('byfn')?.size ?? 0
    const plan = await applyTransfer('byfn', 'sheets', actor)
    expect(plan.matched.map((m) => m.itemId).sort()).toEqual(['cp.a-one', 'cp.a-three', 'cp.a-two'])
    expect(plan.onlyFrom).toEqual(['cp.a-only-there'])
    expect(plan.onlyTo).toEqual(['cp.a-only-here'])
    const items = await indexer.libraryItems('sheets')
    expect(items.find((i) => i.itemId === 'cp.a-one')?.category).toBe('Inputs & forms')
    expect(items.find((i) => i.itemId === 'cp.a-three')?.category).toBe('Auth')
    expect(items.find((i) => i.itemId === 'cp.a-only-here')?.category).toBe('Everything')
    /* only curation and the target's taxonomy changed; the source is untouched */
    expect([...(fakeDb.items.get('byfn')?.values() ?? [])]).toEqual(before)
    expect(fakeDb.meta.get('byfn')?.size ?? 0).toBe(sourceMeta)
    expect(
      libraries
        .getLibrary('sheets')!
        .taxonomy.categories.map((c) => c.path)
        .sort(),
    ).toEqual(['Auth', 'Inputs & forms'])
  })

  it('is a no-op the second time', async () => {
    await applyTransfer('byfn', 'sheets', actor)
    const again = await applyTransfer('byfn', 'sheets', actor)
    expect(again.changes).toBe(0)
  })

  it('plans without writing on a dry run', async () => {
    const plan = await applyTransfer('byfn', 'sheets', actor, { dryRun: true })
    expect(plan.changes).toBe(3)
    expect(fakeDb.meta.get('sheets')?.size ?? 0).toBe(0)
    expect(planTransfer([], []).matched).toEqual([])
  })
})
