import { beforeEach, expect, it, vi } from 'vitest'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const curation = await import('../server/libraryCuration.ts')
const { runLibraryTool } = await import('../server/libraryTools.ts')

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const context = (userId: string | undefined) => ({
  userId,
  actor: { name: 'Agent', kind: 'agent' as const, color: '#000' },
  libraries: async () => [],
  canEdit: () => false,
})

beforeEach(() => {
  curation.resetCurationsForTest()
  fakeDb.reset()
  const canvas = libraryCanvas(
    [
      { id: 't1', name: 'hero.x-a — Hero', html: page('<h1>Launch your AI product today</h1>') },
      { id: 't2', name: 'bk.x-faq — FAQ', html: page('<h2>Questions people ask about billing</h2>') },
    ],
    { id: 'srcT', ownerId: 'u1' },
  )
  for (const f of canvas.frames) fakeDb.html.set(f.id, f.html)
  store.init([canvas])
  curation.setCurationModels(async () => ({
    main: {
      label: 'Stub',
      complete: async () => ({
        text: '{"categories":[{"name":"Heroes","children":[{"name":"AI"}]},{"name":"Sections","children":[{"name":"FAQ"}]}]}',
      }),
    },
    bulk: { label: 'Stub', complete: async () => ({ text: '{"a":{"1":"c2","2":"c4"}}' }) },
  }))
})

it('lets an agent start a curation for its human and read the proposed tree', async () => {
  const started = await runLibraryTool('start_library_curation', { canvas_ids: ['srcT'] }, context('u1'))
  expect(started.ok).toBe(true)
  const id = (started as { data: { id: string } }).data.id
  await curation.curationSettled(id)
  const read = await runLibraryTool('get_library_curation', { curation_id: id }, context('u1'))
  expect(read).toMatchObject({
    ok: true,
    data: {
      status: 'ready',
      totals: { entries: 2, unclassified: 0 },
      categories: [
        { path: 'Heroes', items: 1, children: [{ path: 'Heroes/AI', examples: ['Hero'] }] },
        { path: 'Sections', items: 1 },
      ],
    },
  })
  const list = await runLibraryTool('get_library_curation', {}, context('u1'))
  expect((list as { data: { curations: unknown[] } }).data.curations).toHaveLength(1)
})

it('keeps curations to their human', async () => {
  expect(await runLibraryTool('start_library_curation', { canvas_ids: ['srcT'] }, context('u2'))).toMatchObject({
    ok: false,
    error: 'canvas srcT not found',
  })
  const started = await runLibraryTool('start_library_curation', { canvas_ids: ['srcT'] }, context('u1'))
  const id = (started as { data: { id: string } }).data.id
  await curation.curationSettled(id)
  expect(await runLibraryTool('get_library_curation', { curation_id: id }, context('u2'))).toMatchObject({ ok: false })
  expect(await runLibraryTool('get_library_curation', {}, context(undefined))).toMatchObject({ ok: false })
})
