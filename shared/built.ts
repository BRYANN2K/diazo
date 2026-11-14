import { classifyDriftUrl } from './drift.ts'

/**
 * Built page: a preview deploy tells doop which routes it shipped, and each
 * route is captured onto the canvas's "Built" page, beside a snapshot of the
 * frame it was designed as, with the drift score between the two. The
 * deploy's webhook is signed with a per-canvas secret (server/built.ts) the
 * same way doop signs its own outbound webhooks (docs/webhooks.md).
 */

/** The page the captures land on, created on the first delivery. */
export const BUILT_PAGE_NAME = 'Built'
/** Routes one delivery may list — each one is a full-page capture. */
export const BUILT_MAX_ROUTES = 20
/** A delivery's X-Doop-Timestamp may be this far from the server's clock. */
export const BUILT_SIGNATURE_TOLERANCE_MS = 5 * 60_000
/** Capture width for a route no designed frame claims. */
export const BUILT_DEFAULT_WIDTH = 1440
/** Gap between the designed snapshot and the shipped capture, and between rows. */
export const BUILT_GAP_X = 80
export const BUILT_GAP_Y = 160
/** Longest route path accepted, and the stored route → frame mappings. */
export const BUILT_MAX_ROUTE_LENGTH = 300
export const BUILT_MAX_MAPPINGS = 100

/** One route as the deploy lists it: a path, optionally naming its frame. */
export interface BuiltRouteInput {
  path: string
  /** a frame id or a frame name; overrides the stored mapping and the name match */
  frame?: string
}

export interface BuiltPayload {
  deployUrl: string
  routes: BuiltRouteInput[]
  commit?: string
  branch?: string
}

export type BuiltRouteStatus = 'captured' | 'failed'

/** What happened to one route in a delivery. */
export interface BuiltRouteResult {
  route: string
  url: string
  status: BuiltRouteStatus
  /** the designed frame the route was matched to, and how */
  designFrameId?: string
  designFrameName?: string
  matchedBy?: 'payload' | 'mapping' | 'name'
  /** the shipped capture on the Built page */
  builtFrameId?: string
  /** the drift comparison recorded for the pair, and its score */
  comparisonId?: string
  score?: number
  /** canvas link that opens the drift compare on the designed frame */
  driftUrl?: string
  error?: string
}

export interface BuiltDelivery {
  id: string
  at: number
  deployUrl: string
  commit?: string
  branch?: string
  status: 'running' | 'done'
  routes: BuiltRouteResult[]
}

/** A stored route → designed frame mapping, with the frame's current name. */
export interface BuiltMapping {
  route: string
  frameId: string
  frameName?: string
}

/** The canvas's deploy hook as the settings card sees it. The secret is
 *  never part of it: it leaves the server once, when created or rotated. */
export interface BuiltHookInfo {
  id: string
  canvasId: string
  /** where the deploy POSTs */
  endpoint: string
  createdBy: string
  createdAt: number
  mappings: BuiltMapping[]
  lastDelivery?: BuiltDelivery
}

/** The canvas link that opens the drift compare of `frameId` on `comparisonId`. */
export function builtDriftPath(canvasId: string, frameId: string, comparisonId: string): string {
  return `/c/${encodeURIComponent(canvasId)}?frame=${encodeURIComponent(frameId)}&drift=${encodeURIComponent(comparisonId)}`
}

/** A route path in its canonical form — a rooted path with its query, no
 *  fragment, no trailing slash past the root — or null when it is not one. */
export function normalizeRoute(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.length > BUILT_MAX_ROUTE_LENGTH) return null
  if (/[\s<>"'\\]/.test(path)) return null
  let url: URL
  try {
    url = new URL(path, 'https://route.invalid')
  } catch {
    return null
  }
  if (url.host !== 'route.invalid') return null
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname
  return `${pathname}${url.search}`
}

/** The names a route answers to when matched against frame names:
 *  `/` → home/index/landing, `/docs/getting-started` → "docs getting
 *  started" and "getting started". Lowercased, punctuation folded. */
export function routeNameKeys(route: string): string[] {
  const path = route.split('?')[0] ?? '/'
  if (path === '/') return ['home', 'index', 'landing', '/']
  const segments = path.split('/').filter(Boolean).map(decodeSegment)
  const keys = [nameKey(segments.join(' ')), nameKey(segments[segments.length - 1] ?? ''), nameKey(path)]
  return [...new Set(keys.filter(Boolean))]
}

/** A frame name folded the way routeNameKeys folds routes, with a trailing
 *  "page" / "screen" dropped: "Pricing page" and "/pricing" meet. */
export function frameNameKey(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '/') return '/'
  return nameKey(trimmed).replace(/ (?:page|screen|view)$/, '')
}

function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export type BuiltPayloadResult = { ok: true; payload: BuiltPayload } | { ok: false; status: 400 | 422; error: string }

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

/** Validates a delivery body: an http(s) deploy URL the server may reach
 *  (drift's classification — local addresses need the desktop, which a
 *  deploy pipeline does not have), and 1..BUILT_MAX_ROUTES rooted routes,
 *  deduplicated in their canonical form. */
export function parseBuiltPayload(body: unknown): BuiltPayloadResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'the body must be a JSON object' }
  }
  const input = body as Record<string, unknown>
  const deployUrl = typeof input.deployUrl === 'string' ? input.deployUrl.trim() : ''
  if (!deployUrl || deployUrl.length > 2048) return { ok: false, status: 400, error: 'deployUrl required' }
  const kind = classifyDriftUrl(deployUrl)
  if (kind.kind === 'invalid') return { ok: false, status: 400, error: `deployUrl: ${kind.reason}` }
  if (kind.kind === 'local') {
    return {
      ok: false,
      status: 422,
      error: 'deployUrl is a local address — only public preview deploys can be captured from a webhook',
    }
  }
  if (!Array.isArray(input.routes) || input.routes.length === 0) {
    return { ok: false, status: 400, error: 'routes must list at least one path' }
  }
  if (input.routes.length > BUILT_MAX_ROUTES) {
    return { ok: false, status: 400, error: `at most ${BUILT_MAX_ROUTES} routes per delivery` }
  }
  const routes: BuiltRouteInput[] = []
  const seen = new Set<string>()
  for (const item of input.routes) {
    const raw = typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.path
    const path = normalizeRoute(raw)
    if (!path) return { ok: false, status: 400, error: `not a rooted route path: ${String(raw).slice(0, 80)}` }
    if (seen.has(path)) continue
    seen.add(path)
    const frame = typeof item === 'object' && item ? text((item as Record<string, unknown>).frame, 120) : undefined
    routes.push({ path, ...(frame ? { frame } : {}) })
  }
  const commit = text(input.commit, 80)
  const branch = text(input.branch, 120)
  return {
    ok: true,
    payload: { deployUrl, routes, ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) },
  }
}

/** The page URL a route is captured at: the route appended to the deploy's
 *  own path (a deploy served under `/repo/` keeps its prefix), which must
 *  stay on the deploy's origin. */
export function routeUrl(deployUrl: string, route: string): URL {
  const base = new URL(deployUrl)
  const prefix = base.pathname.replace(/\/+$/, '')
  const url = new URL(`${prefix}${route}`, base.origin)
  if (url.origin !== base.origin) throw new Error('the route leaves the deploy’s origin')
  return url
}

/** Mappings as the settings card's textarea shows them: one
 *  `<route> <frame name>` per line. */
export function formatBuiltMappings(mappings: BuiltMapping[]): string {
  return mappings.map((m) => `${m.route} ${m.frameName ?? m.frameId}`).join('\n')
}

/** The textarea back into `{ route, frame }` pairs: the first word is the
 *  route, the rest of the line the frame name (or id). Blank lines drop. */
export function parseBuiltMappings(text: string): { route: string; frame: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.search(/\s/)
      return space === -1
        ? { route: line, frame: '' }
        : { route: line.slice(0, space), frame: line.slice(space + 1).trim() }
    })
}
