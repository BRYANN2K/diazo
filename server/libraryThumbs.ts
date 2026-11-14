/**
 * Item thumbnails: an image per library item, so lists and the gallery
 * never mount an iframe. The frame is rendered clipped to the item's box
 * (from the rendered pass) plus a margin, as a JPEG whose longest side is
 * 640 px, at background priority, and kept in storage under a key that
 * carries the item's content hash, so a changed item gets a new image.
 */
import type { Frame } from '../shared/types.ts'
import type { ItemBox, LibraryItem } from '../shared/library.ts'
import { getObject, putObject } from './storage.ts'
import { renderFrame, type RenderOptions } from './screenshot.ts'
import { store } from './store.ts'

export const THUMB_MARGIN = 12
export const THUMB_MAX = 640

/** The item has no box yet: the client crops the frame preview instead. */
export class NoThumbError extends Error {}

export interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/** The item's box plus the margin, clamped to the frame. */
export function thumbClip(box: ItemBox, frame: Pick<Frame, 'width' | 'height'>): Clip {
  const x = Math.max(0, Math.floor(box.x - THUMB_MARGIN))
  const y = Math.max(0, Math.floor(box.y - THUMB_MARGIN))
  const right = Math.min(frame.width, Math.ceil(box.x + box.w + THUMB_MARGIN))
  const bottom = Math.min(Math.max(frame.height, box.y + box.h), Math.ceil(box.y + box.h + THUMB_MARGIN))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** Where a thumbnail is kept: changes with the item's content. */
export function thumbKey(canvasId: string, item: Pick<LibraryItem, 'itemId' | 'hash'>): string {
  const safe = item.itemId.replace(/[^\w.-]/g, '_').slice(0, 120)
  const hash = item.hash.replace(/[^\w-]/g, '_')
  return `lt/${canvasId}/${safe}-${hash}.jpg`
}

export interface ThumbDeps {
  render(frame: Frame, scale: number, opts: RenderOptions): Promise<Buffer>
  get(key: string): Promise<Buffer | null>
  put(key: string, body: Buffer, mime: string): Promise<void>
  frame(frameId: string): Promise<Frame | undefined>
}

const serverDeps: ThumbDeps = {
  render: (frame, scale, opts) => renderFrame(frame, scale, opts),
  get: (key) => getObject(key),
  put: (key, body, mime) => putObject(key, body, mime),
  frame: (frameId) => store.renderableFrame(frameId),
}

/** The JPEG of one item: from storage, else rendered and stored. A busy
 *  renderer throws RendererBusyError (the route answers 503). */
export async function itemThumb(item: LibraryItem, deps: ThumbDeps = serverDeps): Promise<Buffer> {
  if (!item.box) throw new NoThumbError(`item ${item.itemId} has no box yet`)
  const key = thumbKey(item.canvasId, item)
  const cached = await deps.get(key)
  if (cached) return cached
  const frame = await deps.frame(item.frameId)
  if (!frame) throw new NoThumbError(`frame ${item.frameId} is gone`)
  const clip = thumbClip(item.box, frame)
  const scale = Math.min(1, THUMB_MAX / Math.max(clip.width, clip.height))
  const jpeg = await deps.render(frame, scale, { type: 'jpeg', quality: 82, clip, priority: 'background' })
  await deps.put(key, jpeg, 'image/jpeg')
  return jpeg
}
