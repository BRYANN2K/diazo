import { PREVIEW_MAX_HEIGHT, type Frame } from '../shared/types.ts'
import { FRAME_PREVIEW_WIDTHS, previewScale, type FramePreviewWidth } from '../shared/framePreview.ts'
import { withRenderSlot } from './renderLimits.ts'
import * as storage from './storage.ts'
import { store } from './store.ts'

/**
 * Persisted frame previews in byte storage, stale-while-revalidate on top.
 * Two kinds:
 *  - the dashboard card (`thumb/<frameId>.jpg`): 640px wide, the top
 *    `PREVIEW_MAX_HEIGHT` px of the frame;
 *  - stage images (`thumb/<frameId>-w<width>.<ext>`): the whole frame at one
 *    of the `FRAME_PREVIEW_WIDTHS` steps, which a zoomed-out canvas shows in
 *    place of the frames' documents (src/lib/frameLod.ts).
 *
 * The stored object survives redeploys — which wipe the in-process image
 * cache — so a dashboard or a zoomed-out canvas never shows blank tiles
 * waiting on Chromium: a possibly-stale preview is served instantly and
 * refreshed in the background. Keys are deliberately unversioned; freshness
 * lives in memory: `written` (the frame.updatedAt a stored preview was
 * rendered from) against `designAt` (the updatedAt of the frame's last
 * design write, so a frame that was only moved keeps its preview). After a
 * restart freshness is simply unknown, which degrades to one background
 * re-render per previewed frame — never to a blank tile.
 */

export type ThumbVariant = { kind: 'card' } | { kind: 'stage'; width: FramePreviewWidth; ext: 'jpg' | 'png' }

export const CARD: ThumbVariant = { kind: 'card' }

export interface StoredThumb {
  buf: Buffer
  /** rendered from the frame's current design; false while a refresh runs */
  fresh: boolean
}

/** frame id + variant → frame.updatedAt the stored preview was rendered from */
const written = new Map<string, number>()
/** in-flight render+persist per frame and variant — concurrent callers share it */
const pending = new Map<string, Promise<Buffer>>()
/** background revalidation throttle: an agent saving every few seconds
 *  must not turn each dashboard poll into a Chromium render */
const lastAttempt = new Map<string, number>()
const MIN_REVALIDATE_MS = 30_000
/** frame id → updatedAt of its last design write seen by this process */
const designAt = new Map<string, number>()
/** frame id → the stage variants someone asked for, refreshed after a write */
const asked = new Map<string, Map<string, ThumbVariant>>()
/** frame id → the timer of its after-write refresh */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** quiet time after a frame's last write before its stage images re-render:
 *  a streaming agent writes many times a second */
export const REFRESH_AFTER_WRITE_MS = 15_000
/** frames purged mid-render — a pending create must not re-persist them */
const dead = new Set<string>()

const suffix = (v: ThumbVariant) => (v.kind === 'card' ? '' : `-w${v.width}.${v.ext}`)
const slot = (frameId: string, v: ThumbVariant) => frameId + suffix(v)
const keyFor = (frameId: string, v: ThumbVariant) =>
  v.kind === 'card' ? `thumb/${frameId}.jpg` : `thumb/${frameId}-w${v.width}.${v.ext}`
const mimeOf = (v: ThumbVariant) => (v.kind === 'stage' && v.ext === 'png' ? 'image/png' : 'image/jpeg')

/* lazy like every other screenshot.ts consumer (dev never pays for
   puppeteer-core until the first render), but single-flight */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))

/** The preview render, cheap and at background priority: a tile or a
 *  zoomed-out canvas can wait, an agent's screenshot should not. */
function render(frame: Frame, v: ThumbVariant): Promise<{ buf: Buffer; renderedAt: number }> {
  return withRenderSlot(async () => {
    const { renderFrame } = await loadScreenshot()
    /* the html is read when the render starts, not when it was queued, and
       the version it shows is the one it read: `frame` is the live record */
    const renderedAt = frame.updatedAt
    const source = await store.renderSource(frame)
    const buf =
      v.kind === 'card'
        ? await renderFrame(source, Math.min(1, 640 / frame.width), {
            type: 'jpeg',
            quality: 70,
            maxHeight: PREVIEW_MAX_HEIGHT,
            priority: 'background',
          })
        : await renderFrame(source, previewScale(frame.width, v.width), {
            type: v.ext === 'png' ? 'png' : 'jpeg',
            quality: 75,
            priority: 'background',
          })
    return { buf, renderedAt }
  })
}

/** Render now, persist, and return the bytes. Deduped per frame and variant;
 *  rejects on render failure (the caller decides what a failed render means). */
export function create(frame: Frame, v: ThumbVariant = CARD): Promise<Buffer> {
  const at = slot(frame.id, v)
  const inflight = pending.get(at)
  if (inflight) return inflight
  lastAttempt.set(at, Date.now())
  const p = render(frame, v).then(async ({ buf, renderedAt }) => {
    /* persist is best-effort: a bucket hiccup must not fail the response
       that only needed the bytes */
    try {
      if (!dead.has(frame.id)) {
        await storage.putObject(keyFor(frame.id, v), buf, mimeOf(v))
        written.set(at, renderedAt)
        /* purge may have run during the put — its delete can land before
           our write finishes, so re-check and clean up our own orphan */
        if (dead.has(frame.id)) await storage.deleteObject(keyFor(frame.id, v))
      }
    } catch (e) {
      console.error(`thumb persist failed for ${frame.id}:`, e)
    }
    return buf
  })
  pending.set(at, p)
  p.catch(() => {}).finally(() => pending.delete(at))
  return p
}

/** Whether the preview stored for `frame` shows its current design. */
function isFresh(frame: Frame, v: ThumbVariant): boolean {
  const renderedAt = written.get(slot(frame.id, v))
  return renderedAt !== undefined && renderedAt >= (designAt.get(frame.id) ?? frame.updatedAt)
}

/** The stored preview, if there is one. When it is stale — or its
 *  freshness is unknown after a restart — a background re-render is kicked
 *  off (throttled, deduped, errors logged and swallowed) and the stored
 *  bytes are returned anyway: stale beats blank. Returns null when nothing
 *  is stored yet. */
export async function getStored(frame: Frame, v: ThumbVariant = CARD): Promise<StoredThumb | null> {
  const at = slot(frame.id, v)
  if (v.kind === 'stage') remember(frame.id, v)
  let buf: Buffer | null
  try {
    buf = await storage.getObject(keyFor(frame.id, v))
  } catch (e) {
    console.error(`thumb read failed for ${frame.id}:`, e)
    return null
  }
  if (!buf) {
    /* the map claimed fresh but the object is gone (manual purge, new
       bucket) — forget, so the caller falls through to a live render */
    written.delete(at)
    return null
  }
  const fresh = isFresh(frame, v)
  const throttled = Date.now() - (lastAttempt.get(at) ?? 0) < MIN_REVALIDATE_MS
  if (!fresh && !throttled && !pending.has(at))
    create(frame, v).catch((e) => console.error(`thumb revalidate failed for ${frame.id}:`, e))
  return { buf, fresh }
}

/** Note a stage variant a viewer asked for, so a later write refreshes it
 *  ahead of the next zoom-out. */
export function remember(frameId: string, v: ThumbVariant): void {
  if (v.kind !== 'stage') return
  let variants = asked.get(frameId)
  if (!variants) asked.set(frameId, (variants = new Map()))
  variants.set(suffix(v), v)
}

/** A frame's design changed (`store.onFrameWrite` 'write'). Its stored
 *  previews are stale from now on; the stage images someone already looked
 *  at re-render once the frame has been quiet `REFRESH_AFTER_WRITE_MS`, at
 *  background priority, so the next zoom-out shows the new design at once.
 *  Frames nobody looked at as an image cost nothing. */
export function noteDesignWrite(frameId: string): void {
  const frame = store.getFrame(frameId)
  if (!frame) return
  designAt.set(frameId, frame.updatedAt)
  if (!asked.has(frameId)) return
  clearTimeout(refreshTimers.get(frameId))
  const timer = setTimeout(() => {
    refreshTimers.delete(frameId)
    const current = store.getFrame(frameId)
    if (!current || dead.has(frameId)) return
    for (const v of asked.get(frameId)?.values() ?? []) {
      if (isFresh(current, v)) continue
      create(current, v).catch((e) => console.error(`thumb refresh failed for ${frameId}:`, e))
    }
  }, REFRESH_AFTER_WRITE_MS)
  timer.unref?.()
  refreshTimers.set(frameId, timer)
}

/** Follow frame writes for the freshness of stored previews. Called once at
 *  boot; returns the unsubscribe. */
export function followFrameWrites(): () => void {
  return store.onFrameWrite((write) => {
    if (write.kind === 'write') noteDesignWrite(write.frameId)
  })
}

/** Frame (or its whole canvas) is gone — drop the derived objects too, so the
 *  thumb folder holds only live frames. Best-effort fire-and-forget. */
export function purge(frameId: string): void {
  dead.add(frameId)
  designAt.delete(frameId)
  clearTimeout(refreshTimers.get(frameId))
  refreshTimers.delete(frameId)
  asked.delete(frameId)
  /* every stage variant, not only those asked of this process: the ones
     stored before a restart are as derived */
  const variants: ThumbVariant[] = [
    CARD,
    ...FRAME_PREVIEW_WIDTHS.flatMap((width) =>
      (['jpg', 'png'] as const).map((ext) => ({ kind: 'stage' as const, width, ext })),
    ),
  ]
  for (const v of variants) {
    written.delete(slot(frameId, v))
    lastAttempt.delete(slot(frameId, v))
    storage.deleteObject(keyFor(frameId, v)).catch(() => {})
  }
}
