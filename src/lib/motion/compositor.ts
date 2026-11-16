import type { Frame } from '../../../shared/types'
import { rasterizeFrame, rasterizeHtml } from '../frameRaster'
import { frameStateAt, resolveEasing, type CameraState, type Composition } from './contract'
import { frameMotionCss } from './elementCss'

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
  frames: { frame: Frame; image: ImageBitmap; moving: boolean; scale: number }[]
  /** the camera when the film has no camera keys: the whole page in view */
  fallback: CameraState
  ground: string
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
      const moving = tracked.has(frame.id) || isScene(frame.html)
      drawn.push({ frame, image: await createImageBitmap(blob), moving, scale })
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

/** Paint the film at `t` onto `ctx`, sized `comp.width × comp.height`. */
export async function paintAt(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
  stage: FilmStage,
  t: number,
  signal?: AbortSignal,
): Promise<void> {
  const state = frameStateAt(comp, t, { resolveEasing })
  /* the moving frames are drawn again first, so the paint below is one pass */
  const images = await Promise.all(
    stage.frames.map(async (entry) => {
      if (!entry.moving) return entry.image
      try {
        const blob = await rasterizeHtml(
          htmlAt(entry.frame.html, frameMotionCss(state, entry.frame.id), state.t),
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
}
