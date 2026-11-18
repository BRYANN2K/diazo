/**
 * shared/motionElementPresets.ts — element motion presets (motion-elements
 * P0, plan d.1): 20 entrances, 20 exits and 16 emphasis moves for element
 * tracks, plus seeded `staggerOffsets`.
 *
 * A preset compiles to ordinary keyframes on element props (x, y, scale,
 * scaleX, scaleY, rotate, skewX, skewY, opacity, blur, clipPath) — nothing
 * the runtime cannot already interpolate, and everything editable after
 * the write. Every preset pins rest values at its boundary (entrances end
 * at rest, exits start at rest, emphasis starts and ends at rest) so a
 * preset never leaks a pose into the rest of the film. Seeded moves
 * (shake, wiggle, the glitches) are mulberry32 — same seed, same jitter.
 */

import { newMotionId, type MotionEasing, type MotionKeyframe } from './motion.ts'
import { seededRandom } from './motionPresets.ts'
import { easingProgress } from './motionRuntime.ts'

/* ---- the catalogue ---- */

export const ELEMENT_PRESET_IDS = [
  /* entrances */
  'fade-in',
  'rise',
  'drop',
  'slide-in',
  'pop',
  'scale-in',
  'zoom-in-blur',
  'blur-in',
  'spin-in',
  'swing-in',
  'flip-in',
  'wipe-in',
  'iris-in',
  'stretch-in',
  'bounce-in',
  'elastic-in',
  'skew-in',
  'unfold',
  'glitch-in',
  'draw-on',
  /* exits — the mirror of each entrance */
  'fade-out',
  'sink',
  'lift-out',
  'slide-out',
  'pop-out',
  'scale-out',
  'zoom-out-blur',
  'blur-out',
  'spin-out',
  'swing-out',
  'flip-out',
  'wipe-out',
  'iris-out',
  'stretch-out',
  'bounce-out',
  'elastic-out',
  'skew-out',
  'fold',
  'glitch-out',
  'erase',
  /* emphasis — start and end at rest */
  'pulse',
  'heartbeat',
  'shake',
  'wobble',
  'nod',
  'jello',
  'rubber-band',
  'tada',
  'float',
  'breathe',
  'sway',
  'wiggle',
  'flash',
  'punch',
  'squash-land',
  'orbit',
] as const

export type ElementPreset = (typeof ELEMENT_PRESET_IDS)[number]
export type ElementPresetFamily = 'entrance' | 'exit' | 'emphasis'

export function isElementPreset(v: unknown): v is ElementPreset {
  return typeof v === 'string' && (ELEMENT_PRESET_IDS as readonly string[]).includes(v)
}

/* ---- options ---- */

export interface ElementPresetOptions {
  /** seconds on the composition clock the preset starts at */
  t: number
  /** seconds the preset runs — exits default to 70% of the entrance's */
  duration?: number
  /** travel direction: a side name or degrees (0 = right, clockwise) */
  direction?: 'up' | 'down' | 'left' | 'right' | number
  /** px of travel; default 80 */
  distance?: number
  /** 0..1 magnitude for amplitude-style presets; default 0.5 */
  intensity?: number
  /** the easing between keyframes (per-preset default when unset) */
  easing?: MotionEasing
  /** seed for the seeded presets (shake, wiggle, glitch-*) — default 1 */
  seed?: number
  /** per-preset knobs (see the spec's `params`) */
  params?: Record<string, number>
}

interface Resolved {
  t: number
  d: number
  ease: MotionEasing
  /** the caller's direction option, resolved to a unit vector in `dir` */
  direction: ElementPresetOptions['direction']
  /** unit vector of the travel direction */
  dir: { x: number; y: number }
  dist: number
  int: number
  seed: number
  p: Record<string, number>
}

export interface ElementPresetSpec {
  id: ElementPreset
  family: ElementPresetFamily
  /** one line: when to reach for it */
  use: string
  /** preset knobs beyond the common options — {id, def, note} */
  params: readonly { id: string; def: number; note?: string }[]
  /** default duration (s) and easing when the caller supplies neither */
  duration: number
  easing: MotionEasing
  keyframes(o: Resolved): MotionKeyframe[]
}

/* ---- helpers ---- */

const EASE_OUT: MotionEasing = { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 }
const EASE_IN: MotionEasing = { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 }
const EASE_IN_OUT: MotionEasing = { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
const LINEAR: MotionEasing = { type: 'linear' }
const HOLD: MotionEasing = { type: 'hold' }
const SPRING: MotionEasing = { type: 'spring', stiffness: 170, damping: 12, mass: 1 }
const BACK_IN: MotionEasing = { type: 'cubic-bezier', x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 }
const BACK_OUT: MotionEasing = { type: 'cubic-bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }

const kf = (property: string, t: number, value: number | string, easing: MotionEasing): MotionKeyframe => ({
  id: newMotionId(),
  property,
  t,
  value,
  easing,
})

/** a two-keyframe lane */
const span = (property: string, t: number, d: number, from: number | string, to: number | string, e: MotionEasing) => [
  kf(property, t, from, e),
  kf(property, t + d, to, e),
]

/** direction → unit vector; sides name where the travel reads toward for
 *  exits and where it comes from for entrances (handled by the preset) */
function dirVector(direction: ElementPresetOptions['direction']): {
  x: number
  y: number
} {
  if (typeof direction === 'number') {
    const r = (direction * Math.PI) / 180
    return { x: Math.cos(r), y: Math.sin(r) }
  }
  switch (direction ?? 'left') {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'up':
      return { x: 0, y: -1 }
    case 'down':
      return { x: 0, y: 1 }
  }
}

const REST_CLIP = 'inset(0% 0% 0% 0%)'

/** wipe clip-path hiding the element to `side` (the side it reveals from) */
const clipHidden = (direction: ElementPresetOptions['direction']): string => {
  const v = dirVector(direction)
  if (v.x < 0) return 'inset(0% 100% 0% 0%)'
  if (v.x > 0) return 'inset(0% 0% 0% 100%)'
  if (v.y < 0) return 'inset(0% 0% 100% 0%)'
  return 'inset(100% 0% 0% 0%)'
}

/* ---- user-input bounds ----
 * A preset's numbers come from the tool call: bound them BEFORE any loop
 * runs so generation can never allocate unbounded work. Value knobs
 * clamp to a wide-but-finite range; loop counts — the params and rates
 * that size a for-loop — cap at ELEMENT_PRESET_MAX_LOOPS iterations, and
 * duration itself is capped so rate·duration loops stay bounded too. */
export const ELEMENT_PRESET_MAX_LOOPS = 64
export const ELEMENT_PRESET_MAX_DURATION = 3600
const MAX_PARAM = 1e6
const MAX_DISTANCE = 100_000

const bounded = (v: number | undefined, def: number, min = -MAX_PARAM, max = MAX_PARAM): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def

/** a preset knob: a non-finite user value falls back to the default, a
 *  finite one clamps into ±MAX_PARAM — angles and amplitudes stay sane,
 *  nothing turns into NaN keyframes */
const pnum = (o: Resolved, id: string, def: number): number => bounded(o.p[id], def)

/** a user-supplied loop count — swings, steps, bounces, octaves — clamped
 *  to a whole number in [min, ELEMENT_PRESET_MAX_LOOPS] */
const loopCount = (o: Resolved, id: string, def: number, min = 1): number =>
  Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(min, Math.round(pnum(o, id, def))))

/* ---- the specs ---- */

const specs: ElementPresetSpec[] = [
  /* ================= entrances ================= */
  {
    id: 'fade-in',
    family: 'entrance',
    use: 'a quiet arrival — nothing moves, the element just appears',
    params: [],
    duration: 0.6,
    easing: EASE_OUT,
    keyframes: (o) => span('opacity', o.t, o.d, 0, 1, o.ease),
  },
  {
    id: 'rise',
    family: 'entrance',
    use: 'content drifting up into place — feeds, cards, captions',
    params: [],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [...span('y', o.t, o.d, o.dist, 0, o.ease), ...span('opacity', o.t, o.d * 0.8, 0, 1, o.ease)],
  },
  {
    id: 'drop',
    family: 'entrance',
    use: 'falls in from above with a small settle',
    params: [{ id: 'overshoot', def: 0.06, note: 'fraction of distance the settle dips below rest' }],
    duration: 0.7,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('y', o.t, o.d * 0.7, -o.dist, o.dist * pnum(o, 'overshoot', 0.06), o.ease),
      kf('y', o.t + o.d * 0.7, o.dist * pnum(o, 'overshoot', 0.06), EASE_OUT),
      kf('y', o.t + o.d, 0, o.ease),
      ...span('opacity', o.t, o.d * 0.5, 0, 1, o.ease),
    ],
  },
  {
    id: 'slide-in',
    family: 'entrance',
    use: 'a lateral entrance from a named side — the workhorse move',
    params: [],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('x', o.t, o.d, o.dir.x * o.dist, 0, o.ease),
      ...span('y', o.t, o.d, o.dir.y * o.dist, 0, o.ease),
    ],
  },
  {
    id: 'pop',
    family: 'entrance',
    use: 'buttons, stickers, reactions — the springy scale-up',
    params: [
      { id: 'stiffness', def: 170 },
      { id: 'damping', def: 12 },
    ],
    duration: 0.6,
    easing: SPRING,
    keyframes: (o) => {
      const spring: MotionEasing = {
        type: 'spring',
        stiffness: pnum(o, 'stiffness', 170),
        damping: pnum(o, 'damping', 12),
        mass: 1,
      }
      return [...span('scale', o.t, o.d, 0.6, 1, spring), ...span('opacity', o.t, o.d * 0.4, 0, 1, o.ease)]
    },
  },
  {
    id: 'scale-in',
    family: 'entrance',
    use: 'a gentle grow into place — calmer than pop',
    params: [{ id: 'from', def: 0.92, note: 'start scale' }],
    duration: 0.6,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, pnum(o, 'from', 0.92), 1, o.ease),
      ...span('opacity', o.t, o.d * 0.6, 0, 1, o.ease),
    ],
  },
  {
    id: 'zoom-in-blur',
    family: 'entrance',
    use: 'the cinematic zoom-out-to-sharp reveal',
    params: [
      { id: 'from', def: 1.4, note: 'start scale' },
      { id: 'blur', def: 12, note: 'start blur px' },
    ],
    duration: 0.8,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, pnum(o, 'from', 1.4), 1, o.ease),
      ...span('blur', o.t, o.d, pnum(o, 'blur', 12), 0, o.ease),
      ...span('opacity', o.t, o.d * 0.6, 0, 1, o.ease),
    ],
  },
  {
    id: 'blur-in',
    family: 'entrance',
    use: 'focus pulling in — headlines, photos',
    params: [{ id: 'blur', def: 16, note: 'start blur px' }],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('blur', o.t, o.d, pnum(o, 'blur', 16), 0, o.ease),
      ...span('opacity', o.t, o.d * 0.7, 0, 1, o.ease),
    ],
  },
  {
    id: 'spin-in',
    family: 'entrance',
    use: 'a turn into place — badges, coins, logos',
    params: [{ id: 'turns', def: -0.25, note: 'rotations at start (negative = counter-clockwise)' }],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('rotate', o.t, o.d, pnum(o, 'turns', -0.25) * 360, 0, o.ease),
      ...span('scale', o.t, o.d, 0.85, 1, o.ease),
      ...span('opacity', o.t, o.d * 0.5, 0, 1, o.ease),
    ],
  },
  {
    id: 'swing-in',
    family: 'entrance',
    use: 'drops in swinging, pendulum settling — signs, tags',
    params: [
      { id: 'angle', def: -25, note: 'start degrees' },
      { id: 'swings', def: 3, note: 'oscillation count' },
    ],
    duration: 1.1,
    easing: EASE_OUT,
    keyframes: (o) => {
      const angle = pnum(o, 'angle', -25)
      const swings = loopCount(o, 'swings', 3)
      const kfs: MotionKeyframe[] = [kf('rotate', o.t, angle, o.ease)]
      /* damped oscillation: each half-swing carries 60% of the previous */
      for (let i = 1; i <= swings; i++) {
        const amp = -angle * Math.pow(0.55, i) * (i % 2 === 1 ? 1 : -1) * -1
        kfs.push(kf('rotate', o.t + (o.d * i) / (swings + 1), amp, EASE_IN_OUT))
      }
      kfs.push(kf('rotate', o.t + o.d, 0, o.ease))
      kfs.push(...span('opacity', o.t, o.d * 0.4, 0, 1, o.ease))
      return kfs
    },
  },
  {
    id: 'flip-in',
    family: 'entrance',
    use: 'card-flip reveal around an axis',
    params: [{ id: 'axis', def: 0, note: '0 = horizontal flip (scaleX), 1 = vertical (scaleY)' }],
    duration: 0.7,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const prop = pnum(o, 'axis', 0) < 0.5 ? 'scaleX' : 'scaleY'
      return [...span(prop, o.t, o.d, -1, 1, o.ease), ...span('opacity', o.t, o.d * 0.5, 0, 1, o.ease)]
    },
  },
  {
    id: 'wipe-in',
    family: 'entrance',
    use: 'a hard-edged reveal sweeping in from a side',
    params: [],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) =>
      span('clipPath', o.t, o.d, clipHidden(o.direction === undefined ? 'left' : o.direction), REST_CLIP, o.ease),
  },
  {
    id: 'iris-in',
    family: 'entrance',
    use: 'a circular reveal opening from the centre (or a corner)',
    params: [
      { id: 'ox', def: 50, note: 'origin x %' },
      { id: 'oy', def: 50, note: 'origin y %' },
      { id: 'steps', def: 6, note: 'discrete iris rings — clip circle steps' },
    ],
    duration: 0.8,
    easing: EASE_OUT,
    keyframes: (o) => {
      const ox = pnum(o, 'ox', 50)
      const oy = pnum(o, 'oy', 50)
      const steps = loopCount(o, 'steps', 6, 2)
      const kfs: MotionKeyframe[] = [kf('clipPath', o.t, `circle(0% at ${ox}% ${oy}%)`, HOLD)]
      for (let i = 1; i < steps; i++) {
        kfs.push(kf('clipPath', o.t + (o.d * i) / steps, `circle(${(75 * i) / steps}% at ${ox}% ${oy}%)`, HOLD))
      }
      kfs.push(kf('clipPath', o.t + o.d, REST_CLIP, o.ease))
      kfs.push(...span('opacity', o.t, o.d * 0.3, 0, 1, o.ease))
      return kfs
    },
  },
  {
    id: 'stretch-in',
    family: 'entrance',
    use: 'elastically stretches on — banners, bars, chips',
    params: [],
    duration: 0.7,
    easing: BACK_OUT,
    keyframes: (o) => [
      ...span('scaleX', o.t, o.d, 0, 1, o.ease),
      ...span('scaleY', o.t, o.d, 1.15, 1, o.ease),
      ...span('opacity', o.t, o.d * 0.4, 0, 1, o.ease),
    ],
  },
  {
    id: 'bounce-in',
    family: 'entrance',
    use: 'drops in and bounces — playful arrivals, notifications',
    params: [
      { id: 'restitution', def: 0.6, note: 'bounce height decay' },
      { id: 'bounces', def: 3, note: 'impact count' },
    ],
    duration: 1.0,
    easing: EASE_IN,
    keyframes: (o) => {
      const r = pnum(o, 'restitution', 0.6)
      const n = loopCount(o, 'bounces', 3)
      const kfs: MotionKeyframe[] = [kf('y', o.t, -o.dist, EASE_IN)]
      /* the fall is ~35% of the span; bounces tile the rest, decaying r²ⁿ */
      const t = o.t + o.d * 0.35
      const slice = (o.d * 0.65) / n
      kfs.push(kf('y', t, 0, EASE_IN))
      for (let i = 1; i <= n; i++) {
        const peak = -o.dist * Math.pow(r, 2 * i)
        kfs.push(kf('y', t + slice * (i - 0.5), peak, EASE_OUT))
        kfs.push(kf('y', t + slice * i, 0, EASE_IN))
      }
      kfs.push(...span('opacity', o.t, o.d * 0.25, 0, 1, o.ease))
      return kfs
    },
  },
  {
    id: 'elastic-in',
    family: 'entrance',
    use: 'scale spring with a big overshoot — jellied arrivals',
    params: [
      { id: 'amplitude', def: 0.7, note: 'overshoot size 0..1' },
      { id: 'period', def: 0.4, note: 'oscillation period s' },
    ],
    duration: 1.1,
    easing: SPRING,
    keyframes: (o) => {
      const period = Math.max(0.05, pnum(o, 'period', 0.4))
      const amp = Math.min(1, Math.max(0, pnum(o, 'amplitude', 0.7)))
      const spring: MotionEasing = {
        type: 'spring',
        stiffness: Math.pow((2 * Math.PI) / period, 2),
        damping: 18 - amp * 16,
        mass: 1,
      }
      return [...span('scale', o.t, o.d, 0, 1, spring), ...span('opacity', o.t, o.d * 0.2, 0, 1, o.ease)]
    },
  },
  {
    id: 'skew-in',
    family: 'entrance',
    use: 'slides in leaning, snapping upright — kinetic type',
    params: [{ id: 'skew', def: -25, note: 'start skewX degrees' }],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('x', o.t, o.d, o.dir.x * o.dist + o.dir.y * o.dist, 0, o.ease),
      ...span('y', o.t, o.d, o.dir.y * o.dist, 0, o.ease),
      ...span('skewX', o.t, o.d * 0.6, pnum(o, 'skew', -25), 8, o.ease),
      kf('skewX', o.t + o.d * 0.6, 8, EASE_OUT),
      kf('skewX', o.t + o.d, 0, o.ease),
      ...span('opacity', o.t, o.d * 0.4, 0, 1, o.ease),
    ],
  },
  {
    id: 'unfold',
    family: 'entrance',
    use: 'unfolds open from the top edge — menus, panels, drawers',
    params: [],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => [
      ...span('scaleY', o.t, o.d, 0, 1, o.ease),
      ...span('scaleX', o.t, o.d, 0.9, 1, o.ease),
      ...span('opacity', o.t, o.d * 0.5, 0, 1, o.ease),
    ],
  },
  {
    id: 'glitch-in',
    family: 'entrance',
    use: 'signal-breakup arrival — seeded jumps and slices',
    params: [{ id: 'steps', def: 5, note: 'glitch count' }],
    duration: 0.6,
    easing: HOLD,
    keyframes: (o) => {
      const rng = seededRandom(o.seed)
      const steps = loopCount(o, 'steps', 5, 2)
      const amp = o.int * 60 + 10
      const kfs: MotionKeyframe[] = [kf('opacity', o.t, 0, HOLD)]
      for (let i = 0; i < steps; i++) {
        const t = o.t + (o.d * i) / steps
        kfs.push(kf('x', t, (rng() * 2 - 1) * amp, HOLD))
        kfs.push(kf('clipPath', t, `inset(${Math.floor(rng() * 40)}% 0% ${Math.floor(rng() * 40)}% 0%)`, HOLD))
        kfs.push(kf('opacity', t, 0.3 + rng() * 0.7, HOLD))
      }
      kfs.push(
        kf('x', o.t + o.d, 0, HOLD),
        kf('clipPath', o.t + o.d, REST_CLIP, HOLD),
        kf('opacity', o.t + o.d, 1, HOLD),
      )
      return kfs
    },
  },
  {
    id: 'draw-on',
    family: 'entrance',
    use: 'writes itself on left-to-right — the SVG stroke variant lands with path tools (P5)',
    params: [],
    duration: 0.9,
    easing: EASE_IN_OUT,
    keyframes: (o) => [
      ...span('clipPath', o.t, o.d, 'inset(0% 100% 0% 0%)', REST_CLIP, o.ease),
      ...span('x', o.t, o.d * 0.5, 4, 0, EASE_OUT),
      ...span('opacity', o.t, o.d * 0.2, 0, 1, o.ease),
    ],
  },

  /* ================= exits — the mirrors ================= */
  {
    id: 'fade-out',
    family: 'exit',
    use: 'the quiet leave',
    params: [],
    duration: 0.42,
    easing: EASE_IN,
    keyframes: (o) => span('opacity', o.t, o.d, 1, 0, o.ease),
  },
  {
    id: 'sink',
    family: 'exit',
    use: 'drops away below — mirror of rise',
    params: [],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('y', o.t, o.d, 0, o.dist, o.ease),
      ...span('opacity', o.t + o.d * 0.2, o.d * 0.8, 1, 0, o.ease),
    ],
  },
  {
    id: 'lift-out',
    family: 'exit',
    use: 'floats up and out — mirror of drop',
    params: [{ id: 'overshoot', def: 0.06 }],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      kf('y', o.t, 0, EASE_IN),
      kf('y', o.t + o.d * 0.3, o.dist * pnum(o, 'overshoot', 0.06), EASE_IN),
      ...span('y', o.t + o.d * 0.3, o.d * 0.7, o.dist * pnum(o, 'overshoot', 0.06), -o.dist, o.ease),
      ...span('opacity', o.t + o.d * 0.4, o.d * 0.6, 1, 0, o.ease),
    ],
  },
  {
    id: 'slide-out',
    family: 'exit',
    use: 'slides away to a side — mirror of slide-in',
    params: [],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('x', o.t, o.d, 0, o.dir.x * o.dist, o.ease),
      ...span('y', o.t, o.d, 0, o.dir.y * o.dist, o.ease),
    ],
  },
  {
    id: 'pop-out',
    family: 'exit',
    use: 'shrinks away — mirror of pop',
    params: [],
    duration: 0.42,
    easing: BACK_IN,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, 1, 0.6, o.ease),
      ...span('opacity', o.t + o.d * 0.5, o.d * 0.5, 1, 0, o.ease),
    ],
  },
  {
    id: 'scale-out',
    family: 'exit',
    use: 'shrink-fades away — mirror of scale-in',
    params: [{ id: 'to', def: 0.85, note: 'end scale' }],
    duration: 0.42,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, 1, pnum(o, 'to', 0.85), o.ease),
      ...span('opacity', o.t + o.d * 0.3, o.d * 0.7, 1, 0, o.ease),
    ],
  },
  {
    id: 'zoom-out-blur',
    family: 'exit',
    use: 'rushes at the lens and dissolves — mirror of zoom-in-blur',
    params: [
      { id: 'to', def: 1.4 },
      { id: 'blur', def: 12 },
    ],
    duration: 0.56,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, 1, pnum(o, 'to', 1.4), o.ease),
      ...span('blur', o.t, o.d, 0, pnum(o, 'blur', 12), o.ease),
      ...span('opacity', o.t + o.d * 0.3, o.d * 0.7, 1, 0, o.ease),
    ],
  },
  {
    id: 'blur-out',
    family: 'exit',
    use: 'defocuses away — mirror of blur-in',
    params: [{ id: 'blur', def: 16 }],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('blur', o.t, o.d, 0, pnum(o, 'blur', 16), o.ease),
      ...span('opacity', o.t + o.d * 0.3, o.d * 0.7, 1, 0, o.ease),
    ],
  },
  {
    id: 'spin-out',
    family: 'exit',
    use: 'spins away — mirror of spin-in',
    params: [{ id: 'turns', def: 0.25 }],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('rotate', o.t, o.d, 0, pnum(o, 'turns', 0.25) * 360, o.ease),
      ...span('scale', o.t, o.d, 1, 0.85, o.ease),
      ...span('opacity', o.t + o.d * 0.4, o.d * 0.6, 1, 0, o.ease),
    ],
  },
  {
    id: 'swing-out',
    family: 'exit',
    use: 'swings up and away — mirror of swing-in',
    params: [
      { id: 'angle', def: 25 },
      { id: 'swings', def: 3 },
    ],
    duration: 0.77,
    easing: EASE_IN,
    keyframes: (o) => {
      const angle = pnum(o, 'angle', 25)
      const swings = loopCount(o, 'swings', 3)
      const kfs: MotionKeyframe[] = [kf('rotate', o.t, 0, EASE_IN)]
      for (let i = 1; i <= swings; i++) {
        const amp = angle * (0.4 + 0.6 * (i / swings)) * (i % 2 === 0 ? -1 : 1)
        kfs.push(kf('rotate', o.t + (o.d * i) / (swings + 1), amp, EASE_IN_OUT))
      }
      kfs.push(kf('rotate', o.t + o.d, angle, o.ease))
      kfs.push(...span('opacity', o.t + o.d * 0.5, o.d * 0.5, 1, 0, o.ease))
      return kfs
    },
  },
  {
    id: 'flip-out',
    family: 'exit',
    use: 'flips away around an axis — mirror of flip-in',
    params: [{ id: 'axis', def: 0 }],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => {
      const prop = pnum(o, 'axis', 0) < 0.5 ? 'scaleX' : 'scaleY'
      return [...span(prop, o.t, o.d, 1, -1, o.ease), ...span('opacity', o.t + o.d * 0.4, o.d * 0.6, 1, 0, o.ease)]
    },
  },
  {
    id: 'wipe-out',
    family: 'exit',
    use: 'a hard-edged hide sweeping to a side — mirror of wipe-in',
    params: [],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) =>
      span('clipPath', o.t, o.d, REST_CLIP, clipHidden(o.direction === undefined ? 'right' : o.direction), o.ease),
  },
  {
    id: 'iris-out',
    family: 'exit',
    use: 'closes down to a point — mirror of iris-in',
    params: [
      { id: 'ox', def: 50 },
      { id: 'oy', def: 50 },
      { id: 'steps', def: 6 },
    ],
    duration: 0.56,
    easing: EASE_IN,
    keyframes: (o) => {
      const ox = pnum(o, 'ox', 50)
      const oy = pnum(o, 'oy', 50)
      const steps = loopCount(o, 'steps', 6, 2)
      const kfs: MotionKeyframe[] = [kf('clipPath', o.t, REST_CLIP, HOLD)]
      for (let i = 1; i < steps; i++) {
        kfs.push(kf('clipPath', o.t + (o.d * i) / steps, `circle(${75 - (75 * i) / steps}% at ${ox}% ${oy}%)`, HOLD))
      }
      kfs.push(kf('clipPath', o.t + o.d, `circle(0% at ${ox}% ${oy}%)`, HOLD))
      kfs.push(...span('opacity', o.t + o.d * 0.6, o.d * 0.4, 1, 0, o.ease))
      return kfs
    },
  },
  {
    id: 'stretch-out',
    family: 'exit',
    use: 'flattens away — mirror of stretch-in',
    params: [],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('scaleX', o.t, o.d, 1, 0, o.ease),
      ...span('scaleY', o.t, o.d, 1, 1.15, o.ease),
      ...span('opacity', o.t + o.d * 0.5, o.d * 0.5, 1, 0, o.ease),
    ],
  },
  {
    id: 'bounce-out',
    family: 'exit',
    use: 'anticipates then drops away — mirror of bounce-in',
    params: [{ id: 'anticipate', def: 0.08, note: 'fraction of distance it rises first' }],
    duration: 0.7,
    easing: EASE_IN,
    keyframes: (o) => [
      kf('y', o.t, 0, EASE_IN),
      kf('y', o.t + o.d * 0.25, -o.dist * pnum(o, 'anticipate', 0.08), EASE_OUT),
      ...span('y', o.t + o.d * 0.25, o.d * 0.75, -o.dist * pnum(o, 'anticipate', 0.08), o.dist, EASE_IN),
      ...span('opacity', o.t + o.d * 0.6, o.d * 0.4, 1, 0, o.ease),
    ],
  },
  {
    id: 'elastic-out',
    family: 'exit',
    use: 'gathers then snaps shut — mirror of elastic-in',
    params: [],
    duration: 0.77,
    easing: BACK_IN,
    keyframes: (o) => [
      ...span('scale', o.t, o.d, 1, 0, o.ease),
      ...span('opacity', o.t + o.d * 0.6, o.d * 0.4, 1, 0, o.ease),
    ],
  },
  {
    id: 'skew-out',
    family: 'exit',
    use: 'leans away and slides off — mirror of skew-in',
    params: [{ id: 'skew', def: 25 }],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('x', o.t, o.d, 0, o.dir.x * o.dist + o.dir.y * o.dist, o.ease),
      ...span('y', o.t, o.d, 0, o.dir.y * o.dist, o.ease),
      ...span('skewX', o.t, o.d * 0.6, 0, pnum(o, 'skew', 25), o.ease),
      ...span('opacity', o.t + o.d * 0.5, o.d * 0.5, 1, 0, o.ease),
    ],
  },
  {
    id: 'fold',
    family: 'exit',
    use: 'folds shut — mirror of unfold',
    params: [],
    duration: 0.49,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('scaleY', o.t, o.d, 1, 0, o.ease),
      ...span('scaleX', o.t, o.d, 1, 0.9, o.ease),
      ...span('opacity', o.t + o.d * 0.5, o.d * 0.5, 1, 0, o.ease),
    ],
  },
  {
    id: 'glitch-out',
    family: 'exit',
    use: 'breaks up and drops — mirror of glitch-in',
    params: [{ id: 'steps', def: 5 }],
    duration: 0.42,
    easing: HOLD,
    keyframes: (o) => {
      const rng = seededRandom(o.seed)
      const steps = loopCount(o, 'steps', 5, 2)
      const amp = o.int * 60 + 10
      const kfs: MotionKeyframe[] = [
        kf('x', o.t, 0, HOLD),
        kf('clipPath', o.t, REST_CLIP, HOLD),
        kf('opacity', o.t, 1, HOLD),
      ]
      for (let i = 1; i < steps; i++) {
        const t = o.t + (o.d * i) / steps
        kfs.push(kf('x', t, (rng() * 2 - 1) * amp, HOLD))
        kfs.push(kf('clipPath', t, `inset(${Math.floor(rng() * 40)}% 0% ${Math.floor(rng() * 40)}% 0%)`, HOLD))
        kfs.push(kf('opacity', t, 0.3 + rng() * 0.7, HOLD))
      }
      kfs.push(
        kf('x', o.t + o.d, 0, HOLD),
        kf('clipPath', o.t + o.d, 'inset(0% 0% 0% 0%)', HOLD),
        kf('opacity', o.t + o.d, 0, HOLD),
      )
      return kfs
    },
  },
  {
    id: 'erase',
    family: 'exit',
    use: 'wipes away left-to-right — mirror of draw-on',
    params: [],
    duration: 0.63,
    easing: EASE_IN,
    keyframes: (o) => [
      ...span('clipPath', o.t, o.d, REST_CLIP, 'inset(0% 0% 0% 100%)', o.ease),
      ...span('opacity', o.t + o.d * 0.6, o.d * 0.4, 1, 0, o.ease),
    ],
  },

  /* ================= emphasis — rest on both ends ================= */
  {
    id: 'pulse',
    family: 'emphasis',
    use: 'a heartbeat-size nudge — draws the eye without moving anything',
    params: [
      { id: 'scale', def: 1.06, note: 'peak scale' },
      { id: 'count', def: 1, note: 'pulse count' },
    ],
    duration: 0.5,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const peak = pnum(o, 'scale', 1.06)
      const count = loopCount(o, 'count', 1)
      const kfs: MotionKeyframe[] = [kf('scale', o.t, 1, o.ease)]
      for (let i = 0; i < count; i++) {
        kfs.push(kf('scale', o.t + (o.d * (i + 0.5)) / count, peak, EASE_IN_OUT))
        kfs.push(kf('scale', o.t + (o.d * (i + 1)) / count, 1, EASE_IN_OUT))
      }
      return kfs
    },
  },
  {
    id: 'heartbeat',
    family: 'emphasis',
    use: 'lub-dub — two quick beats then rest',
    params: [{ id: 'scale', def: 1.12, note: 'beat scale' }],
    duration: 0.8,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const s = pnum(o, 'scale', 1.12)
      return [
        kf('scale', o.t, 1, o.ease),
        kf('scale', o.t + o.d * 0.12, s, EASE_OUT),
        kf('scale', o.t + o.d * 0.26, 1, EASE_IN_OUT),
        kf('scale', o.t + o.d * 0.4, 1 + (s - 1) * 0.7, EASE_OUT),
        kf('scale', o.t + o.d, 1, EASE_IN_OUT),
      ]
    },
  },
  {
    id: 'shake',
    family: 'emphasis',
    use: 'attention shake — errors, alerts, playful nags (seeded)',
    params: [
      { id: 'amplitude', def: 8, note: 'px of excursion' },
      { id: 'frequency', def: 10, note: 'jolts per second' },
    ],
    duration: 0.6,
    easing: HOLD,
    keyframes: (o) => {
      const rng = seededRandom(o.seed)
      const amp = pnum(o, 'amplitude', 8) * (0.5 + o.int)
      const n = Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(2, Math.round(pnum(o, 'frequency', 10) * o.d)))
      const kfs: MotionKeyframe[] = [kf('x', o.t, 0, HOLD)]
      for (let i = 1; i <= n; i++) {
        const decay = 1 - i / (n + 1)
        kfs.push(kf('x', o.t + (o.d * i) / n, (rng() * 2 - 1) * amp * decay, HOLD))
      }
      kfs.push(kf('x', o.t + o.d, 0, HOLD))
      return kfs
    },
  },
  {
    id: 'wobble',
    family: 'emphasis',
    use: 'a loose rotate wiggle — jelly balance',
    params: [
      { id: 'angle', def: 5, note: 'peak degrees' },
      { id: 'swings', def: 2 },
    ],
    duration: 0.7,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const angle = pnum(o, 'angle', 5)
      const swings = loopCount(o, 'swings', 2)
      const kfs: MotionKeyframe[] = [kf('rotate', o.t, 0, o.ease)]
      for (let i = 1; i <= swings * 2; i++) {
        const amp = angle * (1 - i / (swings * 2 + 1)) * (i % 2 === 0 ? 1 : -1)
        kfs.push(kf('rotate', o.t + (o.d * i) / (swings * 2 + 1), amp, EASE_IN_OUT))
      }
      kfs.push(kf('rotate', o.t + o.d, 0, o.ease))
      return kfs
    },
  },
  {
    id: 'nod',
    family: 'emphasis',
    use: 'a small dip, twice — nod on y, headshake on x (axis)',
    params: [
      { id: 'axis', def: 0, note: '0 = nod (y), 1 = headshake (x)' },
      { id: 'amount', def: 6, note: 'px per dip' },
    ],
    duration: 0.6,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const prop = pnum(o, 'axis', 0) < 0.5 ? 'y' : 'x'
      const a = pnum(o, 'amount', 6)
      return [
        kf(prop, o.t, 0, o.ease),
        kf(prop, o.t + o.d * 0.18, a, EASE_IN_OUT),
        kf(prop, o.t + o.d * 0.36, 0, EASE_IN_OUT),
        kf(prop, o.t + o.d * 0.6, a * 0.7, EASE_IN_OUT),
        kf(prop, o.t + o.d, 0, o.ease),
      ]
    },
  },
  {
    id: 'jello',
    family: 'emphasis',
    use: 'skew wobble on both axes — the jelly belly',
    params: [{ id: 'amount', def: 10, note: 'peak skew degrees' }],
    duration: 0.9,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const a = pnum(o, 'amount', 10)
      const kfs: MotionKeyframe[] = [kf('skewX', o.t, 0, o.ease), kf('skewY', o.t, 0, o.ease)]
      const seq = [1, -0.75, 0.5, -0.3, 0.15]
      seq.forEach((f, i) => {
        const t = o.t + (o.d * (i + 1)) / (seq.length + 1)
        kfs.push(kf('skewX', t, a * f, EASE_IN_OUT))
        kfs.push(kf('skewY', t, a * f * 0.7 * (i % 2 === 0 ? -1 : 1), EASE_IN_OUT))
      })
      kfs.push(kf('skewX', o.t + o.d, 0, o.ease), kf('skewY', o.t + o.d, 0, o.ease))
      return kfs
    },
  },
  {
    id: 'rubber-band',
    family: 'emphasis',
    use: 'stretch-snap on one axis — elastic boing',
    params: [{ id: 'stretch', def: 1.3, note: 'peak scaleX' }],
    duration: 0.7,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const s = pnum(o, 'stretch', 1.3)
      const seqX = [s, 0.9, 1.08, 0.97]
      const seqY = [0.75, 1.08, 0.95, 1.02]
      const kfs: MotionKeyframe[] = [kf('scaleX', o.t, 1, o.ease), kf('scaleY', o.t, 1, o.ease)]
      seqX.forEach((v, i) => {
        const t = o.t + (o.d * (i + 1)) / (seqX.length + 1)
        kfs.push(kf('scaleX', t, v, EASE_IN_OUT), kf('scaleY', t, seqY[i]!, EASE_IN_OUT))
      })
      kfs.push(kf('scaleX', o.t + o.d, 1, o.ease), kf('scaleY', o.t + o.d, 1, o.ease))
      return kfs
    },
  },
  {
    id: 'tada',
    family: 'emphasis',
    use: 'the celebrate: dip, bounce and a little wiggle',
    params: [],
    duration: 1.0,
    easing: EASE_IN_OUT,
    keyframes: (o) => [
      kf('scale', o.t, 1, o.ease),
      kf('scale', o.t + o.d * 0.12, 0.9, EASE_IN_OUT),
      kf('scale', o.t + o.d * 0.4, 1.1, EASE_IN_OUT),
      kf('scale', o.t + o.d * 0.7, 1.05, EASE_IN_OUT),
      kf('scale', o.t + o.d, 1, EASE_IN_OUT),
      kf('rotate', o.t, 0, o.ease),
      kf('rotate', o.t + o.d * 0.3, -3, EASE_IN_OUT),
      kf('rotate', o.t + o.d * 0.5, 3, EASE_IN_OUT),
      kf('rotate', o.t + o.d * 0.7, -1.5, EASE_IN_OUT),
      kf('rotate', o.t + o.d, 0, o.ease),
    ],
  },
  {
    id: 'float',
    family: 'emphasis',
    use: 'a slow sine hover — seamless loop',
    params: [
      { id: 'amplitude', def: 8, note: 'px of hover' },
      { id: 'period', def: 2, note: 's per loop' },
    ],
    duration: 2,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const a = pnum(o, 'amplitude', 8)
      const period = Math.max(0.1, pnum(o, 'period', 2))
      const loops = Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(1, Math.round(o.d / period)))
      const kfs: MotionKeyframe[] = [kf('y', o.t, 0, EASE_IN_OUT)]
      const slice = o.d / (loops * 4)
      for (let i = 1; i < loops * 4; i++) {
        kfs.push(kf('y', o.t + slice * i, -a * Math.sin((Math.PI / 2) * (i % 4 === 0 ? 0 : i)), EASE_IN_OUT))
      }
      kfs.push(kf('y', o.t + o.d, 0, EASE_IN_OUT))
      return kfs
    },
  },
  {
    id: 'breathe',
    family: 'emphasis',
    use: 'a slow scale swell — the loop that reads alive',
    params: [
      { id: 'amplitude', def: 1.04, note: 'peak scale' },
      { id: 'period', def: 3, note: 's per breath' },
    ],
    duration: 3,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const a = pnum(o, 'amplitude', 1.04)
      const period = Math.max(0.1, pnum(o, 'period', 3))
      const loops = Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(1, Math.round(o.d / period)))
      const kfs: MotionKeyframe[] = [kf('scale', o.t, 1, EASE_IN_OUT)]
      const slice = o.d / (loops * 2)
      for (let i = 1; i < loops * 2; i++) {
        kfs.push(kf('scale', o.t + slice * i, i % 2 === 1 ? a : 1, EASE_IN_OUT))
      }
      kfs.push(kf('scale', o.t + o.d, 1, EASE_IN_OUT))
      return kfs
    },
  },
  {
    id: 'sway',
    family: 'emphasis',
    use: 'a slow pendulum lean — plants, pendants, charms',
    params: [
      { id: 'angle', def: 4, note: 'peak degrees' },
      { id: 'period', def: 2.4 },
    ],
    duration: 2.4,
    easing: EASE_IN_OUT,
    keyframes: (o) => {
      const a = pnum(o, 'angle', 4)
      const period = Math.max(0.1, pnum(o, 'period', 2.4))
      const loops = Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(1, Math.round(o.d / period)))
      const kfs: MotionKeyframe[] = [kf('rotate', o.t, 0, EASE_IN_OUT)]
      const slice = o.d / (loops * 4)
      for (let i = 1; i < loops * 4; i++) {
        const v = [a, 0, -a, 0][(((i - 1) % 4) + 4) % 4]!
        kfs.push(kf('rotate', o.t + slice * i, v, EASE_IN_OUT))
      }
      kfs.push(kf('rotate', o.t + o.d, 0, EASE_IN_OUT))
      return kfs
    },
  },
  {
    id: 'wiggle',
    family: 'emphasis',
    use: 'small organic jitter on x, y and rotate — seeded',
    params: [
      { id: 'amplitude', def: 3, note: 'px / deg' },
      { id: 'frequency', def: 8, note: 'wiggles per second' },
      { id: 'octaves', def: 2, note: 'jitter richness' },
    ],
    duration: 0.8,
    easing: HOLD,
    keyframes: (o) => {
      const rng = seededRandom(o.seed)
      const amp = pnum(o, 'amplitude', 3) * (0.5 + o.int)
      const oct = loopCount(o, 'octaves', 2)
      const n = Math.min(ELEMENT_PRESET_MAX_LOOPS, Math.max(2, Math.round(pnum(o, 'frequency', 8) * o.d)))
      const jitter = () => {
        /* two summed samples read richer than one flat uniform step */
        let v = 0
        for (let i = 0; i < oct; i++) v += rng() - 0.5
        return (v / oct) * 2
      }
      const kfs: MotionKeyframe[] = [kf('x', o.t, 0, HOLD), kf('y', o.t, 0, HOLD), kf('rotate', o.t, 0, HOLD)]
      for (let i = 1; i < n; i++) {
        const t = o.t + (o.d * i) / n
        kfs.push(kf('x', t, jitter() * amp, HOLD))
        kfs.push(kf('y', t, jitter() * amp * 0.7, HOLD))
        kfs.push(kf('rotate', t, jitter() * amp * 0.5, HOLD))
      }
      kfs.push(kf('x', o.t + o.d, 0, HOLD), kf('y', o.t + o.d, 0, HOLD), kf('rotate', o.t + o.d, 0, HOLD))
      return kfs
    },
  },
  {
    id: 'flash',
    family: 'emphasis',
    use: 'opacity blinks — attention without movement',
    params: [
      { id: 'count', def: 3, note: 'blink count' },
      { id: 'floor', def: 0.2, note: 'lowest opacity' },
    ],
    duration: 0.6,
    easing: HOLD,
    keyframes: (o) => {
      const count = loopCount(o, 'count', 3)
      const floor = pnum(o, 'floor', 0.2)
      const kfs: MotionKeyframe[] = [kf('opacity', o.t, 1, HOLD)]
      const slice = o.d / (count * 2)
      for (let i = 1; i <= count * 2; i++) {
        kfs.push(kf('opacity', o.t + slice * i, i % 2 === 1 ? floor : 1, HOLD))
      }
      kfs.push(kf('opacity', o.t + o.d, 1, HOLD))
      return kfs
    },
  },
  {
    id: 'punch',
    family: 'emphasis',
    use: 'a fast jab out, slow return — percussive accent',
    params: [{ id: 'scale', def: 1.15, note: 'peak scale' }],
    duration: 0.5,
    easing: EASE_OUT,
    keyframes: (o) => [
      kf('scale', o.t, 1, o.ease),
      kf('scale', o.t + o.d * 0.18, pnum(o, 'scale', 1.15), EASE_OUT),
      kf('scale', o.t + o.d, 1, EASE_IN_OUT),
    ],
  },
  {
    id: 'squash-land',
    family: 'emphasis',
    use: 'lands squashed then stretches back — impact weight',
    params: [{ id: 'squash', def: 0.8, note: 'lowest scaleY' }],
    duration: 0.7,
    easing: EASE_OUT,
    keyframes: (o) => {
      const s = pnum(o, 'squash', 0.8)
      const stretch = 2 - s - 0.1
      return [
        kf('scaleY', o.t, 1, EASE_IN),
        kf('scaleY', o.t + o.d * 0.15, s, EASE_IN),
        kf('scaleY', o.t + o.d * 0.45, 1.1, EASE_IN_OUT),
        kf('scaleY', o.t + o.d, 1, EASE_IN_OUT),
        kf('scaleX', o.t, 1, EASE_IN),
        kf('scaleX', o.t + o.d * 0.15, Math.min(1.6, stretch + 0.35), EASE_IN),
        kf('scaleX', o.t + o.d * 0.45, 0.95, EASE_IN_OUT),
        kf('scaleX', o.t + o.d, 1, EASE_IN_OUT),
      ]
    },
  },
  {
    id: 'orbit',
    family: 'emphasis',
    use: 'a small circular loop around the rest spot',
    params: [
      { id: 'radius', def: 12, note: 'px loop radius' },
      { id: 'turns', def: 1, note: 'loops in the span' },
    ],
    duration: 1.2,
    easing: LINEAR,
    keyframes: (o) => {
      const r = pnum(o, 'radius', 12)
      const turns = loopCount(o, 'turns', 1)
      const steps = turns * 8
      /* sin/cos leave -1e-16 dust on the rest keyframes — snap it so the
         authored lane ends on a clean 0 */
      const z = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v)
      const kfs: MotionKeyframe[] = [kf('x', o.t, 0, o.ease), kf('y', o.t, 0, o.ease)]
      for (let i = 1; i <= steps; i++) {
        const u = (i / steps) * turns * 2 * Math.PI
        const t = o.t + (o.d * i) / steps
        kfs.push(kf('x', t, z(r * Math.sin(u)), o.ease))
        kfs.push(kf('y', t, z(r * (Math.cos(u) - 1)), o.ease))
      }
      return kfs
    },
  },
]

const SPEC_BY_ID = new Map(specs.map((s) => [s.id, s]))

export function elementPresetSpec(id: string): ElementPresetSpec | undefined {
  return SPEC_BY_ID.get(id as ElementPreset)
}

/** catalogue rows for list_element_presets */
export function elementPresetList(): {
  id: ElementPreset
  family: ElementPresetFamily
  use: string
  params: readonly { id: string; def: number; note?: string }[]
  duration: number
}[] {
  return specs.map(({ id, family, use, params, duration }) => ({ id, family, use, params, duration }))
}

/**
 * Compile a preset to ordinary keyframes. `t + duration` is where the
 * preset's last keyframe lands; entrances end at rest, exits start at
 * rest, emphasis holds rest on both ends.
 */
export function elementPreset(id: ElementPreset, opts: ElementPresetOptions): MotionKeyframe[] {
  const spec = SPEC_BY_ID.get(id)
  if (!spec) throw new Error(`unknown element preset ${id}`)
  const duration = opts.duration ?? spec.duration
  /* every number the caller controls is validated before a spec's loop
     ever sees it — a NaN or Infinity must not reach a keyframe */
  if (!Number.isFinite(opts.t) || opts.t < 0) throw new Error(`preset t must be a finite time ≥ 0`)
  if (!Number.isFinite(duration) || duration <= 0 || duration > ELEMENT_PRESET_MAX_DURATION) {
    throw new Error(`preset duration must be finite and ≤ ${ELEMENT_PRESET_MAX_DURATION}s`)
  }
  if (typeof opts.direction === 'number' && !Number.isFinite(opts.direction)) {
    throw new Error('preset direction must be a finite number of degrees')
  }
  const resolved: Resolved = {
    t: opts.t,
    d: duration,
    ease: opts.easing ?? spec.easing,
    direction: opts.direction,
    dir: dirVector(opts.direction),
    dist: bounded(opts.distance, 80, -MAX_DISTANCE, MAX_DISTANCE),
    int: bounded(opts.intensity, 0.5, 0, 1),
    seed: bounded(opts.seed, 1, -MAX_PARAM, MAX_PARAM),
    p: opts.params ?? {},
  }
  /* exits read direction as where the element travels TO, entrances as
     where it comes FROM — both land on the same offset: entrance start =
     dir·d away, exit end = dir·d away. clipPath keyframes carry the preset
     id: the runtime draws a clip lane only while preset-authored, so a
     stored legacy lane keeps its old raster-inert behaviour (AC-8) */
  return spec.keyframes(resolved).map((kf) => (kf.property === 'clipPath' ? { ...kf, preset: spec.id } : kf))
}

/* ---- stagger ---- */

export interface StaggerOptions {
  /** seconds between successive element starts */
  each?: number
  /** total seconds the starts spread over (wins over `each`) */
  amount?: number
  /** which element goes first; default 'start' */
  from?: 'start' | 'end' | 'center' | 'edges' | 'random' | 'position-x' | 'position-y' | 'grid'
  /** easing on the distribution — linear = even gaps, a spring overshoots */
  ease?: MotionEasing
  /** seed for 'random' */
  seed?: number
}

/**
 * Start offsets (seconds) for `n` elements, index-aligned. With `each` the
 * spread is `each · (n−1)`; with `amount` the spread is `amount`. `from`
 * picks which element leads; `ease` reshapes the gaps. Position-based
 * origins need `positions` (the elements' frame-space x/y).
 */
export function staggerOffsets(
  n: number,
  opts: StaggerOptions = {},
  positions?: readonly { x: number; y: number }[],
): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  const from = opts.from ?? 'start'
  /* a caller's each/amount is a user number — bound it before it becomes
     a keyframe time, and bound the each·(n−1) spread itself: the product
     of a clamped value can still overflow */
  const each = bounded(opts.each, 0, 0, ELEMENT_PRESET_MAX_DURATION)
  const span = bounded(
    opts.amount,
    Math.min(ELEMENT_PRESET_MAX_DURATION, each * (n - 1)),
    0,
    ELEMENT_PRESET_MAX_DURATION,
  )

  let order: number[]
  switch (from) {
    case 'start':
      order = Array.from({ length: n }, (_, i) => i)
      break
    case 'end':
      order = Array.from({ length: n }, (_, i) => n - 1 - i)
      break
    case 'center': {
      const mid = (n - 1) / 2
      order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
      break
    }
    case 'edges':
      order = Array.from({ length: n }, (_, i) => i).sort(
        (a, b) => Math.min(a, n - 1 - a) - Math.min(b, n - 1 - b) || a - b,
      )
      break
    case 'random': {
      const rng = seededRandom(opts.seed ?? 1)
      order = Array.from({ length: n }, (_, i) => i)
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      break
    }
    case 'position-x':
    case 'position-y':
    case 'grid': {
      if (!positions || positions.length < n) {
        throw new Error(`stagger from '${from}' needs positions for all ${n} elements`)
      }
      const key = (i: number) =>
        from === 'position-x'
          ? positions[i]!.x
          : from === 'position-y'
            ? positions[i]!.y
            : positions[i]!.x + positions[i]!.y
      order = Array.from({ length: n }, (_, i) => i).sort((a, b) => key(a) - key(b) || a - b)
      break
    }
  }

  const offsets = new Array<number>(n)
  const ease = opts.ease ?? LINEAR
  order.forEach((elementIndex, rank) => {
    const u = rank / (n - 1)
    offsets[elementIndex] = span * (ease.type === 'linear' ? u : easingProgress(ease, u, span))
  })
  return offsets
}
