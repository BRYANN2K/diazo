/**
 * shared/motionPresets.ts — named camera moves (proposal 14.3, the
 * Higgsfield idea done with keyframes). A preset is a recipe relative to a
 * camera state — usually `fitCameraToFrame` of the shot's frame — so it
 * survives a resize, and every value it writes stays an ordinary editable
 * keyframe afterwards. Deterministic: `handheld` jitters from a seed.
 */

import { newMotionId, type MotionEasing, type MotionKeyframe, type StoryboardFrame } from './motion.ts'
import type { CameraState } from './motionRuntime.ts'

export const CAMERA_PRESETS = [
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'whip-pan',
  'crash-zoom',
  'crane-up',
  'crane-down',
  'handheld',
  'dolly-zoom',
  'orbit',
] as const
export type CameraPreset = (typeof CAMERA_PRESETS)[number]

export function isCameraPreset(v: unknown): v is CameraPreset {
  return typeof v === 'string' && (CAMERA_PRESETS as readonly string[]).includes(v)
}

/** mulberry32 — small seeded PRNG; same seed, same jitter on every render */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CameraPresetOptions {
  /** seconds on the composition clock the move starts at */
  t: number
  /** seconds the move takes */
  duration: number
  /** camera state at t — usually `fitCameraToFrame(frame, w, h)` of the shot */
  from: CameraState
  /** the shot's frame rect — pans and cranes travel a fraction of it; when
   *  absent they travel the preset's amount in zoom/view terms instead */
  frame?: StoryboardFrame
  /** preset magnitude: zoom factor for push/pull/crash/dolly (defaults per
   *  preset), fraction of the frame for pans/cranes (default 0.5), px
   *  amplitude for handheld (default 6), degrees for orbit (default 360) */
  amount?: number
  /** jitter seed for handheld (default 1) and its frequency in Hz (default 2) */
  seed?: number
  frequency?: number
  /** overrides the preset's default curve */
  easing?: MotionEasing
}

const kf = (property: string, t: number, value: number, easing: MotionEasing): MotionKeyframe => ({
  id: newMotionId(),
  property,
  t,
  value,
  easing,
})

const LINEAR: MotionEasing = { type: 'linear' }
const EASE: MotionEasing = { type: 'cubic-bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }
const EASE_IN_OUT: MotionEasing = { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
const WHIP: MotionEasing = { type: 'cubic-bezier', x1: 0.7, y1: 0, x2: 0.3, y2: 1 }
const CRASH: MotionEasing = { type: 'cubic-bezier', x1: 0.8, y1: 0, x2: 0.2, y2: 1 }
const DOLLY: MotionEasing = { type: 'cubic-bezier', x1: 0.5, y1: 0, x2: 0.9, y2: 0.5 }

/**
 * The camera keyframes a preset writes. Four lanes (x, y, zoom, rotation) —
 * presets that don't move a lane still write its endpoint so the pose is
 * fully pinned at both ends. Defaults make every preset do something sane
 * with only `t`, `duration` and `from`.
 */
export function cameraPreset(preset: CameraPreset, opts: CameraPresetOptions): MotionKeyframe[] {
  const { t, duration, from } = opts
  const end = t + duration
  const amount = opts.amount
  const ease = opts.easing
  const out: MotionKeyframe[] = []

  /* helper: one keyframe per lane at `at`, sharing the eased segment that
     leaves it */
  const pose = (at: number, state: CameraState, easing: MotionEasing) => {
    for (const prop of ['x', 'y', 'zoom', 'rotation'] as const) {
      out.push(kf(prop, at, state[prop], easing))
    }
  }

  switch (preset) {
    case 'push-in': {
      const z = amount ?? 1.2
      pose(t, from, ease ?? EASE)
      pose(end, { ...from, zoom: from.zoom * z }, ease ?? EASE)
      break
    }
    case 'pull-out': {
      const z = amount ?? 1.2
      pose(t, { ...from, zoom: from.zoom * z }, ease ?? EASE)
      pose(end, from, ease ?? EASE)
      break
    }
    case 'pan-left':
    case 'pan-right':
    case 'pan-up':
    case 'pan-down': {
      /* a pan travels `amount` of the frame (default half); with no frame it
         travels `amount` view-widths/height at the current zoom */
      const f = amount ?? 0.5
      const dist = opts.frame
        ? f * (preset.startsWith('pan-l') || preset.startsWith('pan-r') ? opts.frame.width : opts.frame.height)
        : f * 400
      const sign = preset === 'pan-left' || preset === 'pan-up' ? -1 : 1
      const horizontal = preset === 'pan-left' || preset === 'pan-right'
      const to = { ...from, ...(horizontal ? { x: from.x + sign * dist } : { y: from.y + sign * dist }) }
      pose(t, from, ease ?? LINEAR)
      pose(end, to, ease ?? LINEAR)
      break
    }
    case 'whip-pan': {
      /* a whole-frame-width pan on a fast curve; the editor pairs it with a
         blur bump on the world wrapper for the middle third */
      const dist = opts.frame ? opts.frame.width : (amount ?? 400)
      pose(t, from, ease ?? WHIP)
      pose(end, { ...from, x: from.x + dist }, ease ?? WHIP)
      break
    }
    case 'crash-zoom': {
      /* hold, then punch: 60% of the duration still, then a hard zoom to
         `amount` (default 2x) — the crash */
      const z = amount ?? 2
      pose(t, from, { type: 'hold' })
      pose(t + duration * 0.6, from, ease ?? CRASH)
      pose(end, { ...from, zoom: from.zoom * z }, ease ?? CRASH)
      break
    }
    case 'crane-up':
    case 'crane-down': {
      const f = amount ?? 0.4
      const rise = (opts.frame ? f * opts.frame.height : f * 300) * (preset === 'crane-up' ? -1 : 1)
      pose(t, from, ease ?? EASE_IN_OUT)
      pose(end, { ...from, y: from.y + rise, zoom: from.zoom * 1.06 }, ease ?? EASE_IN_OUT)
      break
    }
    case 'handheld': {
      /* seeded jitter at `frequency` Hz, ±amplitude px on x and y — same
         seed, same shake at every seek */
      const amp = amount ?? 6
      const hz = opts.frequency ?? 2
      const rng = seededRandom(opts.seed ?? 1)
      const steps = Math.max(2, Math.min(600, Math.ceil(duration * hz) + 1))
      for (let i = 0; i < steps; i++) {
        const at = t + (duration * i) / (steps - 1)
        const last = i === steps - 1
        pose(
          at,
          { ...from, x: from.x + (rng() - 0.5) * 2 * amp, y: from.y + (rng() - 0.5) * 2 * amp },
          last ? (ease ?? LINEAR) : LINEAR,
        )
      }
      break
    }
    case 'dolly-zoom': {
      /* in 2D a dolly zoom is a strong zoom on a slow-then-fast curve — the
         perspective counter-move only exists on 3d layers, where the same
         keyframes read as dolly + counter-zoom */
      const z = amount ?? 1.6
      pose(t, from, ease ?? DOLLY)
      pose(end, { ...from, zoom: from.zoom * z }, ease ?? DOLLY)
      break
    }
    case 'orbit': {
      /* a rotation sweep; on a 3d layer the 3D runtime reads camera.rotation
         as the orbit angle around the scene */
      const deg = amount ?? 360
      pose(t, from, ease ?? EASE_IN_OUT)
      pose(end, { ...from, rotation: from.rotation + deg }, ease ?? EASE_IN_OUT)
      break
    }
  }
  return out
}

/**
 * Human-readable line the UI shows under the preset picker — which curve it
 * uses by default and what `amount` means.
 */
export function cameraPresetNote(preset: CameraPreset): string {
  switch (preset) {
    case 'push-in':
      return 'zooms toward the shot (amount = zoom factor, 1.2 default)'
    case 'pull-out':
      return 'starts close and settles to the shot (amount = start zoom factor)'
    case 'pan-left':
    case 'pan-right':
    case 'pan-up':
    case 'pan-down':
      return 'slides the view a fraction of the frame (amount = fraction, 0.5 default)'
    case 'whip-pan':
      return 'one fast frame-width pan — pair a blur bump for the middle third'
    case 'crash-zoom':
      return 'holds, then crashes to amount× zoom (default 2)'
    case 'crane-up':
    case 'crane-down':
      return 'rises or sinks by a fraction of the frame with a slight dolly out'
    case 'handheld':
      return 'seeded ±amount px jitter at frequency Hz — deterministic per seed'
    case 'dolly-zoom':
      return 'a strong slow-then-fast zoom; on 3d layers it is the real counter-zoom'
    case 'orbit':
      return 'a rotation sweep — meant for 3d layers where rotation orbits the scene'
  }
}
