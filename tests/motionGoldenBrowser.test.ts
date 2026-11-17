import { readFileSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

interface Rendered {
  hash: string
  grid: number[]
  drops: { fx: string; reason: string }[]
}

const GOLDEN_PATH = 'tests/fixtures/motion-golden.json'
/* regenerate the probe grids after an intentional shader/raster change:
   DOOP_GOLDEN_UPDATE=1 bunx vitest run tests/motionGoldenBrowser.test.ts */
const UPDATE = process.env.DOOP_GOLDEN_UPDATE === '1'

/* AC-14: the render is a pure function of t — the same seek twice, and a
   seek reached after a scrub through other times, paint the same bytes;
   every GL effect holds its golden frame within ±2/255 (GPU rounding) */
describe.skipIf(!findBrowserPath())('motion golden frames', () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.goto(fixtureUrl('motionGolden.html'))
    await page.waitForFunction(() => typeof (window as { render?: unknown }).render === 'function')
  }, 30_000)

  const render = (opts: Record<string, unknown> = {}) =>
    page.evaluate((o) => (window as unknown as { render: (o: unknown) => Promise<Rendered> }).render(o), opts)

  const fxIds = () => page.evaluate(() => (window as unknown as { motionGoldenFx: string[] }).motionGoldenFx)

  it('paints the same t twice bit-identically', async () => {
    const a = await render({ t: 1.25 })
    const b = await render({ t: 1.25 })
    expect(b.hash).toBe(a.hash)
  })

  it('paints a moving scene frame identically from every seek path', async () => {
    const direct = await render({ t: 0.5, scene: true })
    const again = await render({ t: 0.5, scene: true })
    /* t reached after a scrub through 0 and 0.25 on the same canvas */
    const scrubbed = await render({ seq: [0, 0.25], t: 0.5, scene: true })
    expect(again.hash).toBe(direct.hash)
    expect(scrubbed.hash).toBe(direct.hash)
  })

  it('shutter 0 is the hard shutter, and the blur is a pure function of t', async () => {
    const hard = await render({ t: 0.75 })
    const zero = await render({ t: 0.75, shutter: 0 })
    expect(zero.hash).toBe(hard.hash)
    /* the float accumulation makes no random choices: same t, same mean */
    const a = await render({ t: 0.75, shutter: 180, samples: 12, scene: true })
    const b = await render({ t: 0.75, shutter: 180, samples: 12, scene: true })
    expect(b.hash).toBe(a.hash)
    /* and a blurred frame actually differs from the hard one */
    expect(a.hash).not.toBe(hard.hash)
  })

  it('a cost over the sample cap still renders the same frame', async () => {
    /* samples 64 must clamp to the same 16 the cap allows: the render is
       bounded, and what it draws is the capped frame, not an error */
    const capped = await render({ t: 0.75, shutter: 180, samples: 64, scene: true })
    const bound = await render({ t: 0.75, shutter: 180, samples: 16, scene: true })
    expect(capped.hash).toBe(bound.hash)
  })

  it('renders every GL effect within ±2/255 of its golden frame', async () => {
    const ids = await fxIds()
    const actual: Record<string, number[]> = {}
    for (const fx of ids) {
      const out = await render({ fx, t: 0.5 })
      expect(out.drops, `${fx} dropped: ${JSON.stringify(out.drops)}`).toEqual([])
      actual[fx] = out.grid
    }
    if (UPDATE) {
      writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 1) + '\n')
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, number[]>
    for (const fx of ids) {
      const want = golden[fx]
      if (!want) throw new Error(`no golden for ${fx} — regenerate with DOOP_GOLDEN_UPDATE=1`)
      const got = actual[fx]!
      const drift = got.map((v, i) => Math.abs(v - want[i]!))
      expect(Math.max(...drift), `${fx} drifted past ±2/255`).toBeLessThanOrEqual(2)
    }
  })

  it('a missing WebGL2 context reports every stack effect undrawn — the 2D scene still paints', async () => {
    const out = await render({ fx: 'vignette', t: 0.5, noGl: true })
    expect(out.drops).toEqual([{ fx: 'vignette', reason: 'no WebGL2 context' }])
    /* the frame the 2D pass drew is still there — nothing silently blank */
    const plain = await render({ t: 0.5, noGl: true })
    expect(out.hash).toBe(plain.hash)
  })

  it('an effect with no GLSL body is reported, not skipped', async () => {
    /* 'bloom' is in the registry but ships no WebGL2 body in this build */
    const out = await render({ fx: 'bloom', t: 0.5 })
    expect(out.drops).toEqual([{ fx: 'bloom', reason: 'no shader in this build' }])
  })
})
