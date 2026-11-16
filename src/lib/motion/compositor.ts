import type { Frame } from '../../../shared/types'
import { rasterizeFrame } from '../frameRaster'
import { cameraAt, type CameraState, type Composition } from './contract'

/**
 * Draws a film at any time `t` onto a 2D canvas: the page's frames, each
 * rasterised once, seen through the composition's camera. It is a pure
 * function of `t` (no clock of its own), so the browser render, the desktop
 * harness and a scrub all ask it for exactly the same picture — the
 * seek-safe rule of docs/motion-api.md, applied to the editor's own output.
 *
 * MVP scope: frames are still pictures (their markup's own animations are not
 * stepped per frame yet) and element tracks are not applied; the camera is.
 */
export interface FilmStage {
  frames: { frame: Frame; image: ImageBitmap }[]
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
  const drawn: FilmStage['frames'] = []
  let done = 0
  for (const frame of frames) {
    try {
      const blob = await rasterizeFrame(frame, { scale, type: 'png', signal: opts.signal })
      drawn.push({ frame, image: await createImageBitmap(blob) })
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
export function drawAt(ctx: CanvasRenderingContext2D, comp: Composition, stage: FilmStage, t: number): void {
  const camera = cameraAt(comp, t) ?? stage.fallback
  const { width, height } = comp
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = stage.ground
  ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2)
  ctx.rotate((-camera.rotation * Math.PI) / 180)
  ctx.scale(camera.zoom, camera.zoom)
  ctx.translate(-camera.x, -camera.y)
  ctx.imageSmoothingQuality = 'high'
  for (const { frame, image } of stage.frames) {
    if (frame.rotation) {
      ctx.save()
      ctx.translate(frame.x + frame.width / 2, frame.y + frame.height / 2)
      ctx.rotate((frame.rotation * Math.PI) / 180)
      ctx.drawImage(image, -frame.width / 2, -frame.height / 2, frame.width, frame.height)
      ctx.restore()
    } else {
      ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height)
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
