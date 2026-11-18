import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Every page a script run loads — an explicit checks.* call or the
 *  automatic post-write review — renders offline: the server supplies its
 *  own /a/ assets and nothing else leaves the host. */

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: () => {},
}))

const checkFrame = vi.hoisted(() =>
  vi.fn(async (_frame: unknown, _priority?: string, _opts?: { offline?: boolean }) => ({
    score: 100,
    errors: 0,
    warnings: 0,
    issues: [],
    viewports: [],
    focus: {},
  })),
)
vi.mock('../server/frameChecks.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/frameChecks.ts')>()),
  checkFrame,
}))

const loadFramePage = vi.hoisted(() =>
  vi.fn(async (_frame: unknown, _opts?: { offline?: boolean }) => ({
    page: {
      /* a bare-bones slop snapshot: the real collector's stand-in, enough
         for lintSnapshot to score without a browser */
      evaluate: vi.fn(async () => ({ width: 0, height: 0, elements: [], allText: '', styleText: '' })),
    },
    close: vi.fn(async () => {}),
  })),
)
const renderFrame = vi.hoisted(() => vi.fn(async () => PNG_1PX))
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
vi.mock('../server/screenshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/screenshot.ts')>()),
  loadFramePage,
  renderFrame,
  rendererAvailable: () => true,
}))

/* the lint itself is on the network path — its rendered pass must ask the
   loader for the same offline policy as every other script check, so the
   real lintFrame runs here against the mocked page loader */
const lintFrame = vi.hoisted(() => vi.fn())
vi.mock('../server/lint.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../server/lint.ts')>()
  lintFrame.mockImplementation(orig.lintFrame)
  return { ...orig, lintFrame }
})

import { dispatchScriptCall, finishScriptReviews, type ScriptRunContext } from '../server/scriptSdk.ts'
import { allowFrameAsset } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'

const OWNER = 'owner-1'
let canvasId: string
let frameId: string

function runCtx(over: Partial<ScriptRunContext> = {}): ScriptRunContext {
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
    ...over,
  }
}

beforeEach(() => {
  checkFrame.mockClear()
  loadFramePage.mockClear()
  renderFrame.mockClear()
  lintFrame.mockClear()
  canvasId = store.createCanvas('Offline', OWNER).id
  frameId = actions.createFrame(
    canvasId,
    {
      name: 'Home',
      html: '<html><body><h1 data-doop-id="t">Hi</h1><img src="https://img.example/x.png"></body></html>',
      width: 800,
      height: 600,
    },
    { kind: 'user', name: 'Owner', color: '#000' },
  )!.id
})

describe('script checks load pages offline', () => {
  it('every explicit check asks for the offline policy', async () => {
    const ctx = runCtx()
    await dispatchScriptCall(ctx, 'checks.responsive', [frameId])
    await dispatchScriptCall(ctx, 'checks.measure', [frameId])
    await dispatchScriptCall(ctx, 'checks.snapshot', [frameId])
    await dispatchScriptCall(ctx, 'checks.review', [frameId])
    await dispatchScriptCall(ctx, 'checks.autofix', [frameId])

    expect(checkFrame).toHaveBeenCalled()
    for (const call of checkFrame.mock.calls) expect(call[2]).toEqual({ offline: true })
    expect(loadFramePage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ offline: true }))
    expect(renderFrame).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ offline: true }))
  })

  it('the automatic post-write review renders offline too', async () => {
    const ctx = runCtx()
    await dispatchScriptCall(ctx, 'frames.edit', [frameId, [{ op: 'text', element: 't', text: 'Changed' }]])
    expect(checkFrame).not.toHaveBeenCalled()

    checkFrame.mockClear()
    await finishScriptReviews(ctx)

    expect(checkFrame).toHaveBeenCalledOnce()
    expect(checkFrame.mock.calls[0]![2]).toEqual({ offline: true })
  })

  it('the lint pass itself loads the page offline — explicit and shared review alike', async () => {
    /* a frame whose html names a remote image: an online lint would reach
       its origin while scoring, so the real lintFrame must ask the loader
       for the offline policy on every script path that renders it */
    const ctx = runCtx()
    await dispatchScriptCall(ctx, 'checks.lint', [frameId])
    await dispatchScriptCall(ctx, 'checks.review', [frameId])
    await dispatchScriptCall(ctx, 'frames.edit', [frameId, [{ op: 'text', element: 't', text: 'Changed' }]])

    expect(lintFrame).toHaveBeenCalled()
    expect(loadFramePage).toHaveBeenCalled()
    for (const call of loadFramePage.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ offline: true }))
    }
  })
})

describe('the offline allowlist', () => {
  const origin = 'http://localhost:4400'

  it('serves the server’s own assets in both modes', () => {
    for (const offline of [false, true]) {
      expect(allowFrameAsset(new URL(`${origin}/a/img.png`), origin, offline)).toBe(true)
      expect(allowFrameAsset(new URL(`${origin}/api/other`), origin, offline)).toBe(false)
    }
  })

  it('drops the webfont hosts when a load is offline', () => {
    expect(allowFrameAsset(new URL('https://fonts.googleapis.com/css2?family=x'), origin, false)).toBe(true)
    expect(allowFrameAsset(new URL('https://fonts.gstatic.com/s/x.woff2'), origin, false)).toBe(true)
    expect(allowFrameAsset(new URL('https://fonts.googleapis.com/css2?family=x'), origin, true)).toBe(false)
    expect(allowFrameAsset(new URL('https://fonts.gstatic.com/s/x.woff2'), origin, true)).toBe(false)
  })

  it('never allows an ordinary remote asset', () => {
    for (const offline of [false, true]) {
      expect(allowFrameAsset(new URL('https://img.example/x.png'), origin, offline)).toBe(false)
    }
  })
})
