/**
 * shared/motionRuntime.ts — time → frame state, the pure function every
 * consumer of a composition shares: the timeline editor's preview, the
 * browser renderer, the desktop renderer, tests. Given a composition and a
 * time t it returns exactly what the output shows — the camera rect over the
 * page world, every animated element's resolved properties, and the clips
 * on screen. No DOM, no clocks, no randomness: seek-safe by construction.
 */

import { cssColorToRgba } from './slopRules.ts'
import {
  CAMERA_PROPERTIES,
  elementKey,
  type Composition,
  type FrameMotionKeyframe,
  type MotionClip,
  type MotionEasing,
  type MotionKeyframe,
  type MotionTrackKind,
} from './motion.ts'

/* ---- easing curves ---- */

/** a cubic-bezier timing function, solved the way browsers do: Newton on x
 *  then a bisection fallback, then read y */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const ax = 3 * x1 - 3 * x2 + 1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 3 * y1 - 3 * y2 + 1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-6) return sampleY(t)
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= err / slope
    }
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24 && hi - lo > 1e-6; i++) {
      t = (lo + hi) / 2
      if (sampleX(t) < x) lo = t
      else hi = t
    }
    return sampleY(t)
  }
}

/**
 * A damped harmonic spring, evaluated at `elapsed` real seconds — not
 * normalized progress — so a spring's settle time comes from its physics.
 * Returns the 0→1 progress (it may overshoot past 1, that's the point).
 */
export function springProgress(stiffness: number, damping: number, mass: number, elapsed: number): number {
  if (elapsed <= 0) return 0
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * elapsed) * (Math.cos(wd * elapsed) + ((zeta * w0) / wd) * Math.sin(wd * elapsed))
  }
  if (Math.abs(zeta - 1) < 1e-6) {
    return 1 - Math.exp(-w0 * elapsed) * (1 + w0 * elapsed)
  }
  const root = w0 * Math.sqrt(zeta * zeta - 1)
  const l1 = -zeta * w0 + root
  const l2 = -zeta * w0 - root
  return 1 - (l2 * Math.exp(l1 * elapsed) - l1 * Math.exp(l2 * elapsed)) / (l2 - l1)
}

/**
 * Eased segment progress: `u` is normalized [0,1] progress through the
 * segment, `elapsed` the real seconds since the segment started (springs
 * need real time). `hold` stays 0, which means "keep the from-value" for
 * numbers and strings alike — that is the cut.
 */
export function easingProgress(easing: MotionEasing, u: number, elapsed: number): number {
  switch (easing.type) {
    case 'linear':
      return u
    case 'hold':
      return 0
    case 'steps': {
      const n = easing.steps
      if (easing.position === 'start') return Math.min(1, (Math.floor(u * n) + 1) / n)
      return Math.min(1, Math.floor(u * n) / n)
    }
    case 'cubic-bezier':
      return cubicBezier(easing.x1, easing.y1, easing.x2, easing.y2)(u)
    case 'spring':
      return springProgress(easing.stiffness, easing.damping, easing.mass, elapsed)
    case 'token':
      /* unresolved tokens behave as linear — the caller resolves them via
         resolveEasing before they reach here */
      return u
  }
}

/** lerp two colors channel by channel, returned as rgba() */
function lerpColor(a: string, b: string, e: number): string | null {
  const ca = cssColorToRgba(a)
  const cb = cssColorToRgba(b)
  if (!ca || !cb) return null
  const r = ca.r + (cb.r - ca.r) * e
  const g = ca.g + (cb.g - ca.g) * e
  const bl = ca.b + (cb.b - ca.b) * e
  const al = ca.a + (cb.a - ca.a) * e
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(bl)}, ${Math.round(al * 1000) / 1000})`
}

/**
 * Interpolate a segment's endpoints at eased progress `e`. Numbers lerp;
 * strings that both parse as colors lerp per channel; every other string
 * flips discretely at the midpoint — CSS's discrete-animation behaviour —
 * while `hold`/e=0 keeps the from-value for the whole segment.
 */
export function interpolate(from: number | string, to: number | string, e: number): number | string {
  if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * e
  if (typeof from === 'string' && typeof to === 'string') {
    if (from === to) return from
    const color = lerpColor(from, to, e)
    if (color !== null) return color
  }
  return e < 0.5 ? from : to
}

/* ---- keyframe lane evaluation ---- */

export type ResolveEasing = (name: string) => MotionEasing | undefined

function resolve(easing: MotionEasing, fn?: ResolveEasing): MotionEasing {
  if (easing.type !== 'token') return easing
  return fn?.(easing.name) ?? { type: 'linear' }
}

/**
 * One property lane (already sorted by t): the value at time t. Before the
 * first keyframe and after the last, the lane holds the endpoint value —
 * shots and poses don't vanish at their edges.
 */
export function laneValueAt(kfs: readonly MotionKeyframe[], t: number, resolveEasing?: ResolveEasing): number | string {
  const first = kfs[0]!
  if (kfs.length === 1 || t <= first.t) return first.value
  const last = kfs[kfs.length - 1]!
  if (t >= last.t) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!
    const b = kfs[i + 1]!
    if (t < a.t || t >= b.t) continue
    const u = (t - a.t) / (b.t - a.t)
    const e = easingProgress(resolve(a.easing, resolveEasing), u, t - a.t)
    return interpolate(a.value, b.value, e)
  }
  return last.value
}

/** group a track's keyframes into sorted lanes by property */
export function keyframeLanes(kfs: readonly MotionKeyframe[]): Map<string, MotionKeyframe[]> {
  const lanes = new Map<string, MotionKeyframe[]>()
  for (const kf of kfs) {
    const lane = lanes.get(kf.property)
    if (lane) lane.push(kf)
    else lanes.set(kf.property, [kf])
  }
  for (const lane of lanes.values()) lane.sort((a, b) => a.t - b.t)
  return lanes
}

/* ---- the state at t ---- */

export interface CameraState {
  /** world coords of the view's centre */
  x: number
  y: number
  /** output px per world px */
  zoom: number
  /** degrees clockwise */
  rotation: number
}

export interface ActiveClip {
  trackId: string
  kind: MotionTrackKind
  clip: MotionClip
}

export interface CompositionStateAt {
  /** the requested time, clamped to [0, duration] */
  t: number
  /** the camera rect over page world, or null when the composition has no
   *  camera keyframes (the caller keeps whatever view it had) */
  camera: CameraState | null
  /** `frameId/elementId` → resolved property values */
  elements: Record<string, Record<string, number | string>>
  /** the clips on screen at t, in track order */
  activeClips: ActiveClip[]
}

export interface FrameStateOptions {
  /** resolve `--ease-*`/`--spring-*` motion tokens to concrete easings */
  resolveEasing?: ResolveEasing
  /** frame-authored keyframes (`data-doop-motion` blocks), per frame id —
   *  evaluated first; a composition element track overrides the same
   *  property on the same element */
  frameBlocks?: ReadonlyMap<string, readonly FrameMotionKeyframe[]>
}

/**
 * The frame state at composition time `t`: camera, element properties and
 * active clips. Pure — same inputs, same output — which is what seeking and
 * deterministic rendering need.
 */
export function frameStateAt(comp: Composition, t: number, opts?: FrameStateOptions): CompositionStateAt {
  const clamped = Math.max(0, Math.min(comp.duration, t))

  /* camera */
  let camera: CameraState | null = null
  const cameraTrack = comp.tracks.find((track) => track.kind === 'camera' && !track.muted)
  const cameraKfs = cameraTrack?.keyframes ?? []
  if (cameraKfs.length > 0) {
    const lanes = keyframeLanes(cameraKfs)
    camera = { x: 0, y: 0, zoom: 1, rotation: 0 }
    for (const prop of CAMERA_PROPERTIES) {
      const lane = lanes.get(prop)
      if (lane && lane.length > 0) {
        const v = laneValueAt(lane, clamped, opts?.resolveEasing)
        camera[prop] = typeof v === 'number' ? v : Number.parseFloat(v) || 0
      }
    }
  }

  /* elements: frame-authored blocks first, element tracks on top */
  const elements: Record<string, Record<string, number | string>> = {}
  if (opts?.frameBlocks) {
    for (const [frameId, kfs] of opts.frameBlocks) {
      /* block keyframes are lanes per (el, prop) */
      const lanes = new Map<string, Map<string, MotionKeyframe[]>>()
      for (const raw of kfs) {
        const kf: MotionKeyframe = {
          id: `${frameId}/${raw.el}/${raw.prop}/${raw.t}`,
          property: raw.prop,
          t: raw.t,
          value: raw.value,
          easing: raw.ease ?? { type: 'linear' },
        }
        let el = lanes.get(raw.el)
        if (!el) lanes.set(raw.el, (el = new Map()))
        const lane = el.get(raw.prop)
        if (lane) lane.push(kf)
        else el.set(raw.prop, [kf])
      }
      for (const [el, props] of lanes) {
        const k = elementKey(frameId, el)
        for (const [prop, lane] of props) {
          lane.sort((a, b) => a.t - b.t)
          ;(elements[k] ??= {})[prop] = laneValueAt(lane, clamped, opts.resolveEasing)
        }
      }
    }
  }
  for (const track of comp.tracks) {
    if (track.kind !== 'element' || track.muted || !track.frameId || !track.elementId) continue
    const lanes = keyframeLanes(track.keyframes ?? [])
    if (lanes.size === 0) continue
    const key = elementKey(track.frameId, track.elementId)
    const props = (elements[key] ??= {})
    for (const [prop, lane] of lanes) {
      props[prop] = laneValueAt(lane, clamped, opts?.resolveEasing)
    }
  }

  /* clips on screen */
  const activeClips: ActiveClip[] = []
  for (const track of comp.tracks) {
    if (track.muted || (track.kind !== 'clip' && track.kind !== 'audio' && track.kind !== 'caption')) continue
    for (const clip of track.clips ?? []) {
      if (clip.muted) continue
      if (clamped >= clip.start && clamped < clip.start + clip.duration) {
        activeClips.push({ trackId: track.id, kind: track.kind, clip })
      }
    }
  }

  return { t: clamped, camera, elements, activeClips }
}
