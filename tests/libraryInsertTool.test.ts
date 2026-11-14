import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
vi.mock('../server/referenceLibrary.ts', () => ({
  getLibraryCanvasIds: async () => [],
  libraryFor: async () => [],
  LIBRARY_MAX_CANVASES: 20,
}))

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const snapshots = await import('../server/librarySnapshot.ts')
const tools = await import('../server/libraryTools.ts')

const actor = { name: 'Agent', kind: 'agent' as const, color: '#000' }
const FIXTURES: FrameSpec[] = [{ fixture: 'sheet-static' }, { name: 'rs.scb-notes — Notes', html: '<p>notes</p>' }]
const TARGET = '<!doctype html><html><body><main data-doop-id="mmmmmm">Hi</main></body></html>'

function project(id: string): Frame {
  return {
    id: `${id}-f`,
    canvasId: id,
    pageId: 'p1',
    name: 'Login',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html: TARGET,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'x',
  }
}

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  snapshots.setSnapshotRenderer({ available: () => false, snapshot: async () => null })
  const lib = libraryCanvas(FIXTURES, { id: 'lib1', ownerId: 'owner' })
  for (const f of lib.frames) fakeDb.html.set(f.id, f.html)
  const pages = [{ id: 'p1', name: 'Page' }]
  store.init([
    lib,
    { id: 'proj', name: 'Project', ownerId: 'owner', createdAt: 1, updatedAt: 1, pages, frames: [project('proj')] },
    { id: 'other', name: 'Other', ownerId: 'owner', createdAt: 1, updatedAt: 1, pages, frames: [project('other')] },
  ])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
  await indexer.reindexLibrary('lib1')
})

const context = (over: Partial<Parameters<typeof tools.runLibraryTool>[2]> = {}) => ({
  userId: 'owner',
  actor,
  libraries: () => tools.librariesOf('owner'),
  canEdit: (id: string) => id !== 'other',
  ...over,
})
const insert = (input: Record<string, unknown>, over = {}) =>
  tools.runLibraryTool(
    'insert_library_item',
    { canvas_id: 'proj', frame_id: 'proj-f', library_id: 'lib1', item_id: 'bk.scb-login', ...input },
    context(over),
  )

describe('insert_library_item', () => {
  it('inserts and names the block and the frame it wrote', async () => {
    const out = await insert({ item_id: 'bk.scb-login-minimal-email-password' })
    expect(out).toMatchObject({ ok: true, frames: ['proj-f'], data: { fidelity: 'static' } })
    const id = (out as { data: { element_id: string } }).data.element_id
    expect(store.getFrame('proj-f')!.html).toContain(`data-doop-id="${id}"`)
    expect((out as { note: string }).note).toMatch(/keep its data-doop-ref/)
  })

  it('refuses a frame the account cannot edit', async () => {
    const out = await insert({ canvas_id: 'other', frame_id: 'other-f' })
    expect(out.ok).toBe(false)
    expect(store.getFrame('other-f')!.html).toBe(TARGET)
  })

  it('refuses a reference kind', async () => {
    const out = await insert({ item_id: 'rs.scb-notes' })
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/reference/) })
  })

  it('refuses a frame mid-stream', async () => {
    const spy = vi.spyOn(actions, 'isFrameStreaming').mockReturnValue(true)
    try {
      const out = await insert({})
      expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/being written/) })
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a resident run on its own canvas', async () => {
    const out = await insert({}, { canvas: store.getCanvas('other') })
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/its own canvas/) })
  })

  it('gives get_library_item the scoped block', async () => {
    const out = await tools.runLibraryTool(
      'get_library_item',
      { library_id: 'lib1', item_id: 'bk.scb-login-minimal-email-password', include_html: true },
      context(),
    )
    expect(out).toMatchObject({ ok: true, data: { fidelity: 'static' } })
    expect((out as { data: { html: string } }).data.html).toMatch(
      /^<div data-doop-ref="bk.scb-login-minimal-email-password"/,
    )
  })
})
