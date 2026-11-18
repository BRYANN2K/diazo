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

/* deterministic sizes for the snapshot budget: a 64-byte PNG of 10×10 */
vi.mock('../server/screenshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/screenshot.ts')>()),
  renderFrame: vi.fn(async () => Buffer.alloc(64, 0x89)),
  rendererAvailable: () => true,
}))
vi.mock('sharp', () => ({ default: () => ({ metadata: async () => ({ width: 10, height: 10 }) }) }))

import { dispatchScriptCall, type ScriptRunContext } from '../server/scriptSdk.ts'
import { createFrame } from '../server/actions.ts'
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
    budgets: { frameWrites: 40, snapshotBytes: 64 * 1024 * 1024 },
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

describe('snapshot memory budget', () => {
  /* one shot costs 64 compressed bytes + 10×10 raw pixels = 464 */
  const COST = 64 + 10 * 10 * 4
  const mkFrame = () =>
    createFrame(
      canvasId,
      { name: 'S', html: '<html><body><h1>x</h1></body></html>', width: 10, height: 10 },
      { kind: 'user', name: 'O', color: '#000' },
    )!

  it('charges bytes and pixels before retaining, and refuses past the budget', async () => {
    const ctx = runCtx()
    ctx.budgets.snapshotBytes = COST + 1
    const frame = mkFrame()
    const first = (await dispatchScriptCall(ctx, 'checks.snapshot', [frame.id])) as { id: string }
    expect(first.id).toMatch(/^snap-/)
    expect(ctx.budgets.snapshotBytes).toBe(1)
    expect(ctx.snapshots.size).toBe(1)
    /* the second render never gets kept — the buffer is refused, not parked */
    await expect(dispatchScriptCall(ctx, 'checks.snapshot', [frame.id])).rejects.toThrow(/snapshot_bytes/)
    expect(ctx.snapshots.size).toBe(1)
  })
})
