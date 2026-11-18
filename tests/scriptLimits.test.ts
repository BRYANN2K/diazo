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
  searchLibraries.mockClear()
})

describe('excluded tools have no SDK path', () => {
  it('search.* and compositions.render are refused at the host bridge', async () => {
    for (const path of ['search.icons', 'search.images', 'search.logos', 'compositions.render']) {
      await expect(dispatchScriptCall(runCtx(), path, ['arrow'])).rejects.toThrow(/unknown diazo function/)
    }
  })
})

describe('search call limits are clamped', () => {
  it('libraries.search clamps the guest limit', async () => {
    await dispatchScriptCall(runCtx(), 'libraries.search', ['button', { limit: 100_000 }])
    expect(searchLibraries.mock.calls[0]![1]?.limit).toBeLessThanOrEqual(60)
    await dispatchScriptCall(runCtx(), 'libraries.search', ['button', { limit: 0 }])
    expect(searchLibraries.mock.calls[1]![1]?.limit).toBeGreaterThanOrEqual(1)
  })
})
