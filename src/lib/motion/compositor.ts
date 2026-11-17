import type { Frame } from '../../../shared/types'
import { rasterizeFrame, rasterizeHtml } from '../frameRaster'
import { frameStateAt, resolveEasing, type CameraState, type Composition } from './contract'
import { keyframeLanes, laneValueAt } from '../../../shared/motionRuntime'
import { effectParamsAt, enabledEffects } from '../../../shared/motionFx'
import type { EffectInstance } from '../../../shared/motion'
import { fxGl, supportedStack } from './gl'
import { frameMotionCss } from './elementCss'
import { elementText, expandTextAnimator, splitUnitsForFrame } from '../../../shared/motionText'
import { MOTION_BLOCK_ATTR, parseMotionBlock, type FrameMotionKeyframe, type TextSplit } from '../../../shared/motion'

/**
 * Draws a film at any time `t` onto a 2D canvas: the page's frames seen
 * through the composition's camera (shared/motionRuntime.ts). It is a pure
 * function of `t` — no clock of its own — so the browser render, the desktop
 * harness and a scrub all get the same picture, the seek-safe rule of
 * docs/motion-api.md applied to the editor's own output.
 *
 * A still frame is rasterised once. A frame that moves — an element track
 * touches it, or its markup is a seek-safe scene reading `--t` — is drawn
 * again at each time from its saved HTML with the track values and `--t`
 * written in, so its own seek-safe animations step with the film.
 */
export interface FilmStage {
  frames: {
    frame: Frame
    image: ImageBitmap
    moving: boolean
    scale: number
    /** frame-authored keyframes incl. expanded text animators */
    motionKfs: FrameMotionKeyframe[]
    /** elements the animators split → data-doop-unit spans at draw time */
    unitEls: Map<string, TextSplit>
  }[]
  /** the camera when the film has no camera keys: the whole page in view */
  fallback: CameraState
  ground: string
}

const MOTION_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/** the frame's data-doop-motion block: its keyframes, its animators folded
 *  to unit keyframes, and the elements the raster split must wrap */
function frameMotion(html: string): { motionKfs: FrameMotionKeyframe[]; unitEls: Map<string, TextSplit> } {
  const motionKfs: FrameMotionKeyframe[] = []
  const unitEls = new Map<string, TextSplit>()
  for (const m of html.matchAll(MOTION_SCRIPT_RE)) {
    if (!(m[1] ?? '').includes(MOTION_BLOCK_ATTR)) continue
    const block = parseMotionBlock(m[2] ?? '')
    if (!block) continue
    motionKfs.push(...block.keyframes)
    for (const animator of block.animators ?? []) {
      const text = elementText(html, animator.el)
      if (text === undefined) continue
      motionKfs.push(...expandTextAnimator(animator, text).keyframes)
      unitEls.set(animator.el, animator.split)
    }
  }
  return { motionKfs, unitEls }
}

/** the camera that fits every frame of the page in a `width × height` shot */
export function fitCamera(frames: Frame[], width: number, height: number, margin = 1.08): CameraState {
  if (frames.length === 0) return { x: 0, y: 0, zoom: 1, rotation: 0 }
  const minX = Math.min(...frames.map((f) => f.x))
  const minY = Math.min(...frames.map((f) => f.y))
  const maxX = Math.max(...frames.map((f) => f.x + f.width))
  const maxY = Math.max(...frames.map((f) => f.y + f.height))
  const zoom = Math.min(width / ((maxX - minX) * margin), height / ((maxY - minY) * margin))
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, rotation: 0 }
}

/** a frame whose own markup animates on the film's clock */
export function isScene(html: string): boolean {
  return html.includes('data-doop-scene') || html.includes('var(--t')
}

/** the frame's HTML with the film's CSS for this instant written in */
export function htmlAt(html: string, css: string, t: number): string {
  const style = `<style data-doop-motion>:root{--t:${t}}\n${css}</style>`
  const head = html.search(/<\/head>/i)
  return head >= 0 ? html.slice(0, head) + style + html.slice(head) : style + html
}

/** Rasterise each frame once, at a density that keeps the closest shot sharp. */
export async function prepareStage(
  comp: Composition,
  frames: Frame[],
  opts: { signal?: AbortSignal; ground: string; onFrame?: (done: number, total: number) => void },
): Promise<FilmStage> {
  const zooms = (comp.tracks.find((t) => t.kind === 'camera')?.keyframes ?? [])
    .filter((k) => k.property === 'zoom' && typeof k.value === 'number')
    .map((k) => k.value as number)
  const scale = Math.min(2, Math.max(1, ...zooms))
  const tracked = new Set(
    comp.tracks.filter((t) => t.kind === 'element' && !t.muted && t.frameId).map((t) => t.frameId as string),
  )
  const drawn: FilmStage['frames'] = []
  let done = 0
  for (const frame of frames) {
    try {
      const blob = await rasterizeFrame(frame, { scale, type: 'png', signal: opts.signal })
      const motion = frameMotion(frame.html)
      const moving = tracked.has(frame.id) || isScene(frame.html) || motion.motionKfs.length > 0
      drawn.push({ frame, image: await createImageBitmap(blob), moving, scale, ...motion })
    } catch (err) {
      /* a frame the browser cannot draw (a tainted canvas, a blocked image)
         is left out rather than failing the whole film */
      console.warn('motion: frame left out of the render', frame.id, err)
    }
    done += 1
    opts.onFrame?.(done, frames.length)
  }
  return { frames: drawn, fallback: fitCamera(frames, comp.width, comp.height), ground: opts.ground }
}

/** an effect the paint could not draw, with the reason — the render and
 *  check surfaces report them so an effect never drops silently */
export interface FxDrop {
  fx: string
  reason: 'no WebGL2 context' | 'no shader in this build' | 'effect pass failed'
}

/** Paint the film at `t` onto `ctx`, sized `comp.width × comp.height`.
 *  Returns the scene effects that could not be drawn (empty when every
 *  effect landed or the stack was empty). `fxScale` is the ratio the film
 *  was scaled by to reach `comp`'s size (job size ÷ authored size), so the
 *  pixel-unit effect params follow the render instead of staying in
 *  composition pixels. */
export async function paintAt(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
  stage: FilmStage,
  t: number,
  signal?: AbortSignal,
  fxScale = 1,
): Promise<FxDrop[]> {
  const frameBlocks = new Map<string, readonly FrameMotionKeyframe[]>()
  for (const entry of stage.frames) if (entry.motionKfs.length > 0) frameBlocks.set(entry.frame.id, entry.motionKfs)
  const state = frameStateAt(comp, t, { resolveEasing, frameBlocks })
  /* the moving frames are drawn again first, so the paint below is one pass */
  const images = await Promise.all(
    stage.frames.map(async (entry) => {
      if (!entry.moving) return entry.image
      try {
        const splitHtml =
          entry.unitEls.size > 0 ? splitUnitsForFrame(entry.frame.html, entry.unitEls) : entry.frame.html
        const blob = await rasterizeHtml(
          htmlAt(splitHtml, frameMotionCss(state, entry.frame.id), state.t),
          { width: entry.frame.width, height: entry.frame.height },
          { scale: entry.scale, type: 'png', signal },
        )
        return await createImageBitmap(blob)
      } catch {
        return entry.image
      }
    }),
  )
  const camera = state.camera ?? stage.fallback
  const { width, height } = comp
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = stage.ground
  ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2)
  ctx.rotate((-camera.rotation * Math.PI) / 180)
  ctx.scale(camera.zoom, camera.zoom)
  ctx.translate(-camera.x, -camera.y)
  ctx.imageSmoothingQuality = 'high'
  stage.frames.forEach(({ frame }, i) => {
    const image = images[i]
    if (!image) return
    if (frame.rotation) {
      ctx.save()
      ctx.translate(frame.x + frame.width / 2, frame.y + frame.height / 2)
      ctx.rotate((frame.rotation * Math.PI) / 180)
      ctx.drawImage(image, -frame.width / 2, -frame.height / 2, frame.width, frame.height)
      ctx.restore()
    } else {
      ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height)
    }
  })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return paintSceneFx(ctx, comp, t, fxScale)
}

/** the stack the whole scene sees at t: the camera track's effects, plus each
 *  adjustment track whose clip window covers t. Element-track stacks draw in
 *  the browser via elementCss filters — the raster/GL scene pass does not
 *  carry them (check_scene reports them as the layer-level stack they are). */
function sceneStackAt(
  comp: Composition,
  t: number,
): (EffectInstance & { paramsAt?: Record<string, number | string | boolean> })[] {
  const out: (EffectInstance & { paramsAt?: Record<string, number | string | boolean> })[] = []
  for (const track of comp.tracks) {
    if (track.muted) continue
    const isCamera = track.kind === 'camera'
    const isAdjustment = track.kind === 'adjustment'
    if (!isCamera && !isAdjustment) continue
    if (isAdjustment) {
      const covered = (track.clips ?? []).some(
        (clip) => clip.source.type === 'adjustment' && t >= clip.start && t < clip.start + clip.duration,
      )
      if (!covered) continue
    }
    const lanes = keyframeLanes(track.keyframes ?? [])
    const resolved: Record<string, number | string> = {}
    for (const [prop, kfs] of lanes) {
      if (!prop.startsWith('fx:')) continue
      const v = laneValueAt(kfs, t, resolveEasing)
      resolved[prop.slice(3)] = v
    }
    for (const fx of enabledEffects(track)) {
      out.push({ ...fx, paramsAt: effectParamsAt(fx, resolved) })
    }
  }
  return out
}

/** draw the scene-level stack through the WebGL2 pass and say what could
 *  not be drawn: an effect with no GLSL body, a missing GL context, or a
 *  failed pass — the pixels stay as the 2D pass left them and the caller
 *  reports the gap instead of shipping a film without its look */
function paintSceneFx(ctx: CanvasRenderingContext2D, comp: Composition, t: number, fxScale: number): FxDrop[] {
  const stack = sceneStackAt(comp, t)
  if (stack.length === 0) return []
  const { ok, unsupported } = supportedStack(stack)
  const drops: FxDrop[] = unsupported.map((e) => ({ fx: e.fx, reason: 'no shader in this build' }))
  if (ok.length === 0) return drops
  const gl = fxGl()
  if (!gl) return [...drops, ...ok.map((e) => ({ fx: e.fx, reason: 'no WebGL2 context' as const }))]
  const out = gl.apply(ctx.canvas, comp.width, comp.height, ok, t, comp.fps, fxScale)
  if (!out) return [...drops, ...ok.map((e) => ({ fx: e.fx, reason: 'effect pass failed' as const }))]
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, comp.width, comp.height)
  ctx.drawImage(out.canvas, 0, 0)
  /* a program that failed to build (missing or uncompilable body) is a drop
     too — the pixels stayed as the 2D pass left them and the caller reports it */
  return [...drops, ...out.failed.map((fx) => ({ fx, reason: 'effect pass failed' as const }))]
}

/* the shutter cost bound: each sample re-rasterises the moving frames, so
   a blurred frame costs K paints — over ~16 samples the gain is invisible,
   the render bill is not */
const MAX_SHUTTER_SAMPLES = 16

/** `paintAt` with the filmic shutter: when the composition carries
 *  `motionBlur`, the frame is the mean of K seeks spread across the shutter
 *  window — `t - shutter/2` to `t + shutter/2` of one frame interval. The
 *  accumulation runs in float (getImageData summed into a Float32Array and
 *  divided once), so static pixels come out bit-identical to a hard shutter
 *  instead of drifting on 8-bit 'lighter' rounding. Still one deterministic
 *  function of (comp, t): no accumulation across calls, same samples every
 *  time. shutter 0 (or unset) is the hard shutter. Returns the union of the
 *  sub-seeks' undrawn effects. */
export async function paintShutter(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
  stage: FilmStage,
  t: number,
  signal?: AbortSignal,
  fxScale = 1,
): Promise<FxDrop[]> {
  const mb = comp.motionBlur
  const shutter = mb && Number.isFinite(mb.shutter) ? Math.min(Math.max(mb.shutter, 0), 360) : 0
  if (shutter <= 0) {
    return paintAt(ctx, comp, stage, t, signal, fxScale)
  }
  const K = Math.min(Math.max(Math.round(mb?.samples ?? 8), 2), MAX_SHUTTER_SAMPLES)
  const window = (shutter / 360) * (1 / comp.fps)
  const off = document.createElement('canvas')
  off.width = comp.width
  off.height = comp.height
  const offCtx = off.getContext('2d')
  if (!offCtx) {
    return paintAt(ctx, comp, stage, t, signal, fxScale)
  }
  const pixels = comp.width * comp.height * 4
  const acc = new Float32Array(pixels)
  const drops = new Map<string, FxDrop>()
  for (let k = 0; k < K; k++) {
    const sub = t - window / 2 + (window * (k + 0.5)) / K
    offCtx.setTransform(1, 0, 0, 1, 0, 0)
    offCtx.clearRect(0, 0, comp.width, comp.height)
    for (const d of await paintAt(offCtx, comp, stage, sub, signal, fxScale)) drops.set(`${d.fx}:${d.reason}`, d)
    if (signal?.aborted) break
    const data = offCtx.getImageData(0, 0, comp.width, comp.height).data
    for (let i = 0; i < pixels; i++) acc[i]! += data[i]!
  }
  /* the sum is exact — float32 holds uint8 × 16 without rounding, so the
     divide is the only rounding step and it lands where the mean does */
  const mean = new Uint8ClampedArray(pixels)
  for (let i = 0; i < pixels; i++) mean[i] = acc[i]! / K
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(new ImageData(mean, comp.width, comp.height), 0, 0)
  return [...drops.values()]
}
