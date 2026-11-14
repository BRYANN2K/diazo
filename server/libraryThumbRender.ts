/**
 * Taking a library item's picture in the headless page: find its demo
 * (libraryThumbClip.ts), wake it (fonts, a pointer over it, animations
 * moved past their blank first frame), trim the uniform background around
 * what it paints, and frame that at the gallery tile's 4:3 on the demo's own
 * background, so a tile shows the component rather than the sheet's chrome.
 *
 * Works on a `ThumbPage`, the few page calls it needs, so tests drive it
 * with a fake page; `server/libraryThumbs.ts` hands it a real one.
 */
import sharp from 'sharp'
import {
  chooseThumbClip,
  FONTS_READY_SOURCE,
  probeExpression,
  roundClip,
  SETTLE_ANIMATIONS_SOURCE,
  type ThumbProbe,
  type ThumbRect,
  type ThumbTarget,
} from './libraryThumbClip.ts'

/** The thumbnail's size: the gallery tile's 4:3, at most 640 px wide. */
export const THUMB_W = 640
export const THUMB_H = 480
const ASPECT = THUMB_W / THUMB_H
/** the tallest viewport a thumbnail page is given */
const MAX_VIEWPORT = 8000
/** the first, rough picture the trim reads, on its longest side */
const TRIM_PROBE_PX = 800
/** pixels this close to the corner colour count as background */
const TRIM_THRESHOLD = 12
/** room left around trimmed content, as a share of its longest side */
const PAD_SHARE = 0.14
/** content covering this much of its demo box is full-bleed: shown whole, not padded */
const FULL_BLEED = 0.9
/** the edge band of a demo box the trim does not read (rounded corners, borders) */
const EDGE_BAND_PX = 14

export interface ThumbClipRegion {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

export interface ThumbPage {
  evaluate(expression: string): Promise<unknown>
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void>
  viewport(): { width: number; height: number } | null
  movePointer(x: number, y: number, steps: number): Promise<void>
  screenshot(clip: ThumbClipRegion): Promise<Buffer>
}

export interface CaptureTiming {
  /** how long the page runs before the first picture: late scripts, delayed effects */
  settleMs: number
  /** how long a demo runs under the pointer before its picture */
  itemMs: number
}

/** A person waits for an interactive thumbnail; the prewarm can wait longer,
 *  long enough for late scripts to fill their demos. */
export const TIMING: Record<'interactive' | 'background', CaptureTiming> = {
  interactive: { settleMs: 1200, itemMs: 400 },
  background: { settleMs: 1800, itemMs: 500 },
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isProbe(value: unknown): value is ThumbProbe {
  return typeof value === 'object' && value !== null && 'root' in value && 'width' in value
}

async function probe(page: ThumbPage, target: ThumbTarget): Promise<ThumbProbe> {
  const out = await page.evaluate(probeExpression(target))
  if (!isProbe(out) || !out.root) throw new Error(`item ${target.itemId} has nothing to show`)
  return out
}

/** The demo's box, kept inside the document. */
function clipOf(found: ThumbProbe): ThumbRect {
  const r = chooseThumbClip(found.root!)
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  const right = Math.min(Math.max(found.width, 1), r.x + r.w)
  const bottom = Math.min(Math.max(found.height, 1), r.y + r.h)
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) }
}

/** A demo laid out past the viewport (a card cut from a wider sheet keeps
 *  the sheet's width) gets a viewport that reaches it, then is found again. */
async function reach(page: ThumbPage, target: ThumbTarget, found: ThumbProbe): Promise<ThumbRect> {
  let clip = clipOf(found)
  const view = page.viewport()
  if (!view) return clip
  const right = Math.ceil(clip.x + clip.w)
  const bottom = Math.min(MAX_VIEWPORT, Math.ceil(clip.y + clip.h))
  if (right > view.width || bottom > view.height) {
    await page.setViewport({
      width: Math.max(view.width, right),
      height: Math.max(view.height, bottom),
      deviceScaleFactor: 1,
    })
    clip = clipOf(await probe(page, target))
  }
  return clip
}

type Rgb = { r: number; g: number; b: number }

/** The demo's own background: the colour most of its four corners share
 *  (one corner may hold the content, or a border's end). */
export function cornerColour(corners: Rgb[]): Rgb {
  const key = (c: Rgb) => `${c.r >> 3},${c.g >> 3},${c.b >> 3}`
  const counts = new Map<string, number>()
  for (const c of corners) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1)
  let best = corners[0] ?? { r: 255, g: 255, b: 255 }
  for (const c of corners) if ((counts.get(key(c)) ?? 0) > (counts.get(key(best)) ?? 0)) best = c
  return best
}

/** What a rough picture of `clip` paints, in document px, and its
 *  background. The picture's edge band is left out of the reading (a
 *  rounded demo box shows its parent's colour in its corners, a border runs
 *  along it); content reaching the band is taken to reach the edge. */
async function paintedBounds(page: ThumbPage, clip: ThumbRect): Promise<{ content: ThumbRect; background: Rgb }> {
  const box = roundClip(clip, true)
  const scale = Math.min(1, TRIM_PROBE_PX / Math.max(box.width, box.height))
  const png = await page.screenshot({ ...box, scale })
  const meta = await sharp(png).metadata()
  const width = meta.width ?? 1
  const height = meta.height ?? 1
  const band = (size: number) => Math.min(Math.round(EDGE_BAND_PX * scale), Math.floor(size * 0.1))
  const bx = band(width)
  const by = band(height)
  const inner = { left: bx, top: by, width: Math.max(1, width - bx * 2), height: Math.max(1, height - by * 2) }
  /* one operation per pipeline: sharp runs a trim before an extract */
  const middle = await sharp(png).extract(inner).png().toBuffer()
  const { data, info: raw } = await sharp(middle).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number): Rgb => {
    const i = (y * raw.width + x) * raw.channels
    return { r: data[i] ?? 255, g: data[i + 1] ?? 255, b: data[i + 2] ?? 255 }
  }
  const right = raw.width - 1
  const bottom = raw.height - 1
  const background = cornerColour([at(0, 0), at(right, 0), at(0, bottom), at(right, bottom)])
  try {
    const { info } = await sharp(middle)
      .trim({ background, threshold: TRIM_THRESHOLD })
      .toBuffer({ resolveWithObject: true })
    if (info.width < 2 || info.height < 2) return { content: clip, background }
    let left = inner.left - (info.trimOffsetLeft ?? 0)
    let top = inner.top - (info.trimOffsetTop ?? 0)
    let end = left + info.width
    let foot = top + info.height
    if (left <= inner.left) left = 0
    if (top <= inner.top) top = 0
    if (end >= inner.left + inner.width) end = width
    if (foot >= inner.top + inner.height) foot = height
    return {
      content: { x: box.x + left / scale, y: box.y + top / scale, w: (end - left) / scale, h: (foot - top) / scale },
      background,
    }
  } catch {
    /* a uniform picture has nothing to trim to: show the whole demo */
    return { content: clip, background }
  }
}

export interface Framing {
  /** what the picture shows, in document px, at the tile's aspect */
  want: ThumbRect
  /** the part of it taken from the page (inside the demo box) */
  take: ThumbRect
}

/**
 * Where the picture goes, at the tile's 4:3: content that fills its demo
 * box (a photo, a full-bleed hero, a stage with its own backdrop) is the
 * whole demo box; content in a margin of its own background gets a little
 * room around it. Either is centred, and the part past the demo box is
 * filled with the demo's background rather than the chrome around it.
 */
export function frameContent(content: ThumbRect, demo: ThumbRect): Framing {
  const fullBleed = content.w >= demo.w * FULL_BLEED && content.h >= demo.h * FULL_BLEED
  const shown = fullBleed ? demo : content
  const pad = fullBleed ? 0 : Math.max(8, Math.max(content.w, content.h) * PAD_SHARE)
  const w0 = shown.w + pad * 2
  const h0 = shown.h + pad * 2
  const w = Math.max(w0, h0 * ASPECT)
  const h = Math.max(h0, w0 / ASPECT)
  const want = { x: shown.x + shown.w / 2 - w / 2, y: shown.y + shown.h / 2 - h / 2, w, h }
  const x = Math.max(want.x, demo.x)
  const y = Math.max(want.y, demo.y)
  const right = Math.min(want.x + want.w, demo.x + demo.w)
  const bottom = Math.min(want.y + want.h, demo.y + demo.h)
  return { want, take: { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) } }
}

async function picture(page: ThumbPage, clip: ThumbRect): Promise<Buffer> {
  const { content, background } = await paintedBounds(page, clip)
  const { want, take } = frameContent(content, clip)
  const scale = Math.min(2, THUMB_W / want.w, THUMB_H / want.h)
  const box = roundClip(take, true)
  const png = await page.screenshot({ ...box, scale })
  const meta = await sharp(png).metadata()
  const outW = Math.round(want.w * scale)
  const outH = Math.round(want.h * scale)
  const left = Math.max(0, Math.round((box.x - want.x) * scale))
  const top = Math.max(0, Math.round((box.y - want.y) * scale))
  const right = Math.max(0, outW - left - (meta.width ?? 0))
  const bottom = Math.max(0, outH - top - (meta.height ?? 0))
  /* separate pipelines: sharp would resize before it extends */
  const framed = await sharp(png)
    .extend({ left, top, right, bottom, background })
    .flatten({ background })
    .png()
    .toBuffer()
  return sharp(framed)
    .resize(THUMB_W, THUMB_H, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
}

/**
 * The pictures of several items of one loaded frame, in order: one page,
 * one settle, then each item found, woken under the pointer and taken. A
 * failure is that item's own (an Error in its place).
 */
export async function captureItems(
  page: ThumbPage,
  targets: ThumbTarget[],
  timing: CaptureTiming,
): Promise<(Buffer | Error)[]> {
  await page.evaluate(FONTS_READY_SOURCE)
  await wait(timing.settleMs)
  const out: (Buffer | Error)[] = []
  for (const target of targets) {
    try {
      const clip = await reach(page, target, await probe(page, target))
      /* many demos follow the pointer: bring it in from the side to the centre */
      await page.movePointer(clip.x + clip.w * 0.3, clip.y + clip.h * 0.4, 1)
      await page.movePointer(clip.x + clip.w / 2, clip.y + clip.h / 2, 8)
      await wait(timing.itemMs)
      await page.evaluate(SETTLE_ANIMATIONS_SOURCE)
      out.push(await picture(page, clip))
    } catch (error) {
      out.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return out
}
