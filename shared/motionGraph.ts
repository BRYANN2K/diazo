/**
 * shared/motionGraph.ts — the graph editor's data model (motion-pro P1).
 * The timeline stores keyframes with easings; the graph editor reads and
 * writes the same data through curve lanes: value graphs (property over
 * time) and speed graphs (rate over time, the Bezier-handle view AE shows).
 *
 * Nothing here changes the wire format — a `MotionEasing` stays the
 * contract; these helpers derive editor concepts from it and back:
 *   - in/out Bezier handles per keyframe segment
 *   - speed-graph sampling of a segment
 *   - spring/overshoot presets as easing values
 *   - copy/paste of easings across lanes
 *   - lane selection + solo state for the editor UI
 *
 * A speed graph is derived, never stored: speed(t) = d(value)/d(time),
 * sampled from the same evaluator the runtime uses — what you see is what
 * seeks.
 */

import { type CompositionOp, type MotionEasing, type MotionKeyframe, type MotionTrack } from './motion.ts'
import { laneValueAt } from './motionRuntime.ts'

/* ---- segments and handles ---- */

/** one lane's segment between two keyframes, in the editor's terms */
export interface GraphSegment {
  trackId: string
  property: string
  /** the two keyframes bounding it */
  from: MotionKeyframe
  to: MotionKeyframe
  /** seconds the segment spans */
  duration: number
  /** the outgoing handle the `from` keyframe holds — cubic-bezier easings
   *  map to (x1,y1) out / (x2,y2) in; other easings have none */
  outHandle?: { x: number; y: number }
  inHandle?: { x: number; y: number }
}

/** the lanes a track exposes to the graph editor — every property with at
 *  least one numeric keyframe, camera lanes included */
export function trackLanes(track: MotionTrack): string[] {
  const seen = new Set<string>()
  for (const kf of track.keyframes ?? []) {
    if (typeof kf.value === 'number') seen.add(kf.property)
  }
  return [...seen].sort()
}

/** the segments of one property lane, in time order */
export function laneSegments(track: MotionTrack, property: string): GraphSegment[] {
  const lane = (track.keyframes ?? []).filter((k) => k.property === property).sort((a, b) => a.t - b.t)
  const out: GraphSegment[] = []
  for (let i = 0; i + 1 < lane.length; i++) {
    const from = lane[i]!
    const to = lane[i + 1]!
    const seg: GraphSegment = {
      trackId: track.id,
      property,
      from,
      to,
      duration: to.t - from.t,
    }
    if (from.easing?.type === 'cubic-bezier') {
      seg.outHandle = { x: from.easing.x1, y: from.easing.y1 }
      seg.inHandle = { x: from.easing.x2, y: from.easing.y2 }
    }
    out.push(seg)
  }
  return out
}

/* ---- speed graph (derived) ---- */

/** a sampled point of the speed graph: seconds → value-per-second */
export interface SpeedPoint {
  t: number
  /** normalized 0..1 progress through the segment */
  u: number
  /** dValue/dt in the property's units per second */
  speed: number
}

/** Sample a segment's speed curve. `hold`/`steps` read as stepped speed
 *  (0 then a spike at the step instant — represented as the discrete jump);
 *  springs and beziers give the smooth derivative of the evaluated value. */
export function speedGraph(from: MotionKeyframe, to: MotionKeyframe, samples = 32): SpeedPoint[] {
  if (to.t <= from.t || typeof from.value !== 'number' || typeof to.value !== 'number') return []
  const lane = [from, to]
  const dt = to.t - from.t
  const out: SpeedPoint[] = []
  const n = Math.max(2, samples)
  const evalAt = (t: number) => {
    const v = laneValueAt(lane, t)
    return typeof v === 'number' ? v : 0
  }
  const h = Math.min(dt / (n - 1), dt / 8) / 2
  for (let i = 0; i < n; i++) {
    const t = from.t + (dt * i) / (n - 1)
    const lo = Math.max(from.t, t - h)
    const hi = Math.min(to.t, t + h)
    const speed = hi > lo ? (evalAt(hi) - evalAt(lo)) / (hi - lo) : 0
    out.push({ t, u: (t - from.t) / dt, speed })
  }
  return out
}

/* ---- handle edits → easings ---- */

/** write a pair of Bezier handles back as the `from` keyframe's easing —
 *  the op the graph editor sends on a drag */
export function handlesToEasing(outHandle: { x: number; y: number }, inHandle: { x: number; y: number }): MotionEasing {
  return {
    type: 'cubic-bezier',
    x1: Math.min(1, Math.max(0, outHandle.x)),
    y1: outHandle.y,
    x2: Math.min(1, Math.max(0, inHandle.x)),
    y2: inHandle.y,
  }
}

/* ---- named curve presets (springs and overshoots) ---- */

export const CURVE_PRESETS = [
  'ease-out-quint',
  'ease-in-out-quad',
  'spring-soft',
  'spring-snappy',
  'overshoot-pop',
  'anticipate',
] as const
export type CurvePreset = (typeof CURVE_PRESETS)[number]

export function curveEasing(preset: CurvePreset): MotionEasing {
  switch (preset) {
    case 'ease-out-quint':
      return { type: 'cubic-bezier', x1: 0.22, y1: 1, x2: 0.36, y2: 1 }
    case 'ease-in-out-quad':
      return { type: 'cubic-bezier', x1: 0.45, y1: 0, x2: 0.55, y2: 1 }
    case 'spring-soft':
      return { type: 'spring', stiffness: 120, damping: 18, mass: 1 }
    case 'spring-snappy':
      return { type: 'spring', stiffness: 320, damping: 22, mass: 1 }
    case 'overshoot-pop':
      return { type: 'spring', stiffness: 400, damping: 14, mass: 1 }
    case 'anticipate':
      /* dips before it goes: a bezier whose in-handle drops below 0 */
      return { type: 'cubic-bezier', x1: 0.36, y1: -0.28, x2: 0.3, y2: 1 }
  }
}

/* ---- easing copy/paste across lanes ---- */

/** the easings one keyframe carries — a copy's payload */
export function copyEasing(kf: MotionKeyframe): MotionEasing | undefined {
  return kf.easing ? { ...kf.easing } : undefined
}

/** paste an easing onto keyframes: the `update_keyframe` ops to send */
export function pasteEasing(
  easing: MotionEasing,
  targets: readonly { trackId: string; keyframeId: string }[],
): CompositionOp[] {
  return targets.map((t) => ({ op: 'update_keyframe', trackId: t.trackId, keyframeId: t.keyframeId, easing }))
}

/* ---- lane selection + solo (editor UI state — never persisted) ---- */

export interface LaneSelection {
  /** property lanes the editor shows, per track — absent = all */
  selected?: ReadonlyMap<string, ReadonlySet<string>>
  /** solo lanes: when non-empty, everything else dims */
  solo?: ReadonlyMap<string, ReadonlySet<string>>
}

/** is this lane editable right now under the selection */
export function laneActive(selection: LaneSelection | undefined, trackId: string, property: string): boolean {
  if (!selection) return true
  const solo = selection.solo?.get(trackId)
  if (solo && solo.size > 0) return solo.has(property)
  const anySolo = [...(selection.solo?.values() ?? [])].some((s) => s.size > 0)
  if (anySolo) return false
  const sel = selection.selected?.get(trackId)
  return !sel || sel.size === 0 || sel.has(property)
}
