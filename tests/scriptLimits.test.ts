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
/* a chainable sharp double: every resize the comparison paths perform is
   recorded, and buffers come back sized to what was asked for — the second
   image differs at pixel 0 so region scans have a difference to find */
const sharpCalls = vi.hoisted(() => ({ resizes: [] as [number, number][], toBuffers: 0 }))
vi.mock('sharp', () => ({
  default: () => {
    const chain: Record<string, unknown> = {}
    let dims: [number, number] = [10, 10]
    chain.flatten = () => chain
    chain.removeAlpha = () => chain
    chain.resize = (w: number, h: number) => {
      dims = [w, h]
      sharpCalls.resizes.push([w, h])
      return chain
    }
    chain.extend = () => chain
    chain.raw = () => chain
    chain.png = () => chain
    chain.metadata = async () => ({ width: 10, height: 10 })
    chain.toBuffer = async (opts?: { resolveWithObject?: boolean }) => {
      const data = Buffer.alloc(dims[0] * dims[1] * 3)
      if (++sharpCalls.toBuffers % 2 === 0) data[0] = 255
      return opts?.resolveWithObject ? { data, info: { channels: 3 } } : data
    }
    return chain
  },
}))

import { diffRegions, dispatchScriptCall, type ScriptRunContext } from '../server/scriptSdk.ts'
import { createFrame } from '../server/actions.ts'
import { store } from '../server/store.ts'
import { renderFrame } from '../server/screenshot.ts'

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

  it('refuses a predictably too-large frame before the renderer is asked', async () => {
    /* 5000×3500 needs 70MB of raw pixels — over budget before a byte
       renders, so the expensive capture never runs */
    const frame = createFrame(
      canvasId,
      { name: 'Big', html: '<html><body>x</body></html>', width: 5000, height: 3500 },
      { kind: 'user', name: 'O', color: '#000' },
    )!
    const render = vi.mocked(renderFrame)
    render.mockClear()
    await expect(dispatchScriptCall(runCtx(), 'checks.snapshot', [frame.id])).rejects.toThrow(/snapshot_bytes/)
    expect(render).not.toHaveBeenCalled()
  })
})

describe('checks.diff memory bounds', () => {
  it('preflights the fresh capture against the snapshot budget before rendering', async () => {
    /* a 5000×3500 frame needs 70MB of raw pixels — the capture is host
       memory whether it is kept or not, so the renderer is never asked */
    const ctx = runCtx()
    const big = createFrame(
      canvasId,
      { name: 'Big', html: '<html><body>x</body></html>', width: 5000, height: 3500 },
      { kind: 'user', name: 'O', color: '#000' },
    )!
    ctx.snapshots.set('s1', { frameId: big.id, png: Buffer.alloc(4), width: 10, height: 10 })
    const render = vi.mocked(renderFrame)
    render.mockClear()
    await expect(dispatchScriptCall(ctx, 'checks.diff', [big.id, { id: 's1' }])).rejects.toThrow(/snapshot_bytes/)
    expect(render).not.toHaveBeenCalled()
  })

  it('bounds the region buffers to a shared pixel budget and maps boxes back to the fresh render', async () => {
    sharpCalls.resizes.length = 0
    sharpCalls.toBuffers = 0
    /* a portrait-vs-landscape pair: the naive max-width × max-height box
       is 12 megapixels — 72MB of raw RGB the guest never sees */
    const boxes = await diffRegions(Buffer.alloc(4), Buffer.alloc(4), 4000, 3000, 4000, 3000)
    for (const [w, h] of sharpCalls.resizes) expect(w * h).toBeLessThanOrEqual(4_000_000)
    /* the lone differing pixel, reported in the fresh render's space */
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.x).toBe(0)
    expect(boxes[0]!.y).toBe(0)
    expect(boxes[0]!.width).toBeGreaterThanOrEqual(40)
    expect(boxes[0]!.width).toBeLessThanOrEqual(48)
  })
})
