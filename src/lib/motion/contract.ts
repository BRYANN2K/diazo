/**
 * Motion Studio's contract on the client: the types, parsers and runtime of
 * `shared/motion.ts` and `shared/motionRuntime.ts` (docs/motion-api.md),
 * plus the few helpers the timeline UI adds on top of them.
 */
import {
  parseEasingToken,
  NAMED_EASINGS,
  type Composition,
  type MotionEasing,
  type MotionKeyframe,
} from '../../../shared/motion'
import { easingProgress, frameStateAt, laneValueAt, type CameraState } from '../../../shared/motionRuntime'

export type {
  CameraProperty,
  Composition,
  CompositionOp,
  MotionClip,
  MotionClipSource,
  MotionEasing,
  MotionKeyframe,
  MotionTrack,
  MotionTrackKind,
  RenderFormat,
  RenderJob,
  RenderStatus,
  RenderTarget,
} from '../../../shared/motion'
export type { CameraState, CompositionStateAt } from '../../../shared/motionRuntime'
export { frameStateAt } from '../../../shared/motionRuntime'
export { elementKey, newMotionId, ELEMENT_PROPERTIES } from '../../../shared/motion'

/** the defaults for a new film on a page */
export const NEW_COMPOSITION = { duration: 15, fps: 30, width: 1920, height: 1080 } as const
export const FPS_PRESETS = [24, 30, 60] as const

/**
 * Resolves `token` easings against the page's motion tokens (the CSS custom
 * properties `--ease-*` / `--spring-*` in src/styles.css), as the contract
 * says; anything unresolved falls back to linear in the runtime.
 */
export function resolveEasing(name: string): MotionEasing | undefined {
  const named = NAMED_EASINGS[name]
  if (named) return named
  if (typeof document === 'undefined') return undefined
  const prop = name.startsWith('--') ? name : `--${name}`
  const value = getComputedStyle(document.documentElement).getPropertyValue(prop).trim()
  return value ? (parseEasingToken(value) ?? undefined) : undefined
}

/** progress through a segment (the runtime's easing, tokens resolved) */
export function ease(easing: MotionEasing, p: number, seconds: number): number {
  if (easing.type === 'token') {
    const resolved = resolveEasing(easing.name)
    return resolved ? easingProgress(resolved, p, seconds) : p
  }
  return easingProgress(easing, p, seconds)
}

/** one numeric lane at `t`; undefined when it has no keys */
export function laneAt(keys: MotionKeyframe[], t: number): number | undefined {
  if (keys.length === 0) return undefined
  const value = laneValueAt(keys, t, resolveEasing)
  return typeof value === 'number' ? value : undefined
}

export function cameraTrack(comp: Composition | null) {
  return comp?.tracks.find((track) => track.kind === 'camera' && !track.muted)
}

/** where the camera is at `t`, or null when the film has no camera keys */
export function cameraAt(comp: Composition, t: number): CameraState | null {
  return frameStateAt(comp, t, { resolveEasing }).camera
}

/** every distinct time a camera key sits at, for the diamonds on the lane */
export function cameraKeyTimes(comp: Composition | null): number[] {
  const keys = cameraTrack(comp)?.keyframes ?? []
  return [...new Set(keys.map((k) => Math.round(k.t * 1000) / 1000))].sort((a, b) => a - b)
}

/** mm:ss.ff at the film's rate */
export function timecode(t: number, fps: number): string {
  const safe = Math.max(0, t)
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const frames = Math.floor((safe - Math.floor(safe)) * fps)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(frames).padStart(2, '0')}`
}
