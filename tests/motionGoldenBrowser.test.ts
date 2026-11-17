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

/* the params that make every body's mark on the frame visible: neutral
   defaults (identity grade, zero shift) would draw the untouched picture,
   and the matte/alpha readers get the channels the fixture scene feeds */
const FX_PARAMS: Record<string, Record<string, number | string | boolean>> = {
  'color-grade': { exposure: 0.5, contrast: 0.3, saturation: 0.5 },
  'hue-shift': { degrees: 80 },
  curves: { gamma: 2.4, black: 0.08, lift: 0.06 },
  bloom: { threshold: 0.45, intensity: 1.2, radius: 8 },
  'film-grain': { amount: 0.4, size: 2 },
  noise: { amount: 0.35, scale: 3 },
  scanlines: { count: 24, opacity: 0.45 },
  'displacement-map': { amount: 10 },
  'luma-matte': { channel: 'alpha', softness: 0.15 },
  feather: { amount: 3 },
  choke: { amount: 5 },
}

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

  /* 43 effects, each rendered twice — the sweep lives past the 5 s default */
  it('renders every GL effect within ±2/255 of its golden frame', { timeout: 120_000 }, async () => {
    const ids = await fxIds()
    const plain = await render({ t: 0.5 })
    const actual: Record<string, number[]> = {}
    for (const fx of ids) {
      const params = FX_PARAMS[fx]
      const out = await render({ fx, params, t: 0.5 })
      const again = await render({ fx, params, t: 0.5 })
      expect(out.drops, `${fx} dropped: ${JSON.stringify(out.drops)}`).toEqual([])
      /* every body is a pure function of (t, seed): same seek, same bytes */
      expect(again.hash, `${fx} differed on a repeated render at the same t`).toBe(out.hash)
      /* and it must actually do something — a grid equal to the untouched
         picture means a dead body, a neutral default or a scene the body
         cannot see (no alpha, nothing over threshold) */
      expect(out.hash, `${fx} left the frame untouched`).not.toBe(plain.hash)
      expect(
        out.grid.some((v, i) => v !== plain.grid[i]),
        `${fx} probed the untouched picture`,
      ).toBe(true)
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

  it('chains mixed multi-pass effects without a feedback drop', { timeout: 60_000 }, async () => {
    /* the review chain: vignette's mix lands the input on a ping-pong
       buffer, bloom's sub-passes overwrite it and its mix blends against
       the tex[2] snapshot, lens blur follows — on the old pipeline the
       last snapshot rendered into the texture it sampled */
    const chain = {
      stack: [
        { fx: 'vignette', params: { amount: 0.6 }, mix: 0.5 },
        { fx: 'bloom', params: { threshold: 0.45, radius: 8 }, mix: 0.5 },
        { fx: 'lens-blur', params: { radius: 4 } },
      ],
      t: 0.5,
    }
    const out = await render(chain)
    expect(out.drops, `chain dropped: ${JSON.stringify(out.drops)}`).toEqual([])
    const again = await render(chain)
    expect(again.hash).toBe(out.hash)
    /* two single-pass mixes land the input on the scratch texture itself —
       the multi-pass effect after them must skip its snapshot copy, not
       sample the texture it renders into */
    const scratch = {
      stack: [
        { fx: 'vignette', params: { amount: 0.6 }, mix: 0.5 },
        { fx: 'invert', params: {}, mix: 0.5 },
        { fx: 'lens-blur', params: { radius: 4 } },
      ],
      t: 0.5,
    }
    const out2 = await render(scratch)
    expect(out2.drops, `scratch chain dropped: ${JSON.stringify(out2.drops)}`).toEqual([])
    expect((await render(scratch)).hash).toBe(out2.hash)
  })

  it('a missing WebGL2 context reports every stack effect undrawn — the 2D scene still paints', async () => {
    const out = await render({ fx: 'vignette', t: 0.5, noGl: true })
    expect(out.drops).toEqual([{ fx: 'vignette', reason: 'no WebGL2 context' }])
    /* the frame the 2D pass drew is still there — nothing silently blank */
    const plain = await render({ t: 0.5, noGl: true })
    expect(out.hash).toBe(plain.hash)
  })

  it('an effect with no GLSL body is reported, not skipped', async () => {
    /* every registered effect ships a body — an unregistered id is what
       now exercises the unsupported path */
    const out = await render({ fx: 'not-an-effect', t: 0.5 })
    expect(out.drops).toEqual([{ fx: 'not-an-effect', reason: 'no shader in this build' }])
  })
})
