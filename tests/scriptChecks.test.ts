import { beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: vi.fn(),
  saveFrame: vi.fn(),
  saveActivity: vi.fn(),
  saveTask: vi.fn(),
  saveFrameVersion: vi.fn(),
  saveToken: vi.fn(),
}))
vi.mock('../server/lint.ts', () => ({ lintFrame: async () => ({ score: 100, errors: 0, warnings: 0, issues: [] }) }))
vi.mock('../server/frameChecks.ts', () => ({
  checkFrame: async () => ({
    score: 80,
    errors: 1,
    warnings: 1,
    issues: [
      { ruleId: 'FC-TAP', severity: 'warning', message: 'small target', elementId: 'cta', widths: [375] },
      {
        ruleId: 'FC-CONTRAST',
        severity: 'error',
        message: 'low contrast',
        elementId: 'cta',
        widths: [375],
        detail: '#eeeeee on #ffffff',
      },
    ],
    viewports: [{ width: 375, overflowPx: 12 }],
    focus: null,
  }),
}))
const page = vi.hoisted(() => ({
  on: vi.fn(),
  evaluate: vi.fn(async () => ({
    overflowPx: 12,
    clippedText: 1,
    overlaps: [],
    outside: [],
    brokenImages: [],
    fallbackFonts: [],
    consoleErrors: [],
  })),
}))
vi.mock('../server/screenshot.ts', () => ({
  rendererAvailable: () => true,
  loadFramePage: async () => ({ page, close: async () => {} }),
  renderFrame: vi.fn(),
  /* motionRender's renderDeps reads openIsolatedPage when its module loads */
  openIsolatedPage: vi.fn(),
}))
import { renderFrame } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { dispatchScriptCall, type ScriptRunContext } from '../server/scriptSdk.ts'

let ctx: ScriptRunContext, frameId: string
beforeEach(() => {
  const canvas = store.createCanvas('Checks', 'owner')
  const actor = { kind: 'user' as const, name: 'Owner', color: '#000' }
  const frame = actions.createFrame(
    canvas.id,
    {
      name: 'Home',
      html: `<!DOCTYPE html><html><body>\n<!-- keep exactly -->\n<button data-doop-id='cta' class='custom'>Go</button>\n</body></html>`,
      width: 10,
      height: 10,
    },
    actor,
  )!
  frameId = frame.id
  ctx = {
    canvasId: canvas.id,
    userId: 'owner',
    actor,
    write: true,
    dryRun: false,
    runId: 'checks',
    budgets: { frameWrites: 40, snapshotBytes: 64 * 1024 * 1024 },
    snapshots: new Map(),
    writes: [],
  }
})
it('aggregates rendered errors and numeric layout data without images', async () => {
  const review = (await dispatchScriptCall(ctx, 'checks.review', [frameId])) as {
    errors: unknown[]
    responsive: { score: number }
    measure: { overflowPx: number }
  }
  expect(review.errors).toHaveLength(1)
  expect(review.responsive.score).toBe(80)
  expect(review.measure.overflowPx).toBe(12)
  expect(JSON.stringify(review)).not.toContain('base64')
})
it('autofix changes only the affected attribute and reports each mechanical fix', async () => {
  actions.createTokens(ctx.canvasId, [{ name: '--ink', type: 'color', value: '#111111' }], ctx.actor)
  const before = store.getFrame(frameId)!.html
  const result = (await dispatchScriptCall(ctx, 'checks.autofix', [frameId, ['tapTarget', 'contrast']])) as {
    changes: string[]
  }
  const after = store.getFrame(frameId)!.html
  expect(result.changes).toHaveLength(2)
  /* the managed token block rides with the new var(--ink) reference */
  expect(after.replace(/ style="[^"]*"/, '').replace(/<style data-doop-tokens>[^<]*<\/style>/, '')).toBe(before)
  expect(after).toContain('min-width: 44px')
  expect(after).toContain('color: var(--ink)')
})
it('returns zero for identical pixels and a nonzero ratio after a change', async () => {
  const white = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
  const black = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
    .png()
    .toBuffer()
  vi.mocked(renderFrame).mockResolvedValue(white)
  const snap = await dispatchScriptCall(ctx, 'checks.snapshot', [frameId])
  expect(await dispatchScriptCall(ctx, 'checks.diff', [frameId, snap])).toMatchObject({ ratio: 0, resized: false })
  vi.mocked(renderFrame).mockResolvedValue(black)
  expect(await dispatchScriptCall(ctx, 'checks.diff', [frameId, snap])).toMatchObject({ ratio: 1 })
})
it('streams section updates in order before the result', async () => {
  const updates: string[] = []
  actions.wire(
    (_id, msg) => {
      if (msg.type === 'frame:updated') updates.push(msg.frame.html)
    },
    () => {},
  )
  const html = '<html><body><section>First</section><section>Second</section></body></html>'
  try {
    await dispatchScriptCall(ctx, 'frames.stream', [frameId, html])
    expect(updates.some((s) => s.includes('First') && !s.includes('Second'))).toBe(true)
    expect(store.getFrame(frameId)!.html).toBe(html)
  } finally {
    actions.wire(
      () => {},
      () => {},
    )
  }
})
