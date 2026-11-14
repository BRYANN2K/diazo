import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  BUILT_DEFAULT_WIDTH,
  BUILT_GAP_X,
  BUILT_GAP_Y,
  BUILT_MAX_MAPPINGS,
  BUILT_PAGE_NAME,
  BUILT_SIGNATURE_TOLERANCE_MS,
  builtDriftPath,
  frameNameKey,
  normalizeRoute,
  routeNameKeys,
  routeUrl,
  type BuiltDelivery,
  type BuiltHookInfo,
  type BuiltPayload,
  type BuiltRouteInput,
  type BuiltRouteResult,
} from '../shared/built.ts'
import { canvasImageHtml } from '../shared/canvasImage.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { storeAsset } from './assets.ts'
import { db } from './db/index.ts'
import { builtHooks, type BuiltCaptureRecord } from './db/schema.ts'
import { driftDeps, saveComparison, type DriftDeps } from './drift.ts'
import { env } from './env.ts'
import { store } from './store.ts'

/**
 * Built page (shared/built.ts): a preview deploy POSTs the routes it shipped,
 * signed with the canvas's hook secret. Each route is captured through the
 * drift engine (server/drift.ts: same renderer, same SSRF guards, same pixel
 * score) onto the canvas's "Built" page, next to a snapshot of the frame it
 * was designed as, and the pair is recorded as a drift comparison. The hook
 * remembers which frames hold which route, so a re-delivery rewrites them in
 * place rather than stacking duplicates.
 */

export type BuiltHookRow = typeof builtHooks.$inferSelect

/* ------------------------------------------------------------------ */
/* the hook                                                            */
/* ------------------------------------------------------------------ */

const newSecret = () => `bhsec_${nanoid(32)}`

export async function getHook(canvasId: string): Promise<BuiltHookRow | undefined> {
  const [row] = await db.select().from(builtHooks).where(eq(builtHooks.canvasId, canvasId))
  return row
}

/** Create the canvas's hook, or issue a new secret for the existing one.
 *  The secret leaves the server here and nowhere else. */
export async function issueHook(canvasId: string, userId: string): Promise<{ row: BuiltHookRow; secret: string }> {
  const secret = newSecret()
  const existing = await getHook(canvasId)
  if (existing) {
    await db.update(builtHooks).set({ secret }).where(eq(builtHooks.canvasId, canvasId))
    return { row: { ...existing, secret }, secret }
  }
  const row: BuiltHookRow = {
    canvasId,
    id: nanoid(10),
    secret,
    mappings: {},
    captures: {},
    builtPageId: null,
    lastDelivery: null,
    createdBy: userId,
    createdAt: Date.now(),
  }
  await db.insert(builtHooks).values(row)
  return { row, secret }
}

/** Revocation is deletion: the next delivery gets a 404. The Built page
 *  and its frames stay — they are canvas content now. */
export async function deleteHook(canvasId: string): Promise<boolean> {
  const gone = await db.delete(builtHooks).where(eq(builtHooks.canvasId, canvasId)).returning({ id: builtHooks.id })
  return gone.length > 0
}

export class BuiltInputError extends Error {}

/** Replace the stored route → frame mappings. `frame` is a frame id or a
 *  frame name on this canvas; an unknown one refuses the whole set. */
export async function setMappings(
  canvas: Canvas,
  input: { route: string; frame: string }[],
): Promise<Record<string, string>> {
  if (input.length > BUILT_MAX_MAPPINGS) throw new BuiltInputError(`at most ${BUILT_MAX_MAPPINGS} mappings`)
  const mappings: Record<string, string> = {}
  const unknown: string[] = []
  for (const { route, frame } of input) {
    const path = normalizeRoute(route)
    if (!path) throw new BuiltInputError(`not a rooted route path: ${route.slice(0, 80)}`)
    const target = findFrame(canvas.frames, frame)
    if (!target) unknown.push(frame)
    else mappings[path] = target.id
  }
  if (unknown.length) throw new BuiltInputError(`no frame named ${unknown.map((n) => `“${n}”`).join(', ')}`)
  const updated = await db
    .update(builtHooks)
    .set({ mappings })
    .where(eq(builtHooks.canvasId, canvas.id))
    .returning({ id: builtHooks.id })
  if (!updated.length) throw new BuiltInputError('this canvas has no deploy hook yet')
  return mappings
}

export async function saveDelivery(
  canvasId: string,
  patch: { captures?: Record<string, BuiltCaptureRecord>; builtPageId?: string; lastDelivery: BuiltDelivery },
): Promise<void> {
  await db.update(builtHooks).set(patch).where(eq(builtHooks.canvasId, canvasId))
}

export function hookEndpoint(canvasId: string): string {
  return `${env.BETTER_AUTH_URL}/api/canvases/${encodeURIComponent(canvasId)}/built`
}

export function hookInfo(row: BuiltHookRow, canvas: Canvas): BuiltHookInfo {
  return {
    id: row.id,
    canvasId: row.canvasId,
    endpoint: hookEndpoint(row.canvasId),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    mappings: Object.entries(row.mappings ?? {}).map(([route, frameId]) => {
      const name = canvas.frames.find((f) => f.id === frameId)?.name
      return { route, frameId, ...(name ? { frameName: name } : {}) }
    }),
    ...(row.lastDelivery ? { lastDelivery: row.lastDelivery } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* signatures                                                          */
/* ------------------------------------------------------------------ */

/** The same scheme doop's outbound webhooks sign with (docs/webhooks.md):
 *  HMAC-SHA256 over `<timestamp>.<raw body>`, hex, prefixed `sha256=`. */
export function signBuilt(secret: string, timestamp: number | string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`
}

/** Why a delivery's signature does not hold, or null when it does. */
export function signatureProblem(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  body: Buffer,
  now = Date.now(),
): string | null {
  const timestamp = headers.timestamp?.trim() ?? ''
  if (!/^\d{10,16}$/.test(timestamp)) return 'X-Doop-Timestamp (milliseconds since the epoch) is required'
  if (Math.abs(now - Number(timestamp)) > BUILT_SIGNATURE_TOLERANCE_MS) {
    return 'X-Doop-Timestamp is too far from the server clock — sign each delivery when you send it'
  }
  const given = Buffer.from(headers.signature?.trim() ?? '')
  const expected = Buffer.from(signBuilt(secret, timestamp, body))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'the signature does not match'
  return null
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

function findFrame(frames: Frame[], ref: string): Frame | undefined {
  const byId = frames.find((f) => f.id === ref)
  if (byId) return byId
  const name = ref.trim().toLowerCase()
  return frames.find((f) => f.name.trim().toLowerCase() === name)
}

/** The designed frame a route stands for: the frame the delivery names,
 *  else the stored mapping, else a frame whose name reads like the route.
 *  Frames on the Built page and the hook's own captures never count. */
export function matchDesignFrame(
  canvas: Canvas,
  route: BuiltRouteInput,
  mappings: Record<string, string>,
  options: { builtPageId?: string | null; excluded?: ReadonlySet<string> } = {},
): { frame: Frame; by: 'payload' | 'mapping' | 'name' } | undefined {
  const candidates = canvas.frames.filter(
    (f) => !options.excluded?.has(f.id) && !(options.builtPageId && framePageId(canvas, f) === options.builtPageId),
  )
  if (route.frame) {
    const named = findFrame(candidates, route.frame)
    if (named) return { frame: named, by: 'payload' }
  }
  const mapped = mappings[route.path]
  const mappedFrame = mapped ? candidates.find((f) => f.id === mapped) : undefined
  if (mappedFrame) return { frame: mappedFrame, by: 'mapping' }
  for (const key of routeNameKeys(route.path)) {
    const byName = candidates.find((f) => frameNameKey(f.name) === key)
    if (byName) return { frame: byName, by: 'name' }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* the delivery                                                        */
/* ------------------------------------------------------------------ */

export interface BuiltDeps extends Pick<DriftDeps, 'capture' | 'renderDesign' | 'score' | 'assertPublic' | 'now'> {
  storeAsset: typeof storeAsset
  saveComparison: typeof saveComparison
}

export const builtDeps: BuiltDeps = {
  capture: driftDeps.capture,
  renderDesign: driftDeps.renderDesign,
  score: driftDeps.score,
  assertPublic: driftDeps.assertPublic,
  now: driftDeps.now,
  storeAsset,
  saveComparison,
}

export interface DeliveryState {
  captures: Record<string, BuiltCaptureRecord>
  mappings: Record<string, string>
  builtPageId: string | null
}

export interface DeliveryOutcome {
  captures: Record<string, BuiltCaptureRecord>
  builtPageId: string
  delivery: BuiltDelivery
}

/** The Built page: the one the hook remembers, else one named "Built",
 *  else a new one. */
export function ensureBuiltPage(canvasId: string, remembered: string | null, actor: Actor): string {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new Error('the canvas is gone')
  const pages = canvasPages(canvas)
  const kept = remembered ? pages.find((p) => p.id === remembered) : undefined
  if (kept) return kept.id
  const named = pages.find((p) => p.name.trim().toLowerCase() === BUILT_PAGE_NAME.toLowerCase())
  if (named) return named.id
  const created = actions.createCanvasPage(canvasId, BUILT_PAGE_NAME, actor)
  if (!created) throw new Error('the Built page could not be created')
  return created.page.id
}

/** Where the next new row starts: under everything already on the page. */
function nextRowY(canvas: Canvas, pageId: string): number {
  const onPage = canvas.frames.filter((f) => framePageId(canvas, f) === pageId)
  if (!onPage.length) return 0
  return Math.max(...onPage.map((f) => f.y + f.height)) + BUILT_GAP_Y
}

const liveFrame = (canvasId: string, id: string | undefined) => {
  const frame = id ? store.getFrame(id) : undefined
  return frame && frame.canvasId === canvasId ? frame : undefined
}

/** Write an image into the frame that already holds it, or a new frame. */
function placeOrUpdate(
  canvasId: string,
  existing: Frame | undefined,
  image: { url: string; width: number; height: number; name: string },
  placement: { pageId: string; x: number; y: number },
  actor: Actor,
): Frame | undefined {
  const html = canvasImageHtml(image.url, image.name)
  if (existing) {
    return actions.updateFrame(
      existing.id,
      { html, name: image.name, width: image.width, height: image.height },
      actor,
      { replace: true },
    )
  }
  return actions.createFrame(
    canvasId,
    {
      name: image.name,
      pageId: placement.pageId,
      x: placement.x,
      y: placement.y,
      width: image.width,
      height: image.height,
      html,
    },
    actor,
    { reveal: false },
  )
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}

/** One route: capture → design snapshot → frames on the Built page → score
 *  → drift record. Throws with a message the delivery report shows. */
async function deliverRoute(
  input: {
    canvasId: string
    pageId: string
    route: BuiltRouteInput
    deployUrl: string
    state: DeliveryState
    excluded: ReadonlySet<string>
    actor: Actor
    ownerId: string
  },
  deps: BuiltDeps,
): Promise<{ result: BuiltRouteResult; record: BuiltCaptureRecord }> {
  const { canvasId, pageId, route, actor } = input
  const url = routeUrl(input.deployUrl, route.path)
  const result: BuiltRouteResult = { route: route.path, url: url.href, status: 'failed' }
  try {
    await deps.assertPublic(url)
  } catch (error) {
    const message = failure(error)
    throw new Error(
      /not reachable/.test(message)
        ? 'the deploy resolves to a private address — the server cannot capture it'
        : `the URL could not be resolved — ${message}`,
      { cause: error },
    )
  }
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new Error('the canvas is gone')
  const match = matchDesignFrame(canvas, route, input.state.mappings, {
    builtPageId: pageId,
    excluded: input.excluded,
  })
  const design = match?.frame
  const width = design ? Math.max(1, Math.round(design.width)) : BUILT_DEFAULT_WIDTH
  const capture = await deps.capture(url, width, {})

  const assetMeta = { canvasId, ownerId: input.ownerId, uploadedBy: actor.name }
  const shippedAsset = await deps.storeAsset(capture.png, { mime: 'image/png', ext: 'png' }, assetMeta)
  let designPng: Buffer | undefined
  let score: Awaited<ReturnType<BuiltDeps['score']>> | undefined
  if (design) {
    /* the snapshot and the score are extras: a design that will not render
       still leaves the shipped capture and its row */
    try {
      designPng = await deps.renderDesign(design)
      score = await deps.score(designPng, capture.png)
    } catch {
      designPng = undefined
      score = undefined
    }
  }

  const previous = input.state.captures[route.path]
  const oldBuilt = liveFrame(canvasId, previous?.builtFrameId)
  const oldSnapshot = liveFrame(canvasId, previous?.designSnapshotFrameId)
  const rowY = oldBuilt?.y ?? nextRowY(canvas, pageId)
  const builtX = oldBuilt?.x ?? (design ? width + BUILT_GAP_X : 0)
  const built = placeOrUpdate(
    canvasId,
    oldBuilt,
    {
      url: `${env.BETTER_AUTH_URL}/a/${shippedAsset.id}.${shippedAsset.ext}`,
      width: capture.width,
      height: capture.height,
      name: `Built — ${route.path}`.slice(0, 80),
    },
    { pageId, x: builtX, y: rowY },
    actor,
  )
  if (!built) throw new Error('the capture could not be placed — was the Built page deleted?')

  /* from here on the capture exists: a failure below is reported on the
     route but never loses the record, or the next delivery would place a
     second capture beside the first */
  let snapshot = oldSnapshot
  let comparisonId: string | undefined
  try {
    if (design && designPng) {
      const designAsset = await deps.storeAsset(designPng, { mime: 'image/png', ext: 'png' }, assetMeta)
      snapshot =
        placeOrUpdate(
          canvasId,
          oldSnapshot,
          {
            url: `${env.BETTER_AUTH_URL}/a/${designAsset.id}.${designAsset.ext}`,
            width,
            height: Math.max(1, Math.round(design.height)),
            name: `Designed — ${design.name}`.slice(0, 80),
          },
          /* left of the capture, whichever column the capture sits in now */
          { pageId: framePageId(canvas, built), x: built.x - width - BUILT_GAP_X, y: built.y },
          actor,
        ) ?? oldSnapshot
    }
    if (design) {
      const comparison = await deps.saveComparison({
        id: nanoid(12),
        canvasId,
        frameId: design.id,
        shippedFrameId: built.id,
        url: url.href,
        finalUrl: capture.finalUrl,
        ...(score ? { score: score.score, diffPixels: score.diffPixels, totalPixels: score.totalPixels } : {}),
        via: 'server',
        source: 'webhook',
        requestedBy: actor.name,
        createdAt: deps.now(),
      })
      comparisonId = comparison.id
    }
  } catch (error) {
    result.error = failure(error)
  }

  Object.assign(result, {
    status: 'captured',
    builtFrameId: built.id,
    ...(design ? { designFrameId: design.id, designFrameName: design.name, matchedBy: match!.by } : {}),
    ...(comparisonId ? { comparisonId } : {}),
    ...(score ? { score: score.score } : {}),
    ...(design && comparisonId
      ? { driftUrl: `${env.BETTER_AUTH_URL}${builtDriftPath(canvasId, design.id, comparisonId)}` }
      : {}),
  })
  const record: BuiltCaptureRecord = {
    builtFrameId: built.id,
    ...(design ? { designFrameId: design.id } : {}),
    ...(snapshot ? { designSnapshotFrameId: snapshot.id } : {}),
    ...(comparisonId ? { comparisonId } : {}),
    updatedAt: deps.now(),
  }
  return { result, record }
}

/** Every route of a delivery, one after the other (each is a full browser
 *  capture). A failing route is reported and skipped; the rest still land. */
export async function runDelivery(
  input: {
    canvasId: string
    delivery: BuiltDelivery
    payload: BuiltPayload
    state: DeliveryState
    actor: Actor
    ownerId: string
  },
  deps: BuiltDeps = builtDeps,
): Promise<DeliveryOutcome> {
  const { canvasId, payload, actor } = input
  const pageId = ensureBuiltPage(canvasId, input.state.builtPageId, actor)
  const captures = { ...input.state.captures }
  const excluded = new Set(
    Object.values(captures).flatMap((c) => [
      c.builtFrameId,
      ...(c.designSnapshotFrameId ? [c.designSnapshotFrameId] : []),
    ]),
  )
  const routes: BuiltRouteResult[] = []
  for (const route of payload.routes) {
    try {
      const { result, record } = await deliverRoute(
        {
          canvasId,
          pageId,
          route,
          deployUrl: payload.deployUrl,
          state: { ...input.state, captures },
          excluded,
          actor,
          ownerId: input.ownerId,
        },
        deps,
      )
      captures[route.path] = record
      excluded.add(record.builtFrameId)
      if (record.designSnapshotFrameId) excluded.add(record.designSnapshotFrameId)
      routes.push(result)
    } catch (error) {
      let url = payload.deployUrl
      try {
        url = routeUrl(payload.deployUrl, route.path).href
      } catch {
        /* the report keeps the deploy URL */
      }
      routes.push({ route: route.path, url, status: 'failed', error: failure(error) })
    }
  }
  return { captures, builtPageId: pageId, delivery: { ...input.delivery, status: 'done', routes } }
}

export function newDelivery(payload: BuiltPayload, now: number): BuiltDelivery {
  return {
    id: `bld_${nanoid(12)}`,
    at: now,
    deployUrl: payload.deployUrl,
    ...(payload.commit ? { commit: payload.commit } : {}),
    ...(payload.branch ? { branch: payload.branch } : {}),
    status: 'running',
    routes: [],
  }
}

/* Deliveries for one canvas run one at a time: two deploys landing together
   must not both decide a route is new and place it twice. */
const queues = new Map<string, Promise<unknown>>()

export function enqueue<T>(canvasId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(canvasId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  const tail = next.catch(() => {})
  queues.set(canvasId, tail)
  void tail.then(() => {
    if (queues.get(canvasId) === tail) queues.delete(canvasId)
  })
  return next
}
