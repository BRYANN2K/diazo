import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { fixture, libraryCanvas, FIXTURE_FRAMES } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { runImport } = await import('../server/libraryImport.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }

const projectFrame = (id: string, name: string, html: string): Frame => ({
  id,
  canvasId: 'proj',
  pageId: 'pp',
  name,
  x: 0,
  y: 0,
  width: 2040,
  height: 440,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'x',
})

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  actions.wire(
    () => {},
    () => {},
  )
  const lib = libraryCanvas([{ name: '§ Auth A — Log in', html: '<p>§</p>', id: 'sec' }], {
    id: 'lib1',
    pages: [{ id: 'p1', name: 'Auth' }],
  })
  store.init([
    lib,
    {
      id: 'proj',
      name: 'Project',
      ownerId: 'owner',
      createdAt: 1,
      updatedAt: 1,
      pages: [{ id: 'pp', name: 'Screens' }],
      frames: [
        projectFrame('sheet', FIXTURE_FRAMES['sheet-static'].name, fixture('sheet-static')),
        projectFrame('plain', 'Login screen', '<!doctype html><html><body><p>Log in</p></body></html>'),
      ],
    },
  ])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
  libraries.updateLibrary(
    'lib1',
    { rules: { ...libraries.getLibrary('lib1')!.rules, lint: { gate: 'off', minScore: 60, ignoreRules: [] } } },
    actor,
  )
  await indexer.reindexLibrary('lib1')
})

describe('applying an import', () => {
  it('copies a frame from a project canvas, never moves it', async () => {
    const before = store.getFrame('sheet')!.html
    const out = await runImport({ libraryId: 'lib1', frameIds: ['sheet'], category: 'Auth/Log in', actor })
    const copyId = out.applied[0]!.libraryFrameId!
    expect(copyId).not.toBe('sheet')
    const copy = store.getFrame(copyId)!
    expect(copy.canvasId).toBe('lib1')
    expect(copy.name).toBe('bk.scb-login — shadcnblocks · Login')
    expect(copy.pageId).toBe('p1')
    expect(copy.html).toContain('data-doop-variant="bk.scb-login-minimal-email-password"')
    expect(store.getFrame('sheet')!.html).toBe(before)
    expect(store.getFrame('sheet')!.canvasId).toBe('proj')
  })

  it('writes nothing on a dry run', async () => {
    const frames = store.getCanvas('lib1')!.frames.length
    const out = await runImport({ libraryId: 'lib1', frameIds: ['sheet'], dryRun: true, actor })
    expect(out.applied).toEqual([])
    expect(out.report.frames[0]!.item?.itemId).toBe('bk.scb-login')
    expect(store.getCanvas('lib1')!.frames).toHaveLength(frames)
  })

  it('keeps ready_for_dev when only markers are added in place', async () => {
    const inLib = actions.createFrame(
      'lib1',
      { name: FIXTURE_FRAMES['sheet-static'].name, html: fixture('sheet-static'), pageId: 'p1' },
      actor,
      { reveal: false },
    )!
    store.getFrame(inLib.id)!.approval = { status: 'ready_for_dev' } as Frame['approval']
    const out = await runImport({ libraryId: 'lib1', frameIds: [inLib.id], actor })
    expect(out.applied[0]).toMatchObject({ libraryFrameId: inLib.id })
    const after = store.getFrame(inLib.id)!
    expect(after.html).toContain('data-doop-variant=')
    expect(after.approval?.status).toBe('ready_for_dev')
  })

  it('leaves the earlier frames in place when one fails, and reports it', async () => {
    const real = actions.createFrame
    let calls = 0
    const spy = vi.spyOn(actions, 'createFrame').mockImplementation((...args) => {
      calls++
      return calls === 2 ? undefined : real(...args)
    })
    try {
      const out = await runImport({ libraryId: 'lib1', frameIds: ['sheet', 'plain'], actor })
      expect(out.applied[0]!.libraryFrameId).toBeDefined()
      expect(out.applied[1]!.error).toBeTruthy()
      expect(store.getFrame(out.applied[0]!.libraryFrameId!)).toBeDefined()
    } finally {
      spy.mockRestore()
    }
  })
})
