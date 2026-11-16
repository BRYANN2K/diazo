import type { Viewport } from '../store'
import type { CameraState, Composition } from './contract'

/* The film's camera on the editor's stage. A composition camera is a world
   point at the centre of a `width × height` shot and a zoom in output px per
   world px; the stage shows that shot fitted into its own box. Rotation has
   no stage equivalent and is left to the render. */

export function stageBox(): { width: number; height: number } | null {
  const el = document.querySelector<HTMLElement>('.stage')
  return el ? { width: el.clientWidth, height: el.clientHeight } : null
}

function fit(comp: Composition, box: { width: number; height: number }) {
  return Math.min(box.width / comp.width, box.height / comp.height)
}

export function cameraToViewport(
  camera: CameraState,
  comp: Composition,
  box: { width: number; height: number },
): Viewport {
  const zoom = fit(comp, box) * camera.zoom
  return { x: box.width / 2 - camera.x * zoom, y: box.height / 2 - camera.y * zoom, zoom }
}

export function viewportToCamera(
  viewport: Viewport,
  comp: Composition,
  box: { width: number; height: number },
): CameraState {
  const zoom = viewport.zoom / fit(comp, box)
  return {
    x: (box.width / 2 - viewport.x) / viewport.zoom,
    y: (box.height / 2 - viewport.y) / viewport.zoom,
    zoom,
    rotation: 0,
  }
}
