/**
 * ADAPTER — Motion Studio contract, client side.
 *
 * These types and helpers mirror `shared/motion.ts` and the camera part of
 * `shared/motionRuntime.ts` from the `feat/motion-backend` branch (contract:
 * docs/motion-api.md). They live here only until that branch merges; then
 * this file should re-export from `../../../shared/motion` and
 * `../../../shared/motionRuntime` and the local copies below go away. Keep
 * every shape identical to the contract: the server validates what the
 * editor sends against the originals.
 */

export type MotionTrackKind = 'camera' | 'element' | 'clip' | 'audio' | 'caption'

export type MotionEasing =
  | { type: 'linear' }
  | { type: 'hold' }
  | { type: 'steps'; steps: number; position?: 'start' | 'end' }
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'spring'; stiffness: number; damping: number; mass: number }
  | { type: 'token'; name: string }

export interface MotionKeyframe {
  id: string
  property: string
  t: number
  value: number | string
  /** of the segment leaving this keyframe */
  easing: MotionEasing
}

export type MotionClipSource =
  | { type: 'frame'; frameId: string }
  | { type: 'library'; itemId: string; variantId?: string }
  | { type: 'asset'; assetId: string }
  | { type: 'caption'; text: string; style?: string }

export interface MotionClip {
  id: string
  start: number
  duration: number
  source: MotionClipSource
  name?: string
  mediaStart?: number
  gain?: number
  muted?: boolean
}

export interface MotionTrack {
  id: string
  kind: MotionTrackKind
  name?: string
  muted?: boolean
  frameId?: string
  elementId?: string
  keyframes?: MotionKeyframe[]
  clips?: MotionClip[]
}

export interface Composition {
  id: string
  canvasId: string
  pageId: string
  duration: number
  fps: number
  width: number
  height: number
  posterTime?: number
  tracks: MotionTrack[]
  revision: number
  createdAt: number
  updatedAt: number
  updatedBy: string
}

export type CameraProperty = 'x' | 'y' | 'zoom' | 'rotation'

export type CompositionOp =
  | { op: 'set_meta'; duration?: number; fps?: number; width?: number; height?: number; posterTime?: number }
  | { op: 'add_track'; track: MotionTrack }
  | { op: 'remove_track'; trackId: string }
  | { op: 'update_track'; trackId: string; name?: string; muted?: boolean }
  | { op: 'move_track'; trackId: string; index: number }
  | {
      op: 'set_camera'
      t: number
      x?: number
      y?: number
      zoom?: number
      rotation?: number
      easing?: MotionEasing
    }
  | { op: 'add_keyframe'; trackId: string; keyframe: MotionKeyframe }
  | {
      op: 'update_keyframe'
      trackId: string
      keyframeId: string
      t?: number
      value?: number | string
      easing?: MotionEasing
    }
  | { op: 'remove_keyframe'; trackId: string; keyframeId: string }
  | { op: 'add_clip'; trackId: string; clip: MotionClip }
  | { op: 'remove_clip'; trackId: string; clipId: string }

export type RenderFormat = 'mp4' | 'webm'
export type RenderTarget = 'browser' | 'desktop'
export type RenderStatus = 'queued' | 'rendering' | 'encoding' | 'done' | 'failed' | 'canceled'

export interface RenderJob {
  id: string
  canvasId: string
  pageId: string
  compositionId: string
  format: RenderFormat
  target: RenderTarget
  width: number
  height: number
  fps: number
  range: { start: number; end: number }
  status: RenderStatus
  progress: number
  outputAssetId?: string
  error?: string
  claimedBy?: string
  claimedAt?: number
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

/** the contract's defaults for a new film on a page */
export const NEW_COMPOSITION = { duration: 15, fps: 30, width: 1920, height: 1080 } as const
export const FPS_PRESETS = [24, 30, 60] as const

export interface CameraState {
  x: number
  y: number
  zoom: number
  rotation: number
}

/* ---- easing ---- */

/** the system curves a `token` easing may name (src/styles.css); anything
 *  else falls back to linear, as the contract says */
const TOKEN_BEZIERS: Record<string, [number, number, number, number]> = {
  '--ease-out': [0.22, 1, 0.36, 1],
  '--ease-in-out': [0.65, 0, 0.35, 1],
  '--ease-exit': [0.4, 0, 0.6, 1],
  'ease-out': [0.22, 1, 0.36, 1],
  'ease-in-out': [0.65, 0, 0.35, 1],
  'ease-exit': [0.4, 0, 0.6, 1],
}

function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  /* solve x(s) = x by Newton, then fall back to bisection */
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  let s = x
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(s) - x
    const d = (3 * ax * s + 2 * bx) * s + cx
    if (Math.abs(dx) < 1e-6) return sampleY(s)
    if (Math.abs(d) < 1e-6) break
    s -= dx / d
  }
  let lo = 0
  let hi = 1
  s = x
  for (let i = 0; i < 30; i++) {
    const v = sampleX(s)
    if (Math.abs(v - x) < 1e-6) break
    if (v < x) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return sampleY(s)
}

/** a damped spring from 0 to 1 over real seconds, in closed form */
function spring(stiffness: number, damping: number, mass: number, seconds: number): number {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * seconds) * (Math.cos(wd * seconds) + ((zeta * w0) / wd) * Math.sin(wd * seconds))
  }
  return 1 - Math.exp(-w0 * seconds) * (1 + w0 * seconds)
}

/** progress through a segment: `p` in [0, 1], `seconds` the time spent in it */
export function ease(easing: MotionEasing, p: number, seconds: number): number {
  switch (easing.type) {
    case 'linear':
      return p
    case 'hold':
      return 0
    case 'steps': {
      const n = Math.max(1, Math.round(easing.steps))
      return easing.position === 'start' ? Math.min(1, Math.ceil(p * n) / n) : Math.floor(p * n) / n
    }
    case 'cubic-bezier':
      return bezier(easing.x1, easing.y1, easing.x2, easing.y2, p)
    case 'spring':
      return p >= 1 ? 1 : spring(easing.stiffness, easing.damping, easing.mass, seconds)
    case 'token': {
      const curve = TOKEN_BEZIERS[easing.name]
      return curve ? bezier(curve[0], curve[1], curve[2], curve[3], p) : p
    }
  }
}

/** the value of one numeric lane at `t`: endpoints hold outside the keys */
export function laneAt(keys: MotionKeyframe[], t: number): number | undefined {
  const sorted = keys.filter((k) => typeof k.value === 'number').sort((a, b) => a.t - b.t)
  const first = sorted[0]
  if (!first) return undefined
  if (t <= first.t) return first.value as number
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a || !b || t >= b.t) continue
    const span = b.t - a.t
    const p = span > 0 ? (t - a.t) / span : 1
    const k = ease(a.easing, p, t - a.t)
    return (a.value as number) + ((b.value as number) - (a.value as number)) * k
  }
  return sorted[sorted.length - 1]?.value as number
}

export function cameraTrack(comp: Composition | null): MotionTrack | undefined {
  return comp?.tracks.find((track) => track.kind === 'camera' && !track.muted)
}

/** where the camera is at `t`, or null when the film has no camera keys */
export function cameraAt(comp: Composition, t: number): CameraState | null {
  const track = cameraTrack(comp)
  const keys = track?.keyframes ?? []
  if (keys.length === 0) return null
  const clamped = Math.min(Math.max(t, 0), comp.duration)
  const of = (prop: CameraProperty) =>
    laneAt(
      keys.filter((k) => k.property === prop),
      clamped,
    )
  const x = of('x')
  const y = of('y')
  if (x === undefined || y === undefined) return null
  return { x, y, zoom: of('zoom') ?? 1, rotation: of('rotation') ?? 0 }
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
