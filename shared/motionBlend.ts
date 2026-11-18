/**
 * shared/motionBlend.ts — the blend-mode maths the compositor and the CPU
 * reference share (motion-elements P0).
 *
 * The 26 colour modes split in two: 20 separable modes blend per channel
 * (B(Cb, Cs)), the 6 non-separable ones work on the whole colour through
 * luminosity/saturation helpers. `blendPixel` evaluates B in sRGB-encoded
 * space (the working space); `compositePixel` does the blended source-over
 * in premultiplied space — every buffer the compositor touches is
 * premultiplied RGBA8.
 *
 * Formulas are the W3C Compositing and Blending Level 1 equations plus the
 * common published Photoshop-era definitions for the extended separable
 * modes — mathematics, clean-room written, no code copied.
 */

import { BLEND_MODES, type BlendMode } from './motion.ts'

/** straight (non-premultiplied) RGB, channels 0..1 */
export type Rgb = readonly [number, number, number]
/** premultiplied RGBA, channels 0..1 — the compositor's pixel */
export type Rgba = readonly [number, number, number, number]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** mode → index into BLEND_MODES (the same int BLEND_GLSL takes) */
export const blendModeIndex = (mode: BlendMode): number => BLEND_MODES.indexOf(mode)
export const blendModeAt = (index: number): BlendMode => BLEND_MODES[index] ?? 'normal'

/* ---- separable per-channel kernels ---- */

const colorDodge = (cb: number, cs: number): number => (cs >= 1 ? (cb > 0 ? 1 : 0) : Math.min(1, cb / (1 - cs)))
/* the white-backdrop endpoint precedes the black-source one: burn of white
   over anything is white, even with a zero source */
const colorBurn = (cb: number, cs: number): number => (cb >= 1 ? 1 : cs <= 0 ? 0 : Math.max(0, 1 - (1 - cb) / cs))
const vividLight = (cb: number, cs: number): number => (cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * cs - 1))

/** soft-light's rational correction curve on the backdrop */
const softD = (x: number): number => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x))

/** B(Cb, Cs) for the 20 separable modes, one channel */
function separable(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs
    case 'multiply':
      return cb * cs
    case 'screen':
      return cb + cs - cb * cs
    case 'overlay':
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)
    case 'darken':
      return Math.min(cb, cs)
    case 'lighten':
      return Math.max(cb, cs)
    case 'color-dodge':
      return colorDodge(cb, cs)
    case 'color-burn':
      return colorBurn(cb, cs)
    case 'hard-light':
      return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)
    case 'soft-light':
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softD(cb) - cb)
    case 'difference':
      return Math.abs(cb - cs)
    case 'exclusion':
      return cb + cs - 2 * cb * cs
    case 'add':
      return Math.min(1, cb + cs)
    case 'subtract':
      return Math.max(0, cb - cs)
    case 'divide':
      return cs <= 0 ? 1 : Math.min(1, cb / cs)
    case 'linear-burn':
      return Math.max(0, cb + cs - 1)
    case 'vivid-light':
      return vividLight(cb, cs)
    case 'linear-light':
      return clamp01(cb + 2 * cs - 1)
    case 'pin-light':
      return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)
    case 'hard-mix':
      /* the specified threshold is inclusive: Cb + Cs ≥ 1, not the
         vivid-light half */
      return cb + cs >= 1 ? 1 : 0
    default:
      return cs
  }
}

/* ---- non-separable helpers (luminosity/saturation space) ---- */

const lum = (c: Rgb): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
const sat = (c: Rgb): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

function clipColor(c: Rgb): Rgb {
  const l = lum(c)
  const n = Math.min(c[0], c[1], c[2])
  const x = Math.max(c[0], c[1], c[2])
  let out: Rgb = c
  if (n < 0) {
    const f = l / (l - n)
    out = [l + (out[0] - l) * f, l + (out[1] - l) * f, l + (out[2] - l) * f] as Rgb
  }
  if (x > 1) {
    const f = (1 - l) / (x - l)
    out = [l + (out[0] - l) * f, l + (out[1] - l) * f, l + (out[2] - l) * f] as Rgb
  }
  return out
}

const setLum = (c: Rgb, l: number): Rgb => clipColor([c[0] + (l - lum(c)), c[1] + (l - lum(c)), c[2] + (l - lum(c))])

function setSat(c: Rgb, s: number): Rgb {
  const mn = Math.min(c[0], c[1], c[2])
  const mx = Math.max(c[0], c[1], c[2])
  if (mx <= mn) return [0, 0, 0]
  const f = s / (mx - mn)
  return [(c[0] - mn) * f, (c[1] - mn) * f, (c[2] - mn) * f]
}

/* ---- the public API ---- */

/* darker/lighter-color pick a whole colour by luma — the one branch whose
   verdict can flip on float noise. The comparison runs at the precision
   the RGBA8 buffers actually carry: byte channels weighted 30/59/11 into
   integer ticks that float64 (here) and float32 (BLEND_GLSL) evaluate
   identically, so an equal-luma tie keeps the backdrop on both sides.
   blendPixel compares straight-colour ticks; compositePixel compares the
   premultiplied bytes cross-multiplied by the other side's alpha — the
   same verdict on opaque input, and no float-division edge at partial
   coverage. */
const lumaTicks = (r: number, g: number, b: number): number =>
  Math.round(r * 255) * 30 + Math.round(g * 255) * 59 + Math.round(b * 255) * 11

const colorPick = (mode: BlendMode, cb: Rgb, cs: Rgb): Rgb => {
  const tb = lumaTicks(cb[0], cb[1], cb[2])
  const ts = lumaTicks(cs[0], cs[1], cs[2])
  const source = mode === 'darker-color' ? ts < tb : ts > tb
  return source ? [cs[0], cs[1], cs[2]] : [cb[0], cb[1], cb[2]]
}

/* the pick on premultiplied bytes: ticks(b)·α(s) vs ticks(s)·α(b) —
   integer products, so the tie line is exact at every alpha */
const premultPick = (mode: BlendMode, b: Rgba, s: Rgba, cb: Rgb, cs: Rgb): Rgb => {
  const tb = lumaTicks(b[0], b[1], b[2]) * Math.round(s[3] * 255)
  const ts = lumaTicks(s[0], s[1], s[2]) * Math.round(b[3] * 255)
  const source = mode === 'darker-color' ? ts < tb : ts > tb
  return source ? cs : cb
}

/**
 * The blend function B(Cb, Cs): two straight colours in, one out. The
 * separable modes run per channel; the non-separable ones are whole-colour.
 */
export function blendPixel(mode: BlendMode, cb: Rgb, cs: Rgb): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb))
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb))
    case 'color':
      return setLum(cs, lum(cb))
    case 'luminosity':
      return setLum(cb, lum(cs))
    case 'darker-color':
    case 'lighter-color':
      return colorPick(mode, cb, cs)
    default:
      return [separable(mode, cb[0], cs[0]), separable(mode, cb[1], cs[1]), separable(mode, cb[2], cs[2])]
  }
}

/**
 * Blended source-over on premultiplied pixels: `s` over `b`, output
 * premultiplied. With `normal` this is ordinary source-over.
 *
 *   Cs = s.a > 0 ? s.rgb / s.a : 0        Cb = b.a > 0 ? b.rgb / b.a : 0
 *   co = s.a * ((1 - b.a) * Cs + b.a * B(Cb, Cs)) + (1 - s.a) * b.rgb
 *   ao = s.a + b.a * (1 - s.a)
 */
export function compositePixel(mode: BlendMode, s: Rgba, b: Rgba): Rgba {
  const sa = s[3]
  const ba = b[3]
  if (sa <= 0) return [b[0], b[1], b[2], ba]
  if (ba <= 0) return [s[0], s[1], s[2], sa]
  const cs: Rgb = [s[0] / sa, s[1] / sa, s[2] / sa]
  const cb: Rgb = [b[0] / ba, b[1] / ba, b[2] / ba]
  const mixed =
    mode === 'darker-color' || mode === 'lighter-color' ? premultPick(mode, b, s, cb, cs) : blendPixel(mode, cb, cs)
  const ao = sa + ba * (1 - sa)
  const rgb: number[] = []
  for (let i = 0; i < 3; i++) {
    rgb.push(sa * ((1 - ba) * cs[i]! + ba * mixed[i]!) + (1 - sa) * b[i]!)
  }
  return [rgb[0]!, rgb[1]!, rgb[2]!, ao]
}

/* ---- the GL side ----
 * One function the compositor calls per pixel per layer: `doopBlend` takes
 * the BLEND_MODES index and two straight colours; `doopComposite` does the
 * same math as compositePixel on premultiplied inputs. Kept as one literal
 * so the renderer can paste it into any effect chain — GLSL ES 3.00. */
export const BLEND_GLSL = /* glsl */ `
vec3 doopSetSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.);
}
float doopLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
float doopSat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 doopClip(vec3 c) {
  float l = doopLum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.) c = l + (c - l) * l / (l - n);
  if (x > 1.) c = l + (c - l) * (1. - l) / (x - l);
  return c;
}
vec3 doopSetLum(vec3 c, float l) { return doopClip(c + (l - doopLum(c))); }
float doopLumaTicks(vec3 c) { return dot(floor(c * 255. + .5), vec3(30., 59., 11.)); }
float doopDodge(float cb, float cs) { return cs >= 1. ? (cb > 0. ? 1. : 0.) : min(1., cb / (1. - cs)); }
float doopBurn(float cb, float cs) { return cb >= 1. ? 1. : cs <= 0. ? 0. : max(0., 1. - (1. - cb) / cs); }
float doopVivid(float cb, float cs) { return cs <= .5 ? doopBurn(cb, 2. * cs) : doopDodge(cb, 2. * cs - 1.); }
float doopSoftD(float x) { return x <= .25 ? ((16. * x - 12.) * x + 4.) * x : sqrt(x); }
float doopSep(int m, float cb, float cs) {
  if (m == 0) return cs;                                    // normal
  if (m == 1) return cb * cs;                               // multiply
  if (m == 2) return cb + cs - cb * cs;                     // screen
  if (m == 3) return cb <= .5 ? 2. * cb * cs : 1. - 2. * (1. - cb) * (1. - cs);   // overlay
  if (m == 4) return min(cb, cs);                           // darken
  if (m == 5) return max(cb, cs);                           // lighten
  if (m == 6) return doopDodge(cb, cs);                     // color-dodge
  if (m == 7) return doopBurn(cb, cs);                      // color-burn
  if (m == 8) return cs <= .5 ? 2. * cb * cs : 1. - 2. * (1. - cb) * (1. - cs);   // hard-light
  if (m == 9) return cs <= .5 ? cb - (1. - 2. * cs) * cb * (1. - cb)
                    : cb + (2. * cs - 1.) * (doopSoftD(cb) - cb);                // soft-light
  if (m == 10) return abs(cb - cs);                         // difference
  if (m == 11) return cb + cs - 2. * cb * cs;               // exclusion
  if (m == 12) return min(1., cb + cs);                     // add
  if (m == 13) return max(0., cb - cs);                     // subtract
  if (m == 14) return cs <= 0. ? 1. : min(1., cb / cs);     // divide
  if (m == 15) return max(0., cb + cs - 1.);                // linear-burn
  if (m == 16) return doopVivid(cb, cs);                    // vivid-light
  if (m == 17) return clamp(cb + 2. * cs - 1., 0., 1.);     // linear-light
  if (m == 18) return cs <= .5 ? min(cb, 2. * cs) : max(cb, 2. * cs - 1.);        // pin-light
  if (m == 19) return cb + cs >= 1. ? 1. : 0.;              // hard-mix
  return cs;
}
vec3 doopBlend(int m, vec3 cb, vec3 cs) {
  if (m == 20) return doopSetLum(doopSetSat(cs, doopSat(cb)), doopLum(cb));       // hue
  if (m == 21) return doopSetLum(doopSetSat(cb, doopSat(cs)), doopLum(cb));       // saturation
  if (m == 22) return doopSetLum(cs, doopLum(cb));                               // color
  if (m == 23) return doopSetLum(cb, doopLum(cs));                               // luminosity
  if (m == 24) return doopLumaTicks(cs) < doopLumaTicks(cb) ? cs : cb;           // darker-color
  if (m == 25) return doopLumaTicks(cs) > doopLumaTicks(cb) ? cs : cb;           // lighter-color
  return vec3(doopSep(m, cb.r, cs.r), doopSep(m, cb.g, cs.g), doopSep(m, cb.b, cs.b));
}
vec4 doopComposite(int m, vec4 s, vec4 b) {
  if (s.a <= 0.) return b;
  if (b.a <= 0.) return s;
  vec3 cs = s.rgb / s.a;
  vec3 cb = b.rgb / b.a;
  /* the colour-pick modes compare premult bytes cross-multiplied by the
     other side's alpha — integer products, so the tie line is exact */
  vec3 bm;
  if (m == 24 || m == 25) {
    float tb = doopLumaTicks(b.rgb) * floor(s.a * 255. + .5);
    float ts = doopLumaTicks(s.rgb) * floor(b.a * 255. + .5);
    bm = m == 24 ? (ts < tb ? cs : cb) : (ts > tb ? cs : cb);
  } else {
    bm = doopBlend(m, cb, cs);
  }
  float ao = s.a + b.a * (1. - s.a);
  vec3 co = s.a * ((1. - b.a) * cs + b.a * bm) + (1. - s.a) * b.rgb;
  return vec4(co, ao);
}
`
