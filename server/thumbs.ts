import { createHash } from 'node:crypto'
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
 * refreshed in the background. Image keys include the render version;
 * freshness is `written` (the frame.updatedAt a stored preview was rendered from)
 * against `designAt` (the updatedAt of the frame's last design write, so a
 * frame that was only moved keeps its preview). Both are persisted in a
 * small ledger beside the objects (`thumb/_freshness.json`), so a restart
 * re-renders nothing that did not change. A fingerprint of HTML and size
 * also detects writes whose notification was lost before a restart.
 * Legacy unversioned objects are served stale and replaced on demand.
 */

export type ThumbVariant = { kind: 'card' } | { kind: 'stage'; width: FramePreviewWidth; ext: 'jpg' | 'png' }

export const CARD: ThumbVariant = { kind: 'card' }

export interface StoredThumb {
  buf: Buffer
  /** rendered from the frame's current design; false while a refresh runs */
  fresh: boolean
}

export interface CreatedThumb {
  buf: Buffer
  /** the frame.updatedAt the render actually drew — a write that lands
   *  mid-render leaves this behind the frame's version */
  renderedAt: number
  design: string
}

/** frame id + variant → frame.updatedAt the stored preview was rendered from */
const written = new Map<string, number>()
/** Fingerprints of the exact HTML and dimensions drawn, independent of moves. */
const designs = new Map<string, string>()
/** in-flight render+persist per frame and variant — concurrent callers share it */
const pending = new Map<string, Promise<CreatedThumb>>()
/** background revalidation throttle: an agent saving every few seconds
 *  must not turn each dashboard poll into a Chromium render */
const lastAttempt = new Map<string, number>()
const MIN_REVALIDATE_MS = 30_000
/** frame id → updatedAt of its last design write seen by this process */
const designAt = new Map<string, number>()
/** frame id → the stage variants someone asked for recently, refreshed after a write */
const asked = new Map<string, Map<string, { v: ThumbVariant; at: number }>>()
/** a variant nobody asked for in a day is not refreshed after writes */
const ASKED_TTL_MS = 24 * 60 * 60_000
/** frame id → the timer of its after-write refresh */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** frame id → updatedAt of a revision a script run wrote: that revision's
 *  previews render offline — script-supplied markup must never send an
 *  automatic render to remote origins */
const scriptWritten = new Map<string, number>()

/** Note the revision a script run just wrote to `frameId`. Called from the
 *  run's undo journal at the write itself; the mark covers exactly that
 *  revision — a later human write renders online again. */
export function noteScriptFrameWrite(frameId: string): void {
  const frame = store.getFrame(frameId)
  if (frame) scriptWritten.set(frameId, frame.updatedAt)
}

/** Whether the frame's current revision is one a script run wrote. Any
 *  automatic render of such a revision — preview refresh, resident final
 *  review — stays offline; a later human write renders online again. */
export function isScriptWrittenRevision(frame: Pick<Frame, 'id' | 'updatedAt'>): boolean {
  return scriptWritten.get(frame.id) === frame.updatedAt
}
/** quiet time after a frame's last write before its stage images re-render:
 *  a streaming agent writes many times a second */
export const REFRESH_AFTER_WRITE_MS = 15_000
/** frames purged mid-render — a pending create must not re-persist them */
const dead = new Set<string>()
/** renders in flight per frame: `dead` is lifted once they settle, so an
 *  undo restoring the frame does not inherit the tombstone */
const pendingByFrame = new Map<string, number>()
/** a stage render is the whole frame; a very tall page is clipped to ~4 MP
 *  of output, which the frame's box shows only the top of anyway */
const STAGE_PREVIEW_PIXELS = 4_000_000

const suffix = (v: ThumbVariant) => (v.kind === 'card' ? '' : `-w${v.width}.${v.ext}`)
const slot = (frameId: string, v: ThumbVariant) => frameId + suffix(v)
const keyFor = (frameId: string, v: ThumbVariant) =>
  v.kind === 'card' ? `thumb/${frameId}.jpg` : `thumb/${frameId}-w${v.width}.${v.ext}`
const versionKey = (frameId: string, v: ThumbVariant, version: number) =>
  keyFor(frameId, v).replace(/\.(jpg|png)$/, `-v${version}.$1`)
const designOf = (frame: Frame) =>
  createHash('sha256')
    .update(JSON.stringify([frame.html, frame.width, frame.height]))
    .digest('hex')
const mimeOf = (v: ThumbVariant) => (v.kind === 'stage' && v.ext === 'png' ? 'image/png' : 'image/jpeg')
/* the same marker the client checks (src/lib/drawing.ts isCanvasElement) */
const CANVAS_ELEMENT_RE = /<body\b[^>]*\bdata-doop-canvas-element=/i

/* Freshness survives restarts: the `written` and `designAt` maps are kept
   next to the objects they describe, so bucket and disk storage behave the
   same and no schema is involved. Each render persists its version and
   fingerprint before resolving. A lost ledger cannot label old bytes fresh. */
const LEDGER_KEY = 'thumb/_freshness.json'
interface FreshnessLedger {
  written: Record<string, number>
  design: Record<string, number>
  fingerprints: Record<string, string>
}
let ledgerReady: Promise<void> | undefined
let ledgerDirty = false
let ledgerSaving: Promise<void> | undefined
let ledgerTimer: ReturnType<typeof setTimeout> | undefined

/** Resolved once the ledger has been read (or found absent/unreadable). */
function ensureLedger(): Promise<void> {
  return (ledgerReady ??= storage
    .getObject(LEDGER_KEY)
    .then((buf) => {
      if (!buf) return
      const data = JSON.parse(buf.toString()) as Partial<FreshnessLedger>
      for (const [k, v] of Object.entries(data.written ?? {}))
        if (typeof v === 'number') written.set(k, Math.max(written.get(k) ?? 0, v))
      for (const [k, v] of Object.entries(data.fingerprints ?? {}))
        if (typeof v === 'string' && !designs.has(k)) designs.set(k, v)
      for (const [k, v] of Object.entries(data.design ?? {}))
        if (typeof v === 'number') designAt.set(k, Math.max(designAt.get(k) ?? 0, v))
    })
    .catch((e) => console.error('thumb freshness ledger unreadable, revalidating previews:', e)))
}

export const freshnessReady = ensureLedger

/** Persist the maps now; concurrent saves coalesce into one write. */
async function saveLedger(): Promise<void> {
  await ensureLedger()
  ledgerDirty = true
  if (!ledgerSaving) {
    ledgerSaving = (async () => {
      while (ledgerDirty) {
        ledgerDirty = false
        const body = Buffer.from(
          JSON.stringify({
            written: Object.fromEntries(written),
            design: Object.fromEntries(designAt),
            fingerprints: Object.fromEntries(designs),
          } satisfies FreshnessLedger),
        )
        await storage.putObject(LEDGER_KEY, body, 'application/json')
      }
    })()
      .catch((e) => console.error('thumb freshness ledger save failed:', e))
      .finally(() => {
        ledgerSaving = undefined
      })
  }
  return ledgerSaving
}

function saveLedgerSoon(): void {
  ledgerDirty = true
  if (ledgerTimer) return
  ledgerTimer = setTimeout(() => {
    ledgerTimer = undefined
    void saveLedger()
  }, 1500)
  ledgerTimer.unref?.()
}

/** Wait for pending saves (tests). */
export async function flushLedger(): Promise<void> {
  if (ledgerTimer) {
    clearTimeout(ledgerTimer)
    ledgerTimer = undefined
    void saveLedger()
  }
  await ledgerSaving
}

/* Deletes of derived objects are bounded four at a time: dropping a canvas
   can queue thousands of them, and an unthrottled fan-out of S3 calls
   stalls the room. */
const DELETE_CONCURRENCY = 4
const deleteQueue: string[] = []
let deleting = 0

function queueDelete(key: string): void {
  deleteQueue.push(key)
  drainDeletes()
}

function drainDeletes(): void {
  while (deleting < DELETE_CONCURRENCY && deleteQueue.length) {
    const key = deleteQueue.shift()!
    deleting++
    void storage
      .deleteObject(key)
      .catch(() => {})
      .finally(() => {
        deleting--
        drainDeletes()
      })
  }
}

/** The stage variants known to be stored (rendered here or recorded in the
 *  ledger) or asked for: the delete list for purge/invalidate. */
function knownVariants(frameId: string): ThumbVariant[] {
  const askedV = asked.get(frameId)
  const out: ThumbVariant[] = []
  for (const width of FRAME_PREVIEW_WIDTHS)
    for (const ext of ['jpg', 'png'] as const) {
      const v: ThumbVariant = { kind: 'stage', width, ext }
      if (written.has(slot(frameId, v)) || askedV?.has(suffix(v))) out.push(v)
    }
  return out
}

/* lazy like every other screenshot.ts consumer (dev never pays for
   puppeteer-core until the first render), but single-flight */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))

/** The preview render, cheap and at background priority: a tile or a
 *  zoomed-out canvas can wait, an agent's screenshot should not. */
function render(frame: Frame, v: ThumbVariant): Promise<CreatedThumb> {
  return withRenderSlot(async () => {
    const { renderFrame } = await loadScreenshot()
    /* the html is read when the render starts, not when it was queued, and
       the version it shows is the one it read: `frame` is the live record */
    const source = { ...(await store.renderSource(frame)) }
    const renderedAt = source.updatedAt
    const design = designOf(source)
    /* a revision a script run wrote renders offline — script markup can
       name remote assets the checks were blocked from fetching, and the
       automatic refresh is the same boundary */
    const offline = isScriptWrittenRevision(source)
    const buf =
      v.kind === 'card'
        ? await renderFrame(source, Math.min(1, 640 / source.width), {
            type: 'jpeg',
            quality: 70,
            maxHeight: PREVIEW_MAX_HEIGHT,
            priority: 'background',
            ...(offline ? { offline: true } : {}),
          })
        : await renderFrame(source, previewScale(source.width, v.width), {
            type: v.ext === 'png' ? 'png' : 'jpeg',
            quality: 75,
            omitBackground: v.ext === 'png' && CANVAS_ELEMENT_RE.test(source.html),
            maxHeight: Math.ceil(STAGE_PREVIEW_PIXELS / (v.width * previewScale(source.width, v.width))),
            priority: 'background',
            ...(offline ? { offline: true } : {}),
          })
    return { buf, renderedAt, design }
  })
}

/** Render now, persist, and return the bytes with the version they show.
 *  Deduped per frame and variant; rejects on render failure (the caller
 *  decides what a failed render means). */
export function create(frame: Frame, v: ThumbVariant = CARD): Promise<CreatedThumb> {
  const at = slot(frame.id, v)
  const inflight = pending.get(at)
  if (inflight) return inflight
  lastAttempt.set(at, Date.now())
  pendingByFrame.set(frame.id, (pendingByFrame.get(frame.id) ?? 0) + 1)
  const p = ensureLedger()
    .then(() => render(frame, v))
    .then(async ({ buf, renderedAt, design }) => {
      /* the process saw no design write for this frame: the html drawn is no
       older than the render, so this render IS the last known design */
      if (!dead.has(frame.id) && !designAt.has(frame.id)) designAt.set(frame.id, renderedAt)
      /* persist is best-effort: a bucket hiccup must not fail the response
       that only needed the bytes */
      try {
        if (!dead.has(frame.id)) {
          const key = versionKey(frame.id, v, renderedAt)
          const previous = written.get(at)
          await storage.putObject(key, buf, mimeOf(v))
          /* purge may have run during the put — its delete can land before
           our write finishes, so re-check and clean up our own orphan */
          if (dead.has(frame.id)) queueDelete(key)
          else {
            written.set(at, renderedAt)
            designs.set(at, design)
            await saveLedger()
            if (previous !== undefined && previous !== renderedAt) queueDelete(versionKey(frame.id, v, previous))
          }
        }
      } catch (e) {
        console.error(`thumb persist failed for ${frame.id}:`, e)
      }
      return { buf, renderedAt, design }
    })
  pending.set(at, p)
  p.catch(() => {}).finally(() => {
    pending.delete(at)
    const left = (pendingByFrame.get(frame.id) ?? 1) - 1
    if (left <= 0) {
      pendingByFrame.delete(frame.id)
      dead.delete(frame.id)
    } else pendingByFrame.set(frame.id, left)
  })
  return p
}

/** Whether `renderedAt` shows the frame's current design: nothing newer
 *  than the last design write this process knows of (its own updatedAt
 *  when none was seen — conservative after a restart without a ledger). */
export function freshAt(frame: Frame, renderedAt: number): boolean {
  return renderedAt >= (designAt.get(frame.id) ?? frame.updatedAt)
}

/** Whether the preview stored for `frame` shows its current design. */
function isFresh(frame: Frame, v: ThumbVariant): boolean {
  const renderedAt = written.get(slot(frame.id, v))
  return renderedAt !== undefined && freshAt(frame, renderedAt)
}

/** The stored preview, if there is one. When it is stale — or its
 *  freshness is unknown after a restart — a background re-render is kicked
 *  off (throttled, deduped, errors logged and swallowed) and the stored
 *  bytes are returned anyway: stale beats blank. Returns null when nothing
 *  is stored yet. */
export async function getStored(frame: Frame, v: ThumbVariant = CARD): Promise<StoredThumb | null> {
  const at = slot(frame.id, v)
  const source = await store.renderSource(frame)
  if (v.kind === 'stage') remember(source, v)
  await ensureLedger()
  let buf: Buffer | null
  try {
    const version = written.get(at)
    buf = await storage.getObject(version === undefined ? keyFor(frame.id, v) : versionKey(frame.id, v, version))
  } catch (e) {
    console.error(`thumb read failed for ${frame.id}:`, e)
    return null
  }
  if (!buf) {
    /* the map claimed fresh but the object is gone (manual purge, new
       bucket) — forget, so the caller falls through to a live render */
    if (written.delete(at)) saveLedgerSoon()
    return null
  }
  /* Compare against persisted HTML too: a process may stop after saving a
     design edit but before its notification reaches the ledger. Position
     and updatedAt are deliberately absent from this fingerprint. */
  const matches = designs.get(at) === designOf(source)
  const fresh = matches && isFresh(frame, v)
  const throttled = Date.now() - (lastAttempt.get(at) ?? 0) < MIN_REVALIDATE_MS
  if (!fresh && !throttled && !pending.has(at))
    create(frame, v).catch((e) => console.error(`thumb revalidate failed for ${frame.id}:`, e))
  return { buf, fresh }
}

/** Note a stage variant a viewer asked for, so a later write refreshes it
 *  ahead of the next zoom-out. `png` only counts once the frame's html
 *  shows a standalone element — anything else asks jpeg. */
export function remember(frame: Frame, v: ThumbVariant): void {
  if (v.kind !== 'stage') return
  if (v.ext === 'png' && !CANVAS_ELEMENT_RE.test(frame.html)) return
  const now = Date.now()
  let variants = asked.get(frame.id)
  if (!variants) asked.set(frame.id, (variants = new Map()))
  for (const [key, entry] of variants) if (now - entry.at > ASKED_TTL_MS) variants.delete(key)
  variants.set(suffix(v), { v, at: now })
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
  const variants = asked.get(frameId)
  if (!variants) return
  for (const [key, entry] of variants) if (Date.now() - entry.at > ASKED_TTL_MS) variants.delete(key)
  if (!variants.size) {
    asked.delete(frameId)
    return
  }
  clearTimeout(refreshTimers.get(frameId))
  const timer = setTimeout(() => {
    refreshTimers.delete(frameId)
    const current = store.getFrame(frameId)
    if (!current || dead.has(frameId)) return
    const now = Date.now()
    for (const { v, at } of asked.get(frameId)?.values() ?? []) {
      if (now - at > ASKED_TTL_MS || isFresh(current, v)) continue
      create(current, v).catch((e) => console.error(`thumb refresh failed for ${frameId}:`, e))
    }
  }, REFRESH_AFTER_WRITE_MS)
  timer.unref?.()
  refreshTimers.set(frameId, timer)
}

/** Follow frame writes for the freshness of stored previews. Called once at
 *  boot; returns the unsubscribe. */
export function followFrameWrites(): () => void {
  void ensureLedger()
  return store.onFrameWrite((write) => {
    if (write.kind === 'write') noteDesignWrite(write.frameId)
  })
}

function forgetVariants(frameId: string): string[] {
  const keys = [keyFor(frameId, CARD)]
  for (const v of knownVariants(frameId)) {
    const version = written.get(slot(frameId, v))
    if (version !== undefined) keys.push(versionKey(frameId, v, version))
    written.delete(slot(frameId, v))
    designs.delete(slot(frameId, v))
    lastAttempt.delete(slot(frameId, v))
    keys.push(keyFor(frameId, v))
  }
  const cardVersion = written.get(frameId)
  if (cardVersion !== undefined) keys.push(versionKey(frameId, CARD, cardVersion))
  designs.delete(frameId)
  written.delete(frameId)
  lastAttempt.delete(frameId)
  saveLedgerSoon()
  return keys
}

/** The frame lives on but its stored previews are wrong (a restyle rewrote
 *  its html): drop them — the next ask re-renders. Unlike `purge` the frame
 *  is not dead: it can persist previews again. */
export function invalidate(frameId: string): void {
  for (const key of forgetVariants(frameId)) queueDelete(key)
}

/** Frame (or its whole canvas) is gone — drop the derived objects too, so the
 *  thumb folder holds only live frames. Best-effort fire-and-forget. */
export function purge(frameId: string): void {
  dead.add(frameId)
  designAt.delete(frameId)
  scriptWritten.delete(frameId)
  clearTimeout(refreshTimers.get(frameId))
  refreshTimers.delete(frameId)
  for (const key of forgetVariants(frameId)) queueDelete(key)
  asked.delete(frameId)
  /* `dead` only guards renders in flight when the frame went away; once
     they settle the id is free again — an undo can restore the frame */
  if (!pendingByFrame.has(frameId)) dead.delete(frameId)
}
