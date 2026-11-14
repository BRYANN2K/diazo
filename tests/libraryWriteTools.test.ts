import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

/* import_to_library and set_library_item: behind AGENT_LIBRARY_WRITES,
   the curate role and, for a resident run, its own canvas. */

const flags = vi.hoisted(() => ({ writes: true }))
vi.mock('../server/env.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/env.ts')>()
  return {
    ...mod,
    env: Object.defineProperty({ ...mod.env }, 'AGENT_LIBRARY_WRITES', { get: () => flags.writes }),
  }
})
vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
vi.mock('../server/referenceLibrary.ts', () => ({
  getLibraryCanvasIds: async () => [],
  libraryFor: async () => [],
  LIBRARY_MAX_CANVASES: 20,
}))

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const tools = await import('../server/libraryTools.ts')

const actor = { name: 'Agent', kind: 'agent' as const, color: '#000' }

beforeEach(async () => {
  flags.writes = true
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  const lib = libraryCanvas([{ name: 'cp.x-card — Card', html: '<p>card</p>' }], {
    id: 'lib1',
    ownerId: 'owner',
    name: 'Lib',
  })
  const theirs = libraryCanvas([{ name: 'cp.y-card — Card', html: '<p>y</p>' }], {
    id: 'lib2',
    ownerId: 'someone',
    name: 'Theirs',
  })
  theirs.linkAccess = 'view'
  theirs.frames = theirs.frames.map((f) => ({ ...f, id: 'lib2-f1', canvasId: 'lib2' }))
  const project = {
    id: 'proj',
    name: 'Project',
    ownerId: 'owner',
    createdAt: 1,
    updatedAt: 1,
    pages: [{ id: 'pp', name: 'P' }],
    frames: [
      {
        id: 'pf',
        canvasId: 'proj',
        pageId: 'pp',
        name: 'cp.x-new — New',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        html: '<p>new</p>',
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'x',
      } as Frame,
    ],
  }
  for (const c of [lib, theirs]) for (const f of c.frames) fakeDb.html.set(f.id, f.html)
  store.init([lib, theirs, project])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
  libraries.createLibrary('lib2', { preset: 'sheets' }, actor)
  await indexer.reindexLibrary('lib1')
  await indexer.reindexLibrary('lib2')
})

const context = (over = {}) => ({
  userId: 'owner',
  actor,
  libraries: () => tools.librariesOf('owner'),
  canEdit: () => true,
  canRead: () => true,
  ...over,
})
const run = (name: string, input: Record<string, unknown>, over = {}) =>
  tools.runLibraryTool(name, input, context(over))

describe('the library write tools', () => {
  it('refuse both and write nothing when the flag is off', async () => {
    flags.writes = false
    const frames = store.getCanvas('lib1')!.frames.length
    const imported = await run('import_to_library', { library_id: 'lib1', frame_ids: ['pf'] })
    const set = await run('set_library_item', { library_id: 'lib1', item_id: 'cp.x-card', status: 'hidden' })
    expect(imported).toEqual({ ok: false, error: tools.LIBRARY_WRITES_REFUSAL })
    expect(set).toEqual({ ok: false, error: tools.LIBRARY_WRITES_REFUSAL })
    expect(store.getCanvas('lib1')!.frames).toHaveLength(frames)
    expect(fakeDb.meta.get('lib1')?.size ?? 0).toBe(0)
  })

  it('writes nothing on a dry run, and imports otherwise', async () => {
    const frames = store.getCanvas('lib1')!.frames.length
    const dry = await run('import_to_library', { library_id: 'lib1', frame_ids: ['pf'], dry_run: true })
    expect(dry).toMatchObject({ ok: true, data: { dry_run: true, frames: [{ item_id: 'cp.x-new' }] } })
    expect(store.getCanvas('lib1')!.frames).toHaveLength(frames)
    const done = await run('import_to_library', { library_id: 'lib1', frame_ids: ['pf'] })
    expect(done.ok).toBe(true)
    expect(store.getCanvas('lib1')!.frames).toHaveLength(frames + 1)
  })

  it('curates an item, and not on a library the account only reads', async () => {
    const set = await run('set_library_item', { library_id: 'lib1', item_id: 'cp.x-card', tags: ['dark'] })
    expect(set).toMatchObject({ ok: true, data: { id: 'cp.x-card', tags: ['dark'] } })
    const theirs = await run('set_library_item', { library_id: 'lib2', item_id: 'cp.y-card', status: 'hidden' })
    expect(theirs.ok).toBe(false)
  })

  it('keeps a resident run to its own library', async () => {
    const out = await run(
      'import_to_library',
      { library_id: 'lib1', frame_ids: ['pf'] },
      { canvas: store.getCanvas('proj') },
    )
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/this run's canvas is not that library/) })
  })

  it('offers no tool that changes rules, visibility or the library itself', () => {
    const names = tools.DESIGN_LIBRARY_TOOL_NAMES
    expect(names).toEqual([
      'list_libraries',
      'get_library',
      'search_library',
      'get_library_item',
      'insert_library_item',
      'import_to_library',
      'set_library_item',
    ])
    for (const tool of tools.DESIGN_LIBRARY_TOOLS) {
      expect(Object.keys(tool.shape)).not.toEqual(expect.arrayContaining(['rules']))
      expect(Object.keys(tool.shape)).not.toEqual(expect.arrayContaining(['visibility']))
    }
  })
})
