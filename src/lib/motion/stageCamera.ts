import type { Viewport } from '../store'
import type { CameraState, Composition } from './contract'

/* The film's camera on the editor's stage. A composition camera is a world
   point at the centre of a `width × height` shot and a zoom in output px per
   world px; the stage shows that shot fitted into the part of the stage the
   chrome leaves open (the bar, the side panels and the timeline itself).
   Rotation has no stage equivalent and is left to the render. */

/** the open part of the stage, in stage px */
export interface StageBox {
  width: number
  height: number
  /** where the open part starts inside the stage */
  left?: number
  top?: number
}

function px(el: Element | null, name: string): number {
  if (!el) return 0
  const value = parseFloat(getComputedStyle(el).getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

export function stageBox(): StageBox | null {
  const stage = document.querySelector<HTMLElement>('.stage')
  if (!stage) return null
  /* the canvas page writes what its chrome covers as custom properties */
  const chrome = document.querySelector('[style*="--chrome-left"]')
  const left = px(chrome, '--chrome-left')
  const right = px(chrome, '--chrome-right')
  const top = px(chrome, '--chrome-top')
  const timeline = document.querySelector<HTMLElement>('[data-slot=motion-timeline]')
  const bottom = timeline ? timeline.offsetHeight + 24 : 0
  const width = Math.max(160, stage.clientWidth - left - right)
  const height = Math.max(120, stage.clientHeight - top - bottom)
  return { width, height, left, top }
}

function fit(comp: Composition, box: StageBox) {
  return Math.min(box.width / comp.width, box.height / comp.height)
}

export function cameraToViewport(camera: CameraState, comp: Composition, box: StageBox): Viewport {
  const zoom = fit(comp, box) * camera.zoom
  return {
    x: (box.left ?? 0) + box.width / 2 - camera.x * zoom,
    y: (box.top ?? 0) + box.height / 2 - camera.y * zoom,
    zoom,
  }
}

export function viewportToCamera(viewport: Viewport, comp: Composition, box: StageBox): CameraState {
  const zoom = viewport.zoom / fit(comp, box)
  return {
    x: ((box.left ?? 0) + box.width / 2 - viewport.x) / viewport.zoom,
    y: ((box.top ?? 0) + box.height / 2 - viewport.y) / viewport.zoom,
    zoom,
    rotation: 0,
  }
}
