/**
 * shared/motionFx.ts — the effect registry (motion-pro P1). Every effect
 * id the timeline can name lives here once: its params, their ranges and
 * defaults, a GPU cost estimate, and which surfaces can draw it. The GLSL
 * ES 3.00 bodies that implement them sit in src/lib/motion/gl.ts;
 * EffectCraft's modules informed the family and parameter names
 * (MIT/Apache — see THIRD-PARTY-LICENSES) under Diazo ids.
 *
 * Seek-safety: every effect is a pure function of (pixels in, params, t).
 * Noise and grain are seeded from the instance — `seed ?? hash(id)` — and
 * the composition time, never from a wall clock or accumulated state.
 */

import type { EffectInstance, MotionTrack } from './motion.ts'

export type FxFamily = 'blur' | 'light' | 'lens' | 'texture' | 'distort' | 'color' | 'glitch' | 'generate' | 'matte'

export type FxParamKind = 'number' | 'color' | 'bool' | 'select' | 'point'

export interface FxParam {
  id: string
  kind: FxParamKind
  min?: number
  max?: number
  step?: number
  /** the resting value `EffectInstance.params` starts from */
  def: number | string | boolean
  /** selects' allowed values */
  options?: readonly string[]
  /** only number params take `fx:` keyframe lanes */
  note?: string
}

export interface FxSpec {
  id: string
  label: string
  family: FxFamily
  /** relative GPU cost: 1 = single cheap pass, 3 = multi-tap, 5 = pyramid */
  cost: number
  params: readonly FxParam[]
  /** generates pixels rather than filtering them (matte generators ignore
   *  the layer's own picture) */
  gen?: boolean
  /** needs a second input — an element/clip texture the instance binds */
  needsInput?: boolean
  /** resting values `EffectInstance.params` starts from */
  defaults(): Record<string, number | string | boolean>
  /** a params object's error, null when clean */
  validate(params: Record<string, unknown>): string | null
}

const n = (id: string, min: number, max: number, def: number, step?: number, note?: string): FxParam => ({
  id,
  kind: 'number',
  min,
  max,
  def,
  ...(step !== undefined ? { step } : {}),
  ...(note !== undefined ? { note } : {}),
})
const c = (id: string, def: string): FxParam => ({ id, kind: 'color', def })
const b = (id: string, def: boolean): FxParam => ({ id, kind: 'bool', def })
const sel = (id: string, options: readonly string[], def: string): FxParam => ({ id, kind: 'select', options, def })
const pt = (id: string): FxParam => ({ id, kind: 'point', def: '0.5,0.5', note: 'u,v in [0,1]' })

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

const F = (spec: Omit<FxSpec, 'defaults' | 'validate'>): FxSpec => ({
  ...spec,
  defaults() {
    const out: Record<string, number | string | boolean> = {}
    for (const p of this.params) out[p.id] = p.def
    return out
  },
  validate(params: Record<string, unknown>) {
    for (const [key, value] of Object.entries(params)) {
      const p = this.params.find((param) => param.id === key)
      if (!p) return `${this.id}: unknown param ${key}`
      switch (p.kind) {
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) return `${this.id}.${key} must be a number`
          if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max)) {
            return `${this.id}.${key} must be in [${p.min}, ${p.max}]`
          }
          break
        case 'color':
          if (typeof value !== 'string' || !COLOR_RE.test(value)) return `${this.id}.${key} must be a #rrggbb color`
          break
        case 'bool':
          if (typeof value !== 'boolean') return `${this.id}.${key} must be a boolean`
          break
        case 'select':
          if (typeof value !== 'string' || !(p.options ?? []).includes(value)) {
            return `${this.id}.${key} must be one of ${(p.options ?? []).join(', ')}`
          }
          break
        case 'point': {
          /* "u,v" in [0,1] or a two-number array */
          const pair =
            typeof value === 'string'
              ? value.split(',').map(Number)
              : Array.isArray(value) && value.every((v) => typeof v === 'number')
                ? (value as number[])
                : null
          if (!pair || pair.length !== 2 || pair.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
            return `${this.id}.${key} must be a "u,v" point in [0,1]`
          }
          break
        }
      }
    }
    return null
  },
})

/**
 * The registry. Order is the picker order: family by family, the way the
 * docs and list_motion_effects present them.
 */
export const MOTION_EFFECTS: readonly FxSpec[] = [
  /* blur */
  F({ id: 'gaussian-blur', label: 'Gaussian Blur', family: 'blur', cost: 4, params: [n('radius', 0, 200, 12)] }),
  F({
    id: 'directional-blur',
    label: 'Directional Blur',
    family: 'blur',
    cost: 3,
    params: [n('radius', 0, 200, 20), n('angle', -180, 180, 0)],
  }),
  F({
    id: 'radial-blur',
    label: 'Radial / Zoom Blur',
    family: 'blur',
    cost: 4,
    params: [pt('center'), n('amount', 0, 1, 0.25), sel('mode', ['zoom', 'spin'], 'zoom')],
  }),
  F({
    id: 'lens-blur',
    label: 'Lens Blur',
    family: 'blur',
    cost: 5,
    params: [n('radius', 0, 60, 10), n('bokeh', 0, 1, 0.6, undefined, 'highlight gain')],
  }),
  F({
    id: 'whip-blur',
    label: 'Whip Blur',
    family: 'blur',
    cost: 3,
    params: [n('amount', 0, 1, 0.5), n('angle', -180, 180, 0), n('curve', 0.2, 4, 1.6, undefined, 'speed curve')],
  }),
  /* light */
  F({
    id: 'glow',
    label: 'Glow',
    family: 'light',
    cost: 4,
    params: [n('radius', 0, 120, 18), n('intensity', 0, 4, 0.8), n('threshold', 0, 1, 0.6), c('tint', '#ffffff')],
  }),
  F({
    id: 'bloom',
    label: 'Bloom',
    family: 'light',
    cost: 5,
    params: [n('threshold', 0, 1, 0.75), n('intensity', 0, 3, 0.9), n('radius', 0, 80, 24)],
  }),
  F({
    id: 'light-leak',
    label: 'Light Leak',
    family: 'light',
    cost: 2,
    params: [
      c('color', '#ff9a3c'),
      n('opacity', 0, 1, 0.5),
      pt('position'),
      n('size', 0.1, 2, 0.8),
      n('drift', 0, 5, 0.4, undefined, 'seeded drift speed — deterministic per seed'),
    ],
  }),
  F({
    id: 'lens-flare',
    label: 'Lens Flare',
    family: 'light',
    cost: 3,
    params: [pt('position'), n('intensity', 0, 3, 1), n('ghosts', 0, 8, 4, 1), c('tint', '#cfe8ff')],
  }),
  F({
    id: 'vignette',
    label: 'Vignette',
    family: 'light',
    cost: 1,
    params: [n('amount', 0, 1, 0.4), n('radius', 0.2, 1.5, 0.75), n('feather', 0, 1, 0.6), c('color', '#000000')],
  }),
  F({
    id: 'god-rays',
    label: 'God Rays',
    family: 'light',
    cost: 4,
    params: [pt('source'), n('intensity', 0, 2, 0.7), n('density', 0.2, 2, 1), n('decay', 0, 1, 0.92)],
  }),
  /* lens */
  F({
    id: 'chromatic-aberration',
    label: 'Chromatic Aberration',
    family: 'lens',
    cost: 1,
    params: [n('amount', 0, 40, 4), pt('center'), sel('falloff', ['linear', 'edges'], 'edges')],
  }),
  F({
    id: 'barrel-distortion',
    label: 'Barrel / Fisheye',
    family: 'lens',
    cost: 1,
    params: [n('amount', -1, 1, 0.3), pt('center')],
  }),
  F({
    id: 'lens-distortion',
    label: 'Lens Distortion',
    family: 'lens',
    cost: 1,
    params: [n('k1', -1, 1, 0.15), n('k2', -1, 1, 0.05), pt('center')],
  }),
  F({
    id: 'rolling-shutter',
    label: 'Rolling Shutter',
    family: 'lens',
    cost: 2,
    params: [n('amount', -60, 60, 8, undefined, 'px of skew across the frame'), sel('axis', ['x', 'y'], 'x')],
  }),
  /* texture */
  F({
    id: 'film-grain',
    label: 'Film Grain',
    family: 'texture',
    cost: 1,
    params: [n('amount', 0, 1, 0.12), n('size', 0.5, 6, 1.4), b('mono', true)],
  }),
  F({
    id: 'noise',
    label: 'Noise',
    family: 'texture',
    cost: 1,
    params: [n('amount', 0, 1, 0.2), n('scale', 0.1, 10, 1), b('mono', false)],
  }),
  F({
    id: 'scanlines',
    label: 'Scanlines',
    family: 'texture',
    cost: 1,
    params: [
      n('count', 10, 2000, 480),
      n('opacity', 0, 1, 0.25),
      n('speed', -10, 10, 0, undefined, 'seeded scroll, lines/s'),
    ],
  }),
  F({
    id: 'halftone',
    label: 'Halftone',
    family: 'texture',
    cost: 2,
    params: [n('size', 2, 40, 6, undefined, 'dot pitch px'), n('angle', -180, 180, 15), n('softness', 0, 1, 0.3)],
  }),
  F({
    id: 'pixelate',
    label: 'Pixelate',
    family: 'texture',
    cost: 1,
    params: [n('size', 1, 200, 12, undefined, 'block px'), sel('mode', ['square', 'diamond', 'hex'], 'square')],
  }),
  /* distort */
  F({
    id: 'displacement-map',
    label: 'Displacement Map',
    family: 'distort',
    cost: 3,
    needsInput: true,
    params: [n('amount', 0, 200, 24), sel('channel', ['r', 'g', 'luma'], 'luma')],
  }),
  F({
    id: 'wave-warp',
    label: 'Wave Warp',
    family: 'distort',
    cost: 1,
    params: [
      n('amplitude', 0, 200, 12),
      n('wavelength', 1, 1000, 90),
      n('angle', -180, 180, 0),
      n('speed', -20, 20, 0, undefined, 'seeded phase rate — deterministic per seed'),
    ],
  }),
  F({
    id: 'turbulent-displace',
    label: 'Turbulent Displace',
    family: 'distort',
    cost: 3,
    params: [
      n('amount', 0, 200, 16),
      n('scale', 0.2, 20, 3),
      n('evolution', -10, 10, 0, undefined, 'seeded noise rate'),
    ],
  }),
  F({
    id: 'bulge-pinch',
    label: 'Bulge / Pinch',
    family: 'distort',
    cost: 1,
    params: [pt('center'), n('amount', -1, 1, 0.4), n('radius', 0.05, 2, 0.5)],
  }),
  F({
    id: 'mirror',
    label: 'Mirror',
    family: 'distort',
    cost: 1,
    params: [n('angle', -180, 180, 0), pt('center'), sel('reflect', ['left', 'right', 'top', 'bottom'], 'left')],
  }),
  F({
    id: 'slit-stretch',
    label: 'Slit Stretch',
    family: 'distort',
    cost: 2,
    params: [n('position', 0, 1, 0.5), n('stretch', -1, 1, 0.3), sel('axis', ['x', 'y'], 'y')],
  }),
  /* color */
  F({
    id: 'color-grade',
    label: 'Color Grade',
    family: 'color',
    cost: 1,
    params: [
      n('exposure', -3, 3, 0),
      n('contrast', -1, 1, 0),
      n('saturation', -1, 1, 0),
      n('temperature', -1, 1, 0),
      c('shadows', '#000000'),
      c('highlights', '#ffffff'),
      n('split', 0, 1, 0, undefined, 'shadow/highlight tint strength'),
    ],
  }),
  F({
    id: 'curves',
    label: 'Curves',
    family: 'color',
    cost: 1,
    params: [n('black', 0, 1, 0), n('white', 0, 1, 1), n('gamma', 0.1, 5, 1), n('lift', -1, 1, 0)],
  }),
  F({ id: 'tint', label: 'Tint', family: 'color', cost: 1, params: [c('color', '#ff7a00'), n('amount', 0, 1, 0.5)] }),
  F({
    id: 'duotone',
    label: 'Duotone',
    family: 'color',
    cost: 1,
    params: [c('shadow', '#0b1e3b'), c('highlight', '#f4d35e'), n('amount', 0, 1, 1)],
  }),
  F({ id: 'invert', label: 'Invert', family: 'color', cost: 1, params: [n('amount', 0, 1, 1), b('alpha', false)] }),
  F({ id: 'posterize', label: 'Posterize', family: 'color', cost: 1, params: [n('levels', 2, 32, 5, 1)] }),
  F({ id: 'hue-shift', label: 'Hue Shift', family: 'color', cost: 1, params: [n('degrees', -180, 180, 0)] }),
  /* glitch */
  F({
    id: 'rgb-split',
    label: 'RGB Split',
    family: 'glitch',
    cost: 1,
    params: [n('amount', 0, 60, 6), n('angle', -180, 180, 0), n('jitter', 0, 1, 0, undefined, 'seeded wobble')],
  }),
  F({
    id: 'block-shift',
    label: 'Block Shift',
    family: 'glitch',
    cost: 2,
    params: [n('amount', 0, 200, 24), n('rows', 2, 60, 12, 1), n('rate', 0, 20, 4, undefined, 'seeded re-roll rate')],
  }),
  F({
    id: 'scan-jitter',
    label: 'Scan Jitter',
    family: 'glitch',
    cost: 1,
    params: [n('amount', 0, 60, 6), n('frequency', 1, 200, 60), n('rate', 0, 20, 6)],
  }),
  /* generators */
  F({
    id: 'gradient-ramp',
    label: 'Gradient Ramp',
    family: 'generate',
    cost: 1,
    gen: true,
    params: [
      c('from', '#000000'),
      c('to', '#ffffff'),
      n('angle', -180, 180, 90),
      sel('shape', ['linear', 'radial'], 'linear'),
    ],
  }),
  F({
    id: 'fractal-noise',
    label: 'Fractal Noise',
    family: 'generate',
    cost: 3,
    gen: true,
    params: [n('scale', 0.2, 20, 3), n('octaves', 1, 8, 4, 1), n('contrast', 0.2, 4, 1), n('evolution', -10, 10, 0)],
  }),
  F({ id: 'solid-fill', label: 'Solid', family: 'generate', cost: 1, gen: true, params: [c('color', '#000000')] }),
  F({
    id: 'grid',
    label: 'Grid',
    family: 'generate',
    cost: 1,
    gen: true,
    params: [n('size', 2, 400, 40), n('line', 0.5, 40, 1), c('color', '#ffffff'), c('background', '#00000000')],
  }),
  /* matte */
  F({
    id: 'luma-matte',
    label: 'Luma Matte',
    family: 'matte',
    cost: 2,
    needsInput: true,
    params: [sel('channel', ['luma', 'alpha', 'r', 'g', 'b'], 'luma'), b('invert', false), n('softness', 0, 1, 0)],
  }),
  F({
    id: 'feather',
    label: 'Feather',
    family: 'matte',
    cost: 2,
    params: [n('amount', 0, 200, 12, undefined, 'edge softness px')],
  }),
  F({
    id: 'choke',
    label: 'Choke / Spread',
    family: 'matte',
    cost: 2,
    params: [n('amount', -100, 100, 8, undefined, 'px — negative chokes the matte')],
  }),
]

const BY_ID = new Map(MOTION_EFFECTS.map((fx) => [fx.id, fx]))

export function effectSpec(id: string): FxSpec | undefined {
  return BY_ID.get(id)
}

/** the registry ids src/lib/motion/gl.ts ships a WebGL2 body for — the lint's
 *  MO-14 and the compositor's supportedStack read this, so a stack the
 *  renderer cannot draw is reported, never silently skipped */
export const GL_EFFECT_IDS: ReadonlySet<string> = new Set([
  'gaussian-blur',
  'directional-blur',
  'radial-blur',
  'glow',
  'vignette',
  'chromatic-aberration',
  'barrel-distortion',
  'film-grain',
  'noise',
  'scanlines',
  'halftone',
  'pixelate',
  'wave-warp',
  'bulge-pinch',
  'mirror',
  'color-grade',
  'tint',
  'duotone',
  'invert',
  'posterize',
  'hue-shift',
  'rgb-split',
  'block-shift',
  'scan-jitter',
  'light-leak',
  'lens-blur',
  'bloom',
  'curves',
  'luma-matte',
  'feather',
  'choke',
  'lens-flare',
  'god-rays',
  'lens-distortion',
  'rolling-shutter',
  'whip-blur',
  'displacement-map',
  'turbulent-displace',
  'slit-stretch',
  'gradient-ramp',
  'fractal-noise',
  'grid',
  'solid-fill',
])

/** tool callers may send points as [u, v] arrays — the contract stores the
 *  "u,v" string form; every other value passes through unchanged */
export function normalizeParams(
  spec: FxSpec,
  params: Record<string, unknown>,
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    const p = spec.params.find((param) => param.id === key)
    if (p?.kind === 'point' && Array.isArray(value)) out[key] = value.join(',')
    else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') out[key] = value
  }
  return out
}

/** deterministic seed for an instance: its own `seed`, else a hash of its
 *  id — same instance, same noise at every seek */
export function effectSeed(effect: EffectInstance): number {
  if (effect.seed !== undefined) return effect.seed
  let h = 2166136261
  for (const ch of effect.id) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** the effect instances live on a track's stack: enabled ones, in order */
export function enabledEffects(track: MotionTrack): EffectInstance[] {
  return (track.effects ?? []).filter((e) => e.enabled !== false)
}

/** the whole-film effect budget — the preview's rule of thumb (six layers
 *  × three mid-cost passes ≈ 36) and the cap a server render refuses to
 *  exceed; check_scene reports it as `cost_cap` */
export const EFFECT_COST_CAP = 36

/** the cost estimate of a stack — the check's per-layer GPU budget */
export function effectCost(track: MotionTrack): number {
  let total = 0
  for (const e of enabledEffects(track)) total += BY_ID.get(e.fx)?.cost ?? 2
  return total
}

/** params resolved at t: `fx:<instanceId>.<param>` keyframe lanes override
 *  the resting values (the runtime feeds resolved values in; this helper
 *  merges for callers that already resolved a lane) */
export function effectParamsAt(
  effect: EffectInstance,
  resolved: Record<string, number | string> = {},
): Record<string, number | string | boolean> {
  const prefix = `${effect.id}.`
  const out: Record<string, number | string | boolean> = { ...effect.params }
  for (const [key, value] of Object.entries(resolved)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value
  }
  return out
}
