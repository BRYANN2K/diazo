/**
 * Item thumbnails: an image per library item, so lists and the gallery
 * never mount an iframe. The item's demo is found in the rendered frame
 * (its element by box, data-doop-id or anchor, minus the sheet's label and
 * caption rows), woken and trimmed to what it paints (libraryThumbRender.ts),
 * as a 640x480 JPEG, and kept in storage under a key that carries the
 * item's content hash, its box and the thumbnail version, so a changed item
 * (or a new way of drawing them) gets a new image.
 *
 * A thumbnail being rendered is a promise every asker shares (the gallery
 * route and the prewarm queue never render the same key twice), and the
 * items of one frame render together on one page.
 */
import { createHash } from 'node:crypto'
import type { Frame } from '../shared/types.ts'
import type { LibraryItem } from '../shared/library.ts'
import { getObject, hasObject, putObject } from './storage.ts'
import type { Page } from 'puppeteer-core'
import { backgroundConcurrency, withFramePage } from './screenshot.ts'
import { captureItems, TIMING, type ThumbPage } from './libraryThumbRender.ts'
import type { ThumbTarget } from './libraryThumbClip.ts'
import { RendererBusyError, type RenderPriority } from './renderBrowser.ts'
import { store } from './store.ts'

/** Bumped when thumbnails are drawn differently: every key changes. */
export const THUMB_VERSION = 2

/** The item cannot have a thumbnail (its frame is gone): the client falls back. */
export class NoThumbError extends Error {}

type Keyed = Pick<LibraryItem, 'itemId' | 'hash' | 'box'>

const digest = (text: string, length: number) => createHash('sha1').update(text).digest('hex').slice(0, length)

/** What the picture depends on: the version, the content and the box. The
 *  gallery asks with it (`?v=`), so a browser keeps a picture forever. */
export function thumbTag(item: Keyed): string {
  const box = item.box ? `${item.box.x},${item.box.y},${item.box.w},${item.box.h}` : 'none'
  return digest(`${THUMB_VERSION}|${item.hash}|${box}`, 16)
}

/** Where a thumbnail is kept: storage keys allow no dots in a name, so the
 *  id is spelled safely and told apart from its look-alikes by a digest. */
export function thumbKey(canvasId: string, item: Keyed): string {
  const safe = item.itemId.replace(/[^\w-]/g, '_').slice(0, 100)
  return `lt/${canvasId}/${safe}-${digest(item.itemId, 8)}-${thumbTag(item)}.jpg`
}

export interface ThumbDeps {
  /** the pictures of several items of one frame, in order */
  render(frame: Frame, items: LibraryItem[], priority: RenderPriority): Promise<(Buffer | Error)[]>
  get(key: string): Promise<Buffer | null>
  has(key: string): Promise<boolean>
  put(key: string, body: Buffer, mime: string): Promise<void>
  frame(frameId: string): Promise<Frame | undefined>
}

/** Where the probe looks for an item's element. */
export function thumbTarget(item: LibraryItem): ThumbTarget {
  return {
    itemId: item.itemId,
    box: item.box,
    ...('elementId' in item.locator ? { elementId: item.locator.elementId } : {}),
    ...('anchor' in item.locator ? { anchor: item.locator.anchor } : {}),
  }
}

/** The headless page as the capture needs it. */
export function thumbPage(page: Page): ThumbPage {
  return {
    evaluate: (expression) => page.evaluate(expression),
    setViewport: (viewport) => page.setViewport(viewport),
    viewport: () => page.viewport(),
    movePointer: (x, y, steps) => page.mouse.move(x, y, { steps }),
    screenshot: async (clip) => Buffer.from(await page.screenshot({ type: 'png', clip, captureBeyondViewport: true })),
  }
}

/** The page's viewport: the whole frame, as the canvas lays it out. */
export function thumbViewport(frame: Pick<Frame, 'width' | 'height'>) {
  return {
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.min(Math.round(frame.height), 8000)),
    deviceScaleFactor: 1,
  }
}

/** a page settles once, then each item takes about a second */
const RENDER_TIMEOUT_MS = 60_000

function renderOnPage(frame: Frame, items: LibraryItem[], priority: RenderPriority) {
  return withFramePage(
    frame,
    'rendering library thumbnails',
    RENDER_TIMEOUT_MS,
    async (page) => {
      await page.setViewport(thumbViewport(frame))
      return captureItems(thumbPage(page), items.map(thumbTarget), TIMING[priority])
    },
    { priority },
  )
}

export const serverThumbDeps: ThumbDeps = {
  render: renderOnPage,
  get: (key) => getObject(key),
  has: (key) => hasObject(key),
  put: (key, body, mime) => putObject(key, body, mime),
  frame: (frameId) => store.renderableFrame(frameId),
}

/** Keys being rendered right now, and the promise of each. */
const inflight = new Map<string, Promise<Buffer>>()

/** Whether a thumbnail is being rendered (tests, the prewarm). */
export function isRendering(key: string): boolean {
  return inflight.has(key)
}

/**
 * Render the thumbnails of some items of ONE frame and store them. A key
 * already being rendered is shared, never rendered twice; the rest render
 * together on one page. One promise per item, in order.
 */
export function renderThumbs(
  items: LibraryItem[],
  priority: RenderPriority,
  deps: ThumbDeps = serverThumbDeps,
): Promise<Buffer>[] {
  const out: Promise<Buffer>[] = []
  const fresh: { item: LibraryItem; at: number; key: string }[] = []
  items.forEach((item, at) => {
    const key = thumbKey(item.canvasId, item)
    const running = inflight.get(key)
    if (running) out[at] = running
    else if (fresh.some((f) => f.key === key)) out[at] = Promise.resolve().then(() => inflight.get(key)!)
    else fresh.push({ item, at, key })
  })
  if (!fresh.length) return out
  const frameId = fresh[0]!.item.frameId
  const batch = (async () => {
    const frame = await deps.frame(frameId)
    if (!frame) throw new NoThumbError(`frame ${frameId} is gone`)
    return deps.render(
      frame,
      fresh.map((f) => f.item),
      priority,
    )
  })()
  fresh.forEach((f, n) => {
    const done: Promise<Buffer> = batch
      .then(async (pictures) => {
        const picture = pictures[n]
        if (!picture) throw new Error(`no picture for ${f.item.itemId}`)
        if (picture instanceof Error) throw picture
        await deps.put(f.key, picture, 'image/jpeg')
        return picture
      })
      .finally(() => {
        if (inflight.get(f.key) === done) inflight.delete(f.key)
      })
    inflight.set(f.key, done)
    out[f.at] = done
  })
  return out
}

/** The JPEG of one item: from storage, else rendered (or awaited, when it
 *  is being rendered already) and stored. A busy renderer throws
 *  RendererBusyError (the route answers 503). */
export async function itemThumb(
  item: LibraryItem,
  opts: { priority?: RenderPriority } = {},
  deps: ThumbDeps = serverThumbDeps,
): Promise<Buffer> {
  const key = thumbKey(item.canvasId, item)
  const running = inflight.get(key)
  if (running) return running
  const cached = await deps.get(key)
  if (cached) return cached
  return inflight.get(key) ?? renderThumbs([item], opts.priority ?? 'background', deps)[0]!
}

/** The gallery asked faster than the renderer draws: try again shortly. */
export class ThumbsBusyError extends RendererBusyError {
  readonly retryAfterS = 2
}

/** Thumbnails a person is waiting for, rendered at once at most: the rest
 *  of the pages stay for agents and screenshots. */
export const galleryRenderLimit = () => Math.max(1, backgroundConcurrency)
let galleryRenders = 0

/**
 * A thumbnail a person is looking at (the gallery route): stored, or being
 * rendered already (the prewarm's render is awaited, not repeated), or
 * rendered now at interactive priority, ahead of the prewarm, as long as
 * fewer than `limit` of these render; past that a ThumbsBusyError, which
 * the route answers with a short Retry-After.
 */
export async function requestThumb(
  item: LibraryItem,
  deps: ThumbDeps = serverThumbDeps,
  limit = galleryRenderLimit(),
): Promise<Buffer> {
  const key = thumbKey(item.canvasId, item)
  const running = inflight.get(key)
  if (running) return running
  const cached = await deps.get(key)
  if (cached) return cached
  const started = inflight.get(key)
  if (started) return started
  if (galleryRenders >= limit) throw new ThumbsBusyError(`${galleryRenders} gallery thumbnails rendering`)
  galleryRenders++
  try {
    return await renderThumbs([item], 'interactive', deps)[0]!
  } finally {
    galleryRenders--
  }
}

/** How the gallery route answers a thumbnail it could not have: a busy
 *  renderer is a 503 the client retries after Retry-After (2s when the
 *  gallery's own share is full, 10s when the whole renderer is); a gone
 *  frame is a 404 and anything else a 500, both final for the client,
 *  which falls back on the frame's preview. */
export function thumbFailure(error: unknown): { status: 503 | 404 | 500; retryAfterS?: number; message: string } {
  if (error instanceof ThumbsBusyError) return { status: 503, retryAfterS: error.retryAfterS, message: error.message }
  if (error instanceof RendererBusyError) return { status: 503, retryAfterS: 10, message: error.message }
  if (error instanceof NoThumbError) return { status: 404, message: error.message }
  return { status: 500, message: 'thumbnail failed' }
}
