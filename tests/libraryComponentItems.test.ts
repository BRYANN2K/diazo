import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

/* Component items: inserted as linked instances (the component imported
   once), and a snapshot item promoted to one keeps its id. */

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const snapshots = await import('../server/librarySnapshot.ts')
const components = await import('../server/componentActions.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const BUTTON = '<!doctype html><html><body><button class="btn" data-doop-id="bbbbbb">Buy</button></body></html>'

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  snapshots.setSnapshotRenderer({ available: () => false, snapshot: async () => null })
  actions.wire(
    () => {},
    () => {},
  )
  const lib = libraryCanvas([{ name: 'cp.ui-button — Button', html: BUTTON, id: 'btnframe' }], {
    id: 'lib1',
    ownerId: 'owner',
  })
  const target: Frame = {
    id: 'target',
    canvasId: 'proj',
    pageId: 'pp',
    name: 'Page',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html: '<!doctype html><html><body><main data-doop-id="mmmmmm">x</main></body></html>',
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'x',
  }
  store.init([
    lib,
    {
      id: 'proj',
      name: 'Project',
      ownerId: 'owner',
      createdAt: 1,
      updatedAt: 1,
      pages: [{ id: 'pp', name: 'P' }],
      frames: [target],
    },
  ])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
  await indexer.reindexLibrary('lib1')
})

const item = async () => (await indexer.libraryItems('lib1')).find((i) => i.itemId === 'cp.ui-button')!

describe('component items', () => {
  it('promotes a snapshot item; it reindexes as a component with the same id', async () => {
    expect((await item()).mode).toBe('snapshot')
    const { componentId } = await snapshots.promoteItem(await item(), actor)
    expect(store.getCanvas('lib1')!.components?.some((c) => c.id === componentId)).toBe(true)
    await indexer.reindexFrame('lib1', 'btnframe')
    const after = await item()
    expect(after.itemId).toBe('cp.ui-button')
    expect(after.mode).toBe('component')
  })

  it('inserts a linked instance, importing the component once', async () => {
    await snapshots.promoteItem(await item(), actor)
    await indexer.reindexFrame('lib1', 'btnframe')
    const first = await snapshots.insertItem({ item: await item(), frameId: 'target', actor })
    const html = store.getFrame('target')!.html
    expect(html).toContain('data-doop-instance')
    expect(first.elementId).toBeTruthy()
    const imported = store.getCanvas('proj')!.components ?? []
    expect(imported).toHaveLength(1)
    expect(imported[0]!.source).toMatchObject({ canvasId: 'lib1' })
    await snapshots.insertItem({ item: await item(), frameId: 'target', actor })
    expect(store.getCanvas('proj')!.components).toHaveLength(1)
    expect(store.getFrame('target')!.html.match(/data-doop-instance=/g)).toHaveLength(2)
    /* sync_component works on what arrived through the library */
    expect(() => components.syncComponent('proj', imported[0]!.id, actor, () => true)).not.toThrow()
  })
})
