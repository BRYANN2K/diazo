/** shared/motionInterchange.ts — Lottie and HyperFrames import/export
 *  (phase 5). Both directions cover the same vector subset: transform
 *  keyframes on element tracks (x/y → position, scale* → scale, rotate →
 *  rotation, opacity → opacity). Anything a Lottie file carries beyond
 *  that subset — shapes, masks, mattes, expressions — is skipped on
 *  import, never invented. Both converters are pure and id-stable: a
 *  round trip keeps ids where the format has them. */

import type { Composition, MotionKeyframe, MotionTrack, MotionEasing } from './motion.ts'

/* ---- easing ↔ names --------------------------------------------------- */

function easingName(e: MotionEasing | undefined): string {
  if (!e) return 'linear'
  switch (e.type) {
    case 'linear':
      return 'linear'
    case 'hold':
      return 'hold'
    case 'steps':
      return `steps-${e.steps}`
    case 'cubic-bezier':
      return `cubic-bezier(${e.x1},${e.y1},${e.x2},${e.y2})`
    case 'spring':
      return `spring(${e.stiffness},${e.damping},${e.mass})`
    case 'token':
      return e.name
  }
}

function parseEasingName(name: unknown): MotionEasing {
  if (typeof name !== 'string') return { type: 'linear' }
  if (name === 'hold') return { type: 'hold' }
  if (name.startsWith('cubic-bezier(')) {
    const n = name.slice(13, -1).split(',').map(Number)
    if (n.length === 4 && n.every(Number.isFinite))
      return { type: 'cubic-bezier', x1: n[0]!, y1: n[1]!, x2: n[2]!, y2: n[3]! }
  }
  const steps = /^steps-(\d+)$/.exec(name)
  if (steps) return { type: 'steps', steps: +steps[1]! }
  return { type: 'linear' }
}

/* ============================== Lottie ================================== */

/** Lottie stores times in frames and opacity in percent. */
const LOTTIE_VERSION = '5.9.0'

interface LottieKeyframe {
  t: number
  s: number[]
  e?: number[]
}

function lottieProp(
  track: MotionTrack,
  prop: string,
  fps: number,
  to: (v: number | string) => number[],
): LottieKeyframe[] | undefined {
  const kfs = (track.keyframes ?? []).filter((k) => k.property === prop && typeof k.value === 'number')
  if (!kfs.length) return undefined
  return kfs.map((k) => ({ t: Math.round(k.t * fps), s: to(k.value) }))
}

/** A composition → a Lottie doc: one null-object layer per element track,
 *  its transform keyframes translated. Layers keep `frameId/elementId`
 *  in their name so an import can land on the same element. */
export function compositionToLottie(comp: Composition): Record<string, unknown> {
  const layers = comp.tracks
    .filter((t) => t.kind === 'element' && t.frameId && t.elementId)
    .map((t, i) => {
      const fr = comp.fps
      const ks: Record<string, unknown> = {}
      const x = lottieProp(t, 'x', fr, (v) => [Number(v)])
      const y = lottieProp(t, 'y', fr, (v) => [Number(v)])
      if (x || y) {
        const merged: LottieKeyframe[] = []
        const len = Math.max(x?.length ?? 0, y?.length ?? 0)
        for (let j = 0; j < len; j++) {
          const xv = x?.[Math.min(j, x.length - 1)]
          const yv = y?.[Math.min(j, y.length - 1)]
          merged.push({ t: (xv ?? yv)!.t, s: [xv?.s[0] ?? 0, yv?.s[0] ?? 0, 0] })
        }
        ks.p = { a: 1, k: merged }
      }
      const sx = lottieProp(t, 'scaleX', fr, (v) => [Number(v) * 100])
      const sy = lottieProp(t, 'scaleY', fr, (v) => [Number(v) * 100])
      const s = lottieProp(t, 'scale', fr, (v) => [Number(v) * 100])
      const scaleKeys = s ?? (sx || sy ? mergePair(sx, sy) : undefined)
      if (scaleKeys) ks.s = { a: 1, k: scaleKeys.map((k) => ({ ...k, s: [k.s[0], k.s[1] ?? k.s[0], 100] })) }
      const r = lottieProp(t, 'rotate', fr, (v) => [Number(v)])
      if (r) ks.r = { a: 1, k: r }
      const o = lottieProp(t, 'opacity', fr, (v) => [Number(v) * 100])
      if (o) ks.o = { a: 1, k: o }
      return {
        ddd: 0,
        ind: i + 1,
        ty: 3 /* null object: transform-only layer */,
        nm: `${t.frameId}/${t.elementId}`,
        ks,
        ip: 0,
        op: Math.round(comp.duration * fr),
        st: 0,
      }
    })
  return {
    v: LOTTIE_VERSION,
    fr: comp.fps,
    w: comp.width,
    h: comp.height,
    ip: 0,
    op: Math.round(comp.duration * comp.fps),
    layers,
    meta: { g: 'diazo', compositionId: comp.id },
  }
}

function mergePair(a?: LottieKeyframe[], b?: LottieKeyframe[]): LottieKeyframe[] {
  const len = Math.max(a?.length ?? 0, b?.length ?? 0)
  const out: LottieKeyframe[] = []
  for (let i = 0; i < len; i++) {
    const ka = a?.[Math.min(i, (a?.length ?? 1) - 1)]
    const kb = b?.[Math.min(i, (b?.length ?? 1) - 1)]
    out.push({ t: (ka ?? kb)!.t, s: [ka?.s[0] ?? 100, kb?.s[0] ?? ka?.s[0] ?? 100] })
  }
  return out
}

/** Lottie → a composition's element tracks. `nm` written by
 *  compositionToLottie carries `frameId/elementId` back; a foreign file's
 *  layers land on `lottie-<ind>` targets. Returns tracks for the caller to
 *  merge — it owns frame/element bindings. */
export function lottieToTracks(
  json: unknown,
  fps: number,
): { ok: true; tracks: MotionTrack[] } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not a lottie document' }
  const layers = (json as { layers?: unknown }).layers
  if (!Array.isArray(layers)) return { ok: false, error: 'a lottie document has a layers array' }
  const tracks: MotionTrack[] = []
  for (const [i, raw] of layers.entries()) {
    if (typeof raw !== 'object' || raw === null) continue
    const layer = raw as { nm?: unknown; ind?: unknown; ks?: Record<string, unknown> }
    const nm = typeof layer.nm === 'string' ? layer.nm : ''
    const [frameId, elementId] = nm.includes('/')
      ? (nm.split('/', 2) as [string, string])
      : [undefined, `lottie-${typeof layer.ind === 'number' ? layer.ind : i + 1}`]
    const keyframes: MotionKeyframe[] = []
    const ks = layer.ks ?? {}
    const push = (prop: string, k: LottieKeyframe, value: number) => {
      keyframes.push({
        id: `lt-${i}-${prop}-${keyframes.length}`,
        property: prop,
        t: k.t / fps,
        value,
        easing: { type: 'linear' },
      })
    }
    for (const k of lottieKeys(ks.p)) {
      push('x', k, k.s[0] ?? 0)
      push('y', k, k.s[1] ?? 0)
    }
    for (const k of lottieKeys(ks.s)) {
      push('scaleX', k, (k.s[0] ?? 100) / 100)
      push('scaleY', k, (k.s[1] ?? k.s[0] ?? 100) / 100)
    }
    for (const k of lottieKeys(ks.r)) push('rotate', k, k.s[0] ?? 0)
    for (const k of lottieKeys(ks.o)) push('opacity', k, (k.s[0] ?? 0) / 100)
    if (!keyframes.length) continue
    tracks.push({
      id: `lt-${i + 1}`,
      kind: 'element',
      ...(frameId ? { frameId } : {}),
      elementId: elementId!,
      keyframes,
    })
  }
  return { ok: true, tracks }
}

function lottieKeys(prop: unknown): LottieKeyframe[] {
  const k = (prop as { k?: unknown } | undefined)?.k
  if (!Array.isArray(k)) return []
  const out: LottieKeyframe[] = []
  for (const x of k) {
    if (typeof x !== 'object' || x === null) continue
    const kf = x as { t?: unknown; s?: unknown }
    if (typeof kf.t !== 'number') continue
    /* scalar properties keep s as a bare number on some exports */
    const s = Array.isArray(kf.s) ? kf.s : typeof kf.s === 'number' ? [kf.s] : undefined
    if (s) out.push({ t: kf.t, s })
  }
  return out
}

/* ============================ HyperFrames =============================== */

/** The interchange document: HyperFrames' project shape reduced to what
 *  the contract carries — fps, size, duration and per-layer keyframes. */
export const HYPERFRAMES_FORMAT = 'hyperframes-project'
export const HYPERFRAMES_VERSION = 1

export function compositionToHyperframes(comp: Composition): Record<string, unknown> {
  return {
    format: HYPERFRAMES_FORMAT,
    version: HYPERFRAMES_VERSION,
    scene: {
      fps: comp.fps,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      layers: comp.tracks.map((t) => ({
        id: t.id,
        name: t.name ?? `${t.kind}-${t.id}`,
        kind: t.kind,
        ...(t.frameId ? { frameId: t.frameId } : {}),
        ...(t.elementId ? { elementId: t.elementId } : {}),
        keyframes: (t.keyframes ?? []).map((k) => ({
          t: k.t,
          prop: k.property,
          v: k.value,
          ease: easingName(k.easing),
        })),
        clips: t.clips ?? [],
      })),
    },
  }
}

export function hyperframesToTracks(json: unknown): { ok: true; tracks: MotionTrack[] } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not a hyperframes document' }
  const doc = json as { format?: unknown; scene?: { layers?: unknown } }
  if (doc.format !== HYPERFRAMES_FORMAT) return { ok: false, error: `format must be ${HYPERFRAMES_FORMAT}` }
  const layers = doc.scene?.layers
  if (!Array.isArray(layers)) return { ok: false, error: 'a hyperframes document has scene.layers' }
  const tracks: MotionTrack[] = []
  for (const [i, raw] of layers.entries()) {
    if (typeof raw !== 'object' || raw === null) continue
    const layer = raw as {
      id?: unknown
      name?: unknown
      kind?: unknown
      frameId?: unknown
      elementId?: unknown
      keyframes?: unknown
    }
    const keyframes: MotionKeyframe[] = []
    if (Array.isArray(layer.keyframes)) {
      for (const [j, k] of layer.keyframes.entries()) {
        const kk = k as { t?: unknown; prop?: unknown; v?: unknown; ease?: unknown }
        if (
          typeof kk.t !== 'number' ||
          typeof kk.prop !== 'string' ||
          (typeof kk.v !== 'number' && typeof kk.v !== 'string')
        ) {
          return { ok: false, error: `layer ${i + 1} has a malformed keyframe` }
        }
        keyframes.push({
          id: `hf-${i}-${j}`,
          property: kk.prop,
          t: kk.t,
          value: kk.v,
          easing: parseEasingName(kk.ease),
        })
      }
    }
    tracks.push({
      id: typeof layer.id === 'string' && layer.id ? layer.id : `hf-${i + 1}`,
      kind: typeof layer.kind === 'string' ? (layer.kind as MotionTrack['kind']) : 'element',
      ...(typeof layer.name === 'string' ? { name: layer.name } : {}),
      ...(typeof layer.frameId === 'string' ? { frameId: layer.frameId } : {}),
      ...(typeof layer.elementId === 'string' ? { elementId: layer.elementId } : {}),
      ...(keyframes.length ? { keyframes } : {}),
    })
  }
  return { ok: true, tracks }
}
