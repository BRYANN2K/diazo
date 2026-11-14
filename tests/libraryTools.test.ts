import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
vi.mock('../server/referenceLibrary.ts', () => ({
  getLibraryCanvasIds: async () => [],
  libraryFor: async () => [],
  LIBRARY_MAX_CANVASES: 8,
}))

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const tools = await import('../server/libraryTools.ts')

const actor = { name: 'Agent', kind: 'agent' as const, color: '#000' }
const FIXTURES: FrameSpec[] = [{ fixture: 'sheet-static' }, { fixture: 'sheet-scripted' }, { fixture: 'card-exploded' }]

async function seed(id: string, ownerId: string): Promise<Canvas> {
  const canvas = libraryCanvas(FIXTURES, { id, ownerId, name: `Library ${id}` })
  canvas.frames = canvas.frames.map((f) => ({ ...f, id: `${id}-${f.id}`, canvasId: id }))
  for (const f of canvas.frames) fakeDb.html.set(f.id, f.html)
  store.init([canvas])
  libraries.createLibrary(id, { preset: 'sheets' }, actor)
  await indexer.reindexLibrary(id)
  return store.getCanvas(id)!
}

const context = (userId: string) => ({ userId, actor, libraries: () => tools.librariesOf(userId) })
const run = (name: string, input: Record<string, unknown>, userId = 'owner') =>
  tools.runLibraryTool(name, input, context(userId))

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  await seed('lib1', 'owner')
  await seed('lib2', 'someone-else')
})

describe('the library read tools', () => {
  it('lists the libraries the account can use, with counts, kinds and categories', async () => {
    const out = await run('list_libraries', {})
    expect(out.ok).toBe(true)
    const data = (out as { data: { libraries: Record<string, unknown>[] } }).data
    expect(data.libraries).toHaveLength(1)
    expect(data.libraries[0]).toMatchObject({ id: 'lib1', families: 3, variants: 2 })
    expect(data.libraries[0]!.kinds).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'bk', families: 1 })]),
    )
  })

  it('reads one library', async () => {
    const out = await run('get_library', { library_id: 'lib1' })
    expect(out).toMatchObject({ ok: true, data: { id: 'lib1', families: 3, index: { status: 'done' } } })
    const data = (out as { data: { rules: string[]; categories: unknown[] } }).data
    expect(data.rules.length).toBeGreaterThan(2)
    expect(data.categories.length).toBeGreaterThan(0)
  })

  it('searches families with a thumbnail and a url', async () => {
    const out = await run('search_library', { query: 'login' })
    const data = (out as { data: { hits: Record<string, unknown>[] } }).data
    expect(data.hits[0]).toMatchObject({
      library_id: 'lib1',
      id: 'bk.scb-login',
      variant_count: 2,
      thumbnail: expect.stringMatching(/^\/i\/lib1-f1\.jpg\?preview$/),
      url: '/l/lib1/i/bk.scb-login',
    })
  })

  it('reads an item and, when asked, its frame html', async () => {
    const out = await run('get_library_item', { library_id: 'lib1', item_id: 'bk.scb-login-minimal-email-password' })
    expect(out).toMatchObject({
      ok: true,
      data: { family: { id: 'bk.scb-login' }, source_url: 'https://shadcnblocks.com/blocks/login' },
    })
    const withHtml = await run('get_library_item', { library_id: 'lib1', item_id: 'bk.scb-login', include_html: true })
    expect(withHtml).toMatchObject({ ok: true, data: { fidelity: 'frame' } })
    expect((withHtml as { data: { html: string } }).data.html).toContain('shadcnblocks · Login')
  })

  it('answers a library the account cannot read like a missing one', async () => {
    const theirs = await run('get_library', { library_id: 'lib2' })
    const nothing = await run('get_library', { library_id: 'nope' })
    expect(theirs.ok).toBe(false)
    expect(nothing.ok).toBe(false)
    expect((theirs as { error: string }).error.replace('lib2', 'X')).toBe(
      (nothing as { error: string }).error.replace('nope', 'X'),
    )
    expect((await run('search_library', { query: 'login', library_id: 'lib2' })).ok).toBe(false)
  })

  it('says what a family and a variant are, and names no table', () => {
    for (const tool of tools.DESIGN_LIBRARY_TOOLS) {
      expect(tool.description).not.toMatch(/library_items|library_item_meta|libraries table/)
    }
    const search = tools.DESIGN_LIBRARY_TOOLS.find((t) => t.name === 'search_library')!
    expect(search.description).toMatch(/A family is/)
    expect(search.description).toMatch(/variants are/)
  })
})
