import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveTask: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

const searchIcons = vi.hoisted(() =>
  vi.fn(async (_q: string, _opts?: { limit?: number }) => [{ id: 'mdi:a', svg_url: 'u' }]),
)
const searchPhotos = vi.hoisted(() =>
  vi.fn(async (_q: string, _opts?: { count?: number }) => [
    { image_url: 'u', width: 1, height: 1, alt: '', avg_color: '#fff', photographer: 'p' },
  ]),
)
const searchLogos = vi.hoisted(() => vi.fn(async (_q: string) => [{ name: 'n', domain: 'd', logo_url: 'u' }]))
vi.mock('../server/imageSearch.ts', () => ({ searchIcons, searchPhotos, searchLogos }))

const searchLibraries = vi.hoisted(() =>
  vi.fn(async (_c: unknown[], _opts?: { query?: string; limit?: number }) => ({ hits: [] as unknown[] })),
)
const readableLibraries = vi.hoisted(() => vi.fn(async () => []))
vi.mock('../server/libraryQueries.ts', () => ({
  searchLibraries,
  readableLibraries,
  libraryFor: vi.fn(() => null),
  itemDetail: vi.fn(async () => null),
}))

import { dispatchScriptCall, type ScriptRunContext } from '../server/scriptSdk.ts'
import { store } from '../server/store.ts'

const OWNER = 'owner-1'

let canvasId: string

function runCtx(): ScriptRunContext {
  return {
    canvasId,
    userId: OWNER,
    actor: { kind: 'agent', name: 'Script', color: '#000', runId: 'run-1' },
    write: true,
    dryRun: false,
    runId: 'run-1',
    budgets: { frameWrites: 40 },
    snapshots: new Map(),
    writes: [],
  }
}

beforeEach(() => {
  canvasId = store.createCanvas('Limits', OWNER).id
  searchIcons.mockClear()
  searchPhotos.mockClear()
  searchLibraries.mockClear()
})

describe('search call limits are clamped', () => {
  it('search.icons clamps the guest limit', async () => {
    await dispatchScriptCall(runCtx(), 'search.icons', ['arrow', { limit: 100_000 }])
    expect(searchIcons.mock.calls[0]![1]?.limit).toBeLessThanOrEqual(48)
    await dispatchScriptCall(runCtx(), 'search.icons', ['arrow', { limit: -5 }])
    expect(searchIcons.mock.calls[1]![1]?.limit).toBeGreaterThanOrEqual(1)
  })

  it('search.images clamps the guest limit', async () => {
    await dispatchScriptCall(runCtx(), 'search.images', ['sky', { limit: 100_000 }])
    expect(searchPhotos.mock.calls[0]![1]?.count).toBeLessThanOrEqual(8)
    await dispatchScriptCall(runCtx(), 'search.images', ['sky', { limit: 0 }])
    expect(searchPhotos.mock.calls[1]![1]?.count).toBeGreaterThanOrEqual(1)
  })

  it('libraries.search clamps the guest limit', async () => {
    await dispatchScriptCall(runCtx(), 'libraries.search', ['button', { limit: 100_000 }])
    expect(searchLibraries.mock.calls[0]![1]?.limit).toBeLessThanOrEqual(60)
    await dispatchScriptCall(runCtx(), 'libraries.search', ['button', { limit: 0 }])
    expect(searchLibraries.mock.calls[1]![1]?.limit).toBeGreaterThanOrEqual(1)
  })
})
