import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ServerMessage } from '../shared/types'
import { RULE_PRESETS } from '../shared/libraryRules'
import { libraryCanvas } from './libraryFixtures'

const saved: unknown[] = []
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveCanvasCopy: async () => {},
  saveFrame: () => {},
  saveFramePage: () => {},
  saveActivity: () => {},
  deleteCanvas: () => {},
  loadFrameHtml: async () => [],
  loadOneFrameHtml: async () => null,
  frameWritePending: () => false,
  saveLibrary: async (row: unknown) => {
    saved.push(structuredClone(row))
  },
  loadLibraries: async () => [],
  copyItemMeta: async () => {},
}))

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const libraries = await import('../server/libraries.ts')

const sent: ServerMessage[] = []
actions.wire(
  (_canvasId, msg) => sent.push(msg),
  () => {},
)
const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }

function seed(over: Partial<Canvas> = {}): Canvas {
  const canvas = {
    ...libraryCanvas([{ fixture: 'sheet-static' }, { fixture: 'card-exploded' }, { name: '§ Auth A — Log in' }]),
    ...over,
  }
  store.init([canvas])
  return store.getCanvas(canvas.id)!
}

beforeEach(() => {
  libraries.resetLibrariesForTest()
  sent.length = 0
  saved.length = 0
})

describe('createLibrary', () => {
  it('picks the preset from the frame names, mirrors and broadcasts', () => {
    const canvas = seed()
    const record = libraries.createLibrary(canvas.id, {}, actor)
    expect(record?.rules).toEqual(RULE_PRESETS.sheets)
    expect(canvas.library).toMatchObject({ visibility: 'private', items: 0, variants: 0, rulesVersion: 1 })
    expect(sent).toEqual([{ type: 'library', library: canvas.library, actor }])
    expect(saved).toHaveLength(1)
  })

  it('takes blank for plain names', () => {
    const canvas = seed({ frames: libraryCanvas([{ name: 'Home' }, { name: 'Pricing' }]).frames })
    expect(libraries.createLibrary(canvas.id, {}, actor)?.rules).toEqual(RULE_PRESETS.blank)
  })

  it('writes no frame', () => {
    const canvas = seed()
    const before = canvas.frames.map((f) => [f.id, f.updatedAt, f.html])
    libraries.createLibrary(canvas.id, {}, actor)
    expect(canvas.frames.map((f) => [f.id, f.updatedAt, f.html])).toEqual(before)
  })
})

describe('libraryRole', () => {
  it('is manage, curate, read or nothing', () => {
    const canvas = seed({ ownerId: 'owner', memberIds: ['member'], linkAccess: 'view' })
    libraries.createLibrary(canvas.id, {}, actor)
    expect(libraries.libraryRole('owner', canvas)).toBe('manage')
    expect(libraries.libraryRole('member', canvas)).toBe('curate')
    expect(libraries.libraryRole('visitor', canvas)).toBe('read')
    canvas.linkAccess = undefined
    expect(libraries.libraryRole('visitor', canvas)).toBeNull()
  })

  it('is nothing on a canvas that is not a library', () => {
    const canvas = seed({ ownerId: 'owner' })
    expect(libraries.libraryRole('owner', canvas)).toBeNull()
  })
})

describe('disableLibrary', () => {
  it('clears canvas.library and keeps the row', () => {
    const canvas = seed()
    libraries.createLibrary(canvas.id, { preset: 'blank' }, actor)
    sent.length = 0
    expect(libraries.disableLibrary(canvas.id, actor)).toBe(true)
    expect(canvas.library).toBeUndefined()
    expect(libraries.getLibrary(canvas.id)).toBeUndefined()
    expect(libraries.allRecords().map((r) => r.canvasId)).toEqual([canvas.id])
    expect(saved.at(-1)).toMatchObject({ canvasId: canvas.id, disabledAt: expect.any(Number) })
    expect(sent).toEqual([{ type: 'library', library: null, actor }])
  })

  it('restores the rules when converted again within 30 days', () => {
    const canvas = seed()
    libraries.createLibrary(canvas.id, { preset: 'blank' }, actor, 1_000)
    libraries.updateLibrary(canvas.id, { description: 'Kept' }, actor, 2_000)
    libraries.disableLibrary(canvas.id, actor, 3_000)
    const again = libraries.createLibrary(canvas.id, { preset: 'sheets' }, actor, 4_000)
    expect(again?.description).toBe('Kept')
    expect(again?.rules).toEqual(RULE_PRESETS.blank)
    const late = libraries.disableLibrary(canvas.id, actor, 5_000)
    expect(late).toBe(true)
    const fresh = libraries.createLibrary(canvas.id, {}, actor, 5_000 + libraries.DISABLED_KEEP_MS)
    expect(fresh?.description).toBe('')
  })
})

describe('updateLibrary', () => {
  it('bumps the rules version only when the rules change', () => {
    const canvas = seed()
    libraries.createLibrary(canvas.id, { preset: 'blank' }, actor)
    libraries.updateLibrary(canvas.id, { rules: RULE_PRESETS.blank }, actor)
    expect(canvas.library?.rulesVersion).toBe(1)
    libraries.updateLibrary(canvas.id, { rules: RULE_PRESETS.sheets }, actor)
    expect(canvas.library?.rulesVersion).toBe(2)
  })

  it('refuses invalid rules with their paths', () => {
    const canvas = seed()
    libraries.createLibrary(canvas.id, { preset: 'blank' }, actor)
    const result = libraries.updateLibrary(canvas.id, { rules: { version: 2 } }, actor)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.map((e) => e.path)).toContain('version')
  })
})

describe('copies and deletions', () => {
  it('a duplicated library is a library, private', async () => {
    const canvas = seed({ ownerId: 'owner' })
    const stop = libraries.wireLibraries()
    libraries.createLibrary(canvas.id, { preset: 'sheets' }, actor)
    libraries.updateLibrary(canvas.id, { visibility: 'workspace' }, actor)
    const copy = await store.duplicateCanvas(canvas.id, 'owner', 'Owner')
    await vi.waitFor(() => expect(libraries.getLibrary(copy!.id)).toBeDefined())
    expect(libraries.getLibrary(copy!.id)?.rules).toEqual(RULE_PRESETS.sheets)
    expect(copy!.library?.visibility).toBe('private')
    store.deleteCanvas(copy!.id)
    expect(libraries.allRecords().some((r) => r.canvasId === copy!.id)).toBe(false)
    stop()
  })
})
