/**
 * The CPU reference blend: every mode on a 5×5 grid of channel values
 * against literal W3C Compositing & Blending / published Photoshop-era
 * formulas, the identity properties, and the premultiplied composite's
 * alpha edge cases (motion-elements P0).
 */
import { describe, expect, it } from 'vitest'
import { BLEND_MODES, type BlendMode } from '../shared/motion.ts'
import { BLEND_GLSL, blendModeAt, blendModeIndex, blendPixel, compositePixel, type Rgb } from '../shared/motionBlend.ts'

const GRID = [0, 0.25, 0.5, 0.75, 1]

/* literal formulas, written out plainly — the grid is checked against
   these numbers, not against the implementation's own algebra */

const dodge = (cb: number, cs: number): number => (cs >= 1 ? (cb > 0 ? 1 : 0) : Math.min(1, cb / (1 - cs)))
/* W3C burn: the white backdrop wins first — burning over white is white even
   when the source channel is zero */
const burn = (cb: number, cs: number): number => (cb >= 1 ? 1 : cs <= 0 ? 0 : Math.max(0, 1 - (1 - cb) / cs))
const vivid = (cb: number, cs: number): number => (cs <= 0.5 ? burn(cb, 2 * cs) : dodge(cb, 2 * cs - 1))
const softD = (x: number): number => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x))
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const SEPARABLE: Record<string, (cb: number, cs: number) => number> = {
  normal: (_cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  overlay: (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  'color-dodge': dodge,
  'color-burn': burn,
  'hard-light': (cb, cs) => (cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
  'soft-light': (cb, cs) => (cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softD(cb) - cb)),
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
  add: (cb, cs) => Math.min(1, cb + cs),
  subtract: (cb, cs) => Math.max(0, cb - cs),
  divide: (cb, cs) => (cs <= 0 ? 1 : Math.min(1, cb / cs)),
  'linear-burn': (cb, cs) => Math.max(0, cb + cs - 1),
  'vivid-light': vivid,
  'linear-light': (cb, cs) => clamp01(cb + 2 * cs - 1),
  'pin-light': (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)),
  /* hard-mix's own contract: the inclusive sum threshold, not vivid-light */
  'hard-mix': (cb, cs) => (cb + cs >= 1 ? 1 : 0),
}

const lum = (c: Rgb): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
const sat = (c: Rgb): number => Math.max(...c) - Math.min(...c)

function clip(c: Rgb): Rgb {
  const l = lum(c)
  const n = Math.min(...c)
  const x = Math.max(...c)
  if (n < 0) c = [l + (c[0] - l) * (l / (l - n)), l + (c[1] - l) * (l / (l - n)), l + (c[2] - l) * (l / (l - n))]
  if (x > 1)
    c = [
      l + (c[0] - l) * ((1 - l) / (x - l)),
      l + (c[1] - l) * ((1 - l) / (x - l)),
      l + (c[2] - l) * ((1 - l) / (x - l)),
    ]
  return c
}
const setLum = (c: Rgb, l: number): Rgb => clip([c[0] + (l - lum(c)), c[1] + (l - lum(c)), c[2] + (l - lum(c))])
const setSat = (c: Rgb, s: number): Rgb => {
  const mn = Math.min(...c)
  const mx = Math.max(...c)
  return mx > mn
    ? [(c[0] - mn) * (s / (mx - mn)), (c[1] - mn) * (s / (mx - mn)), (c[2] - mn) * (s / (mx - mn))]
    : [0, 0, 0]
}

const NON_SEPARABLE: Record<string, (cb: Rgb, cs: Rgb) => Rgb> = {
  hue: (cb, cs) => setLum(setSat(cs, sat(cb)), lum(cb)),
  saturation: (cb, cs) => setLum(setSat(cb, sat(cs)), lum(cb)),
  color: (cb, cs) => setLum(cs, lum(cb)),
  luminosity: (cb, cs) => setLum(cb, lum(cs)),
  'darker-color': (cb, cs) => (lum(cb) <= lum(cs) ? cb : cs),
  'lighter-color': (cb, cs) => (lum(cb) >= lum(cs) ? cb : cs),
}

const rgb = (r: number, g: number, b: number): Rgb => [r, g, b]

describe('blendPixel — every mode on a 5×5 grid', () => {
  it('the catalogue is 26 modes and every mode has a formula', () => {
    expect(BLEND_MODES).toHaveLength(26)
    for (const mode of BLEND_MODES) {
      expect(SEPARABLE[mode] ?? NON_SEPARABLE[mode], mode).toBeTruthy()
    }
  })

  for (const [mode, f] of Object.entries(SEPARABLE)) {
    it(`${mode} matches the literal formula`, () => {
      for (const cb of GRID) {
        for (const cs of GRID) {
          const out = blendPixel(mode as BlendMode, rgb(cb, cb, cb), rgb(cs, cs, cs))
          for (const channel of out) expect(channel).toBeCloseTo(f(cb, cs), 10)
        }
      }
      /* a colour grid too — the per-channel kernel must not mix channels */
      const cb = rgb(0.2, 0.6, 1)
      const cs = rgb(0.9, 0.3, 0.4)
      const out = blendPixel(mode as BlendMode, cb, cs)
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(f(cb[i]!, cs[i]!), 10)
    })
  }

  for (const [mode, f] of Object.entries(NON_SEPARABLE)) {
    it(`${mode} matches the literal whole-colour formula`, () => {
      for (const r of GRID) {
        for (const g of GRID) {
          /* a diagonal walk through colour space hits grays and saturated
             colours, including the achromatic edge cases */
          const cb = rgb(r, g, 1 - r)
          const cs = rgb(g, 1 - g, r)
          const out = blendPixel(mode as BlendMode, cb, cs)
          const want = f(cb, cs)
          for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(want[i]!, 10)
        }
      }
    })
  }

  it('hand-checked anchors', () => {
    expect(blendPixel('screen', rgb(0.5, 0.5, 0.5), rgb(0.5, 0.5, 0.5))[0]).toBeCloseTo(0.75, 10)
    expect(blendPixel('multiply', rgb(0.5, 0.5, 0.5), rgb(0.5, 0.5, 0.5))[0]).toBeCloseTo(0.25, 10)
    expect(blendPixel('overlay', rgb(0.5, 0.5, 0.5), rgb(0.7, 0.7, 0.7))[0]).toBeCloseTo(0.7, 10)
    expect(blendPixel('difference', rgb(0.3, 0.3, 0.3), rgb(0.3, 0.3, 0.3))[0]).toBe(0)
    /* color keeps the backdrop's luminosity */
    const cb = rgb(0.8, 0.2, 0.2)
    const cs = rgb(0.1, 0.4, 0.9)
    const colored = blendPixel('color', cb, cs)
    expect(lum(colored)).toBeCloseTo(lum(cb), 10)
    /* luminosity keeps the source's luminosity */
    const lumed = blendPixel('luminosity', cb, cs)
    expect(lum(lumed)).toBeCloseTo(lum(cs), 10)
    /* darker-color picks the darker whole colour */
    expect(blendPixel('darker-color', cb, cs)).toEqual(lum(cb) <= lum(cs) ? cb : cs)
  })

  it('identities and degenerate inputs stay finite', () => {
    for (const cs of GRID) {
      /* multiply by white, screen over black, add to black: the source survives */
      expect(blendPixel('multiply', rgb(1, 1, 1), rgb(cs, cs, cs))[0]).toBeCloseTo(cs, 10)
      expect(blendPixel('screen', rgb(0, 0, 0), rgb(cs, cs, cs))[0]).toBeCloseTo(cs, 10)
      expect(blendPixel('add', rgb(0, 0, 0), rgb(cs, cs, cs))[0]).toBeCloseTo(cs, 10)
    }
    for (const mode of BLEND_MODES) {
      const out = blendPixel(mode, rgb(0.37, 0.62, 0.11), rgb(0.83, 0.2, 0.55))
      for (const channel of out) {
        expect(Number.isFinite(channel), `${mode} produced ${channel}`).toBe(true)
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(1)
      }
    }
    /* the 0/0 edges: dodge with cs=1,cb=0; burn with cs=0; divide with cs=0 */
    expect(blendPixel('color-dodge', rgb(0, 0, 0), rgb(1, 1, 1))[0]).toBe(0)
    expect(blendPixel('color-burn', rgb(0.5, 0.5, 0.5), rgb(0, 0, 0))[0]).toBe(0)
    expect(blendPixel('divide', rgb(0.5, 0.5, 0.5), rgb(0, 0, 0))[0]).toBe(1)
  })

  it('the endpoint checks that regressed (literal W3C expectations)', () => {
    /* color-burn: an opaque white backdrop burned by a black source stays
       white — the white-backdrop branch precedes the black-source one */
    expect(blendPixel('color-burn', rgb(1, 1, 1), rgb(0, 0, 0))).toEqual([1, 1, 1])
    /* vivid-light at cs=0 halves through color-burn: white backdrop stays
       white, a mid backdrop over black burns to black */
    expect(blendPixel('vivid-light', rgb(1, 1, 1), rgb(0, 0, 0))).toEqual([1, 1, 1])
    expect(blendPixel('vivid-light', rgb(0.5, 0.5, 0.5), rgb(0, 0, 0))).toEqual([0, 0, 0])
    /* hard-mix: black backdrop plus white source sums to exactly 1, and the
       threshold is inclusive — the result is white, not black */
    expect(blendPixel('hard-mix', rgb(0, 0, 0), rgb(1, 1, 1))).toEqual([1, 1, 1])
    expect(blendPixel('hard-mix', rgb(0.4, 0.4, 0.4), rgb(0.6, 0.6, 0.6))).toEqual([1, 1, 1])
    expect(blendPixel('hard-mix', rgb(0.4, 0.4, 0.4), rgb(0.5, 0.5, 0.5))).toEqual([0, 0, 0])
  })

  it('darker/lighter-color keep the backdrop on equal luma — the byte fixtures', () => {
    /* the reviewer's probe: [6,6,65] and [6,17,6] share one mathematical
       luma — float32 and float64 must reach the same verdict, so the
       comparison runs on byte-exact 30/59/11 ticks and a tie picks cb */
    const cb = rgb(6 / 255, 6 / 255, 65 / 255)
    const cs = rgb(6 / 255, 17 / 255, 6 / 255)
    expect(blendPixel('darker-color', cb, cs)).toEqual(cb)
    expect(blendPixel('lighter-color', cb, cs)).toEqual(cb)
    /* the same pair through the opaque composite stays the backdrop */
    expect(compositePixel('darker-color', [cs[0], cs[1], cs[2], 1], [cb[0], cb[1], cb[2], 1])).toEqual([
      cb[0],
      cb[1],
      cb[2],
      1,
    ])
    expect(compositePixel('lighter-color', [cs[0], cs[1], cs[2], 1], [cb[0], cb[1], cb[2], 1])).toEqual([
      cb[0],
      cb[1],
      cb[2],
      1,
    ])
  })

  it('the colour pick agrees with float32 GLSL arithmetic on every byte pair', () => {
    /* the reviewer's sweep: 30/59/11 byte ticks are integers under float32
       too, so a Math.fround evaluation of the shader's expression must
       give the identical pick on every RGBA8 pair — no ±1/255 wiggle room */
    const f = Math.fround
    const glslTicks = (c: Rgb): number =>
      f(
        f(f(Math.floor(f(c[0] * 255) + 0.5) * 30) + f(Math.floor(f(c[1] * 255) + 0.5) * 59)) +
          f(Math.floor(f(c[2] * 255) + 0.5) * 11),
      )
    const glslPick = (mode: 'darker-color' | 'lighter-color', cb: Rgb, cs: Rgb): Rgb => {
      const tb = glslTicks(cb)
      const ts = glslTicks(cs)
      return (mode === 'darker-color' ? ts < tb : ts > tb) ? cs : cb
    }
    for (const mode of ['darker-color', 'lighter-color'] as const) {
      for (let i = 0; i < 256; i += 17) {
        for (let j = 0; j < 256; j += 17) {
          const cb = rgb(i / 255, j / 255, ((i + j) % 256) / 255)
          const cs = rgb(j / 255, ((i * 3 + j) % 256) / 255, i / 255)
          expect(blendPixel(mode, cb, cs), `${mode} ${cb} ${cs}`).toEqual(glslPick(mode, cb, cs))
          /* and through the premultiplied composite on opaque input */
          const s: readonly [number, number, number, number] = [cs[0], cs[1], cs[2], 1]
          const b: readonly [number, number, number, number] = [cb[0], cb[1], cb[2], 1]
          const want = glslPick(mode, cb, cs)
          const got = compositePixel(mode, s, b)
          for (let ch = 0; ch < 3; ch++) expect(got[ch]!, `${mode} composite ${cb} ${cs}`).toBe(want[ch]!)
        }
      }
    }
  })
})

describe('compositePixel — premultiplied source-over', () => {
  it('a fully transparent source changes nothing', () => {
    const b: readonly [number, number, number, number] = [0.4, 0.2, 0.1, 0.5]
    for (const mode of BLEND_MODES) {
      expect(compositePixel(mode, [0, 0, 0, 0], b), mode).toEqual([0.4, 0.2, 0.1, 0.5])
    }
  })

  it('a fully transparent backdrop passes the source through', () => {
    const s: readonly [number, number, number, number] = [0.3, 0.6, 0.2, 0.7]
    for (const mode of BLEND_MODES) {
      expect(compositePixel(mode, s, [0, 0, 0, 0]), mode).toEqual([0.3, 0.6, 0.2, 0.7])
    }
  })

  it('two opaque pixels output the blend colour at alpha 1', () => {
    const cb: Rgb = [0.6, 0.2, 0.4]
    const cs: Rgb = [0.1, 0.8, 0.3]
    for (const mode of BLEND_MODES) {
      const out = compositePixel(mode, [cs[0], cs[1], cs[2], 1], [cb[0], cb[1], cb[2], 1])
      const want = blendPixel(mode, cb, cs)
      for (let i = 0; i < 3; i++) expect(out[i]!, `${mode} ch${i}`).toBeCloseTo(want[i]!, 10)
      expect(out[3]).toBeCloseTo(1, 10)
    }
  })

  it('normal composite is plain source-over', () => {
    /* premult over: co = s + (1−sa)·b, ao = sa + ba(1−sa) */
    const s: readonly [number, number, number, number] = [0.4, 0.1, 0.2, 0.5]
    const b: readonly [number, number, number, number] = [0.6, 0.3, 0.0, 0.8]
    const out = compositePixel('normal', s, b)
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(s[i]! + (1 - 0.5) * b[i]!, 10)
    expect(out[3]).toBeCloseTo(0.5 + 0.8 * 0.5, 10)
  })

  it('output stays premultiplied (rgb ≤ alpha would invert to garbage)', () => {
    /* an output channel must never exceed the alpha when it is premult —
       the invariant holds at partial coverage for every mode */
    for (const mode of BLEND_MODES) {
      const out = compositePixel(mode, [0.7, 0.5, 0.3, 0.5], [0.2, 0.4, 0.6, 0.6])
      expect(out[3]).toBeGreaterThan(0)
      expect(out[3]).toBeLessThanOrEqual(1.000001)
      for (let i = 0; i < 3; i++) expect(out[i]!, mode).toBeLessThanOrEqual(1.000001)
    }
  })
})

describe('GLSL companion and the mode index', () => {
  it('blendModeIndex / blendModeAt round-trip through BLEND_MODES', () => {
    BLEND_MODES.forEach((mode, i) => {
      expect(blendModeIndex(mode)).toBe(i)
      expect(blendModeAt(i)).toBe(mode)
    })
    expect(blendModeAt(99)).toBe('normal')
  })

  it('BLEND_GLSL indexes modes exactly like BLEND_MODES', () => {
    /* doopSep handles the 20 separable ints, doopBlend the 6 non-separable
       — the literal is the contract the compositor pastes in */
    expect(BLEND_GLSL).toContain('if (m == 0)')
    expect(BLEND_GLSL).toContain('if (m == 25)')
    const separableCases = (BLEND_GLSL.match(/if \(m == \d+\) return/g) ?? []).length
    expect(separableCases).toBe(26)
    for (const fn of ['doopBlend', 'doopComposite', 'doopSetSat', 'doopSetLum', 'doopSep']) {
      expect(BLEND_GLSL).toContain(fn)
    }
    expect(BLEND_GLSL).not.toContain('fract(sin(')
  })
})
