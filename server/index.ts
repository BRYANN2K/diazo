import { registerSpeechRoutes } from './speechRoutes.ts'
import { registerBlenderRoutes } from './blenderRoutes.ts'
import { queueServerRender, renderAccess } from './motionRender.ts'
import { recoverSpeechJobs } from './speechJobs.ts'
import { recoverBlenderOps } from './blenderOps.ts'
import { scriptRunDeps, pruneScriptRuns } from './scriptRuns.ts'
import * as libraries from './libraries.ts'
import * as libraryThumbQueue from './libraryThumbQueue.ts'
import * as libraryIndex from './libraryIndex.ts'
import { libraryRouter } from './libraryRoutes.ts'
import { curationRouter } from './libraryCurationRoutes.ts'
import { wireLibraryDescribe } from './libraryDescribe.ts'
import { hydrateCurations, resumeCurations } from './libraryCuration.ts'
import { resumeApplies } from './libraryCurationApply.ts'
import { env } from './env.ts'
import {
  catalogEntry,
  changeInstances,
  componentDetail,
  ComponentError,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  findComponent,
  findComponentCandidates,
  importComponent,
  insertInstance,
  restoreComponentVersion,
  syncComponent,
  updateComponent,
} from './componentActions.ts'
import { z } from 'zod'
import { previewDocument } from './componentPreview.ts'
import { codeSchema, propSchema } from './componentTools.ts'
import { canvasPages, framePageId, pageFrames, samePages } from '../shared/pages.ts'
import { canvasOpenedOn, frameHtmlBatches, MAX_LOAD_FRAME_IDS, openingPageId } from '../shared/frameHtml.ts'
import { normalizePageBackground } from '../shared/pageBackground.ts'
import { MAX_STACK_WRITES, type StackWrite } from '../shared/frameStack.ts'
import { normalizeRotation } from '../shared/frameRotation.ts'
import { lintDocKey } from '../shared/lintDocument.ts'
import type { CommentAnchorInput } from '../shared/comments.ts'
import type { LocaleConfig } from '../shared/locales.ts'
import { FIRST_CANVAS_PATH, SIGNUP_PARAM, parseSignupMethod } from '../shared/firstCanvas.ts'
import { localAgentRouter, handleLocalAgentMcp, wake as wakeUserWork } from './localAgent.ts'
import { FrameHtmlNotLoadedError } from './frameHtml.ts'
import { deleteLink, linkFor, localRepo, localRepoRouter, putLink } from './localRepo.ts'
import {
  applyDeviceReport,
  buildDevTaskBrief,
  cancelDevTask,
  createDevTask,
  devTaskFor,
  devTasksForCanvas,
  failStaleDevTasks,
  wireDevTasks,
} from './devTasks.ts'
import { DEV_TASK_AGENTS, DEV_TASK_SUMMARY_CHARS } from '../shared/devTasks.ts'
import { CodeLinkError, deleteCodeLink, listCodeLinks, putCodeLink } from './codeLinks.ts'
import { suggestCodeLinks } from './codeSuggest.ts'
import { applyRepoTokens, previewTokenPatch, previewTokenSync, TokenSyncError } from './tokenSync.ts'
import { applyRepoPatch, checkPatch, RepoPatchError } from './repoPatch.ts'
import { PATCH_MAX_BYTES } from '../shared/patch.ts'
import { FRAME_CODE_FRAMEWORKS, FrameCodeError } from './frameToCode.ts'
import { frameCodePatch } from './frameCodePatch.ts'
import {
  CODE_LINK_KINDS,
  CODE_LINK_MAX_EXPORT,
  CODE_LINK_MAX_PATH,
  CODE_LINK_SOURCES,
  isCodeLinkKind,
} from '../shared/codeLinks.ts'
import { localDriftRouter } from './driftBridge.ts'
import * as built from './built.ts'
import { BUILT_BODY_LIMIT, handleBuiltDelivery } from './builtRoutes.ts'
import { compareFrameWithUrl, driftErrorMessage, getComparison, listComparisons } from './drift.ts'
import { classifyDriftUrl } from '../shared/drift.ts'
import { usageReport } from './agentRuns.ts'
import { toolCallReport } from './toolCalls.ts'
import { RollbackConflictError, rollbackRun, runTimeline } from './runReplay.ts'
import { DuelInputError, listDuels, pickDuel, startDuel, startMotionDuel } from './duels.ts'
import { handleGeminiCloudMcp } from './geminiCloudMcp.ts'
import { geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import compression from 'compression'
import { eq, inArray } from 'drizzle-orm'
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node'
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { WebSocketServer, WebSocket } from 'ws'
import { GuideLimitError, maxPages, PageLimitError, store } from './store.ts'
import { parseGuide } from '../shared/guides.ts'
import { getImage } from './previews.ts'
import { followFrameWrites } from './thumbs.ts'
import { parsePreviewWidth } from '../shared/framePreview.ts'
import * as actions from './actions.ts'
import { checkAndStore } from './frameChecks.ts'
import { liveActivitiesRouter, logLiveActivityRequests, startLiveActivityDelivery } from './liveActivities.ts'
import { onCanvasEvent } from './events.ts'
import * as imageDescriptions from './imageDescriptions.ts'
import * as commentNotifications from './commentNotifications.ts'
import { notificationsRouter } from './notifications.ts'
import * as webhooks from './webhooks.ts'
import { webhooksRouter } from './webhookRoutes.ts'
import { fontsRouter } from './fontRoutes.ts'
import { AvatarInputError, clearAvatar, setAvatar } from './avatars.ts'
import { MAX_AVATAR_BYTES, avatarUrl } from '../shared/avatar.ts'
import { FontInputError, addFont, fontsForCanvas, hydrateFonts } from './fonts.ts'
import { fontUploaded } from './fontUpload.ts'
import { MAX_FONT_BYTES } from '../shared/fonts.ts'
import { MAX_TOKEN_VALUE, TOKEN_TYPES, tokensCss, tokensMarkdown, tokensTailwind } from '../shared/designTokens.ts'
import {
  canEditCanvas,
  canManageCanvas,
  canvasRole,
  guestCanvasRole,
  hasDurableCanvasAccess,
  isAdmin,
  roomMessageNeeds,
} from './access.ts'
import { isLinkAccess, roleAllows, type CanvasRole } from '../shared/canvasRole.ts'
import { auth, initAuth, syncAdmins, getUserName, isBanned, loginProvidersConfig } from './auth.ts'
import { getInstanceSettings, hydrateInstanceSettings, loginPolicy } from './instanceSettings.ts'
import { adminRouter } from './admin.ts'
import { buildInfo } from './buildInfo.ts'
import { maySeeUpdates, updateStatus } from './updateCheck.ts'
import { communityRouter, parseListing, publishableFrames } from './community.ts'
import { automationsRouter, startScheduler } from './automations.ts'
import { startMcpTokenPrune } from './mcpTokens.ts'
import { integrationsRouter, relayDesktopCallback } from './integrations.ts'
import { extensions } from './extensions.ts'
import * as workspaces from './workspaces.ts'
import * as billing from './billing.ts'
import * as demo from './demo.ts'
import { db, initDb } from './db/index.ts'
import { resealSecrets } from './secretBackfill.ts'
import { encryptionConfigured } from './secretBox.ts'
import * as authSchema from './db/auth-schema.ts'
import * as persist from './db/persist.ts'
import { handleMcpRequest } from './mcp.ts'
import { RendererBusyError } from './renderBrowser.ts'
import {
  getAsset,
  reconcileAssetRefs,
  beginTicketUpload,
  endTicketUpload,
  createAsset,
  storeAsset,
  MAX_ASSET_BYTES,
} from './assets.ts'
import {
  cancelRenderJob,
  createRenderJob,
  finishRenderJob,
  getRenderJob,
  initRenderJobs,
  listRenderJobs,
  patchRenderJob,
  wireRenderJobs,
} from './motionJobs.ts'
import { nanoid } from 'nanoid'
import { MOTION_LIMITS, parseCompositionBody, parseOps } from '../shared/motion.ts'
import {
  compositionToHyperframes,
  compositionToLottie,
  hyperframesToTracks,
  lottieToTracks,
} from '../shared/motionInterchange.ts'
import { parseMediaBody } from '../shared/motionMedia.ts'
import { exportComposition } from './motionTools.ts'
import { placeImage, placedImageResult } from './placeImage.ts'
import * as ingest from './ingest.ts'
import * as agentKeys from './agentKeys.ts'
import * as backgrounds from './backgrounds.ts'
import * as storage from './storage.ts'
import * as github from './github.ts'
import * as githubApp from './githubApp.ts'
import { seed } from './seed.ts'
import * as allowance from './allowance.ts'
import * as modelAccounts from './modelAccounts.ts'
import { getLocalAgentPreference } from './localAgentPreferences.ts'
import { serverTierInfo } from './agentModel.ts'
import { imageModelAvailability, serverImageGenEnabled } from './imageGen.ts'
import { setImagePref } from './imagePrefs.ts'
import { accountsView, catalogForAccount, listRunners } from './agentRunners.ts'
import { CustomProviderError, discoverCustomModels, takeProbeSlot, testCustomProvider } from './customProviders.ts'
import { CustomProviderUrlError, customProvidersEnabled, reachableUrl } from './customProviderFetch.ts'
import {
  isCustomProviderKind,
  normalizeBaseUrl,
  parseCustomHeaders,
  parseCustomKey,
  parseCustomProviderConfig,
  CUSTOM_API_TYPES,
} from '../shared/customProvider.ts'
import { setStoredDefault } from './agentDefaults.ts'
import { getAcpPreference } from './acpAgentPreferences.ts'
import { acpAgentOf, isAcpRunnerProvider } from '../shared/acpAgent.ts'
import { isRunnerProvider, parseRunnerPick } from '../shared/agentRunner.ts'
import { findInCanvas } from './canvasFind.ts'
import { findInLibrary } from './libraryQueries.ts'
import type { CanvasFindResult } from '../shared/canvasFind.ts'
import * as library from './referenceLibrary.ts'
import { mentionedRole } from '../shared/agents.ts'
import { cleanChatPlan, isOpenPlan } from '../shared/chat.ts'
import { activeAgentTasks } from '../shared/agentActivity.ts'
import { colorFor } from '../shared/types.ts'
import { isPeerViewport } from '../shared/viewport.ts'
import { exportScaleSuffix, fitExportScale, parseExportScale } from '../shared/exportScale.ts'
import { emailShare } from './canvasShares.ts'
import * as userEvents from './userEvents.ts'
import type { Canvas, ChatMessage, ClientMessage, Frame, Presence, ServerMessage } from '../shared/types.ts'

const PORT = env.PORT

/* Identifies the client bundle this process serves. Hashing dist/index.html
   works because Vite writes hashed asset names into it — any frontend change
   changes the hash, while server-only deploys and plain restarts do not.
   Clients compare it across reconnects to know their loaded bundle is stale. */
const BUILD_ID = (() => {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(process.cwd(), 'dist', 'index.html')))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'dev'
  }
})()

/* boot: connect the DB, hydrate memory, import pre-DB store.json once */
await initDb()
await backgrounds.initBackgrounds()
initAuth()
await syncAdmins() // ADMIN_EMAILS -> user.role, for accounts that already exist
let data = await persist.hydrate()
if (data.canvases.length === 0 && (await persist.importLegacyJson())) {
  data = await persist.hydrate()
}
store.init(data.canvases)
await workspaces.hydrateWorkspaces() // before the first request: canvasRole reads membership
await libraries.hydrateLibraries() // canvas.library, before the first canvas is sent
libraries.wireLibraries()
void libraries.purgeDisabledLibraries().catch((error: unknown) => console.error('[libraries] purge failed', error))
libraryIndex.wireIndexer()
/* stored frame previews go stale on a design write, and the stage images
   someone looked at re-render ahead of the next zoom-out (thumbs.ts) */
followFrameWrites()
wireLibraryDescribe() // AI descriptions, only on libraries that turned them on
/* full index runs a restart cut off go on in the background */
void Promise.all(libraryIndex.resumeIndexing(libraries.allLibraries()))
/* thumbnails missing from storage: after each index run, and once at boot
   for every library already indexed */
libraryIndex.onLibraryIndexed((canvasId) => libraryThumbQueue.schedulePrewarm(canvasId))
libraryThumbQueue.prewarmAtBoot(
  libraries
    .allLibraries()
    .filter((record) => record.indexState?.status === 'done')
    .map((record) => record.canvasId),
)
await hydrateCurations() // AI library curations; the ones a restart cut off go on
resumeCurations()
resumeApplies()
await hydrateInstanceSettings() // the sign-in policy, read on every signup
await webhooks.hydrateWebhooks()
await recoverSpeechJobs()
await recoverBlenderOps()
await hydrateFonts() // before the first request: frame writes add the faces they use
billing.reportBillingConfig()
actions.hydrateLogs(data)
/* render jobs the restart orphaned are already marked failed by hydrate;
   the in-memory pool mirrors the table for the REST routes */
initRenderJobs(data.renderJobs)
seed()

/* Never-attempted queued cards get their first pickup after boot. Hydration
   marks interrupted claimed cards as failed, so they are excluded until a
   human explicitly retries them. */
{
  const pending = [...data.tasks.entries()]
    .filter(([, list]) => list.some((t) => t.queuedBy && !t.agentName && !t.endedAt))
    .map(([canvasId]) => canvasId)
  pending.forEach((canvasId, i) => {
    setTimeout(
      () => {
        import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
      },
      5_000 + i * 30_000,
    )
  })
  if (pending.length) console.log(`[resident] ${pending.length} canvas(es) with new queued cards — starting after boot`)
}

/* asset bookkeeping (no deletion): every upload records its canvas, and
   asset_refs tracks which frames reference which assets — kept in sync on
   every durable frame write, rebuilt here from the stored frames. Nothing
   is ever deleted; asset_refs is the ledger any future cleanup would be
   built on. */
reconcileAssetRefs()
  .then((n) => n && console.log(`[assets] reconciled ${n} asset ref(s)`))
  .catch((e) => console.error('[assets] reconcile failed', e))
/* image descriptions for agents: recover the backlog and listen for new assets. */
void imageDescriptions.startImageDescriptions(broadcast)

/* One stray rejection must never take down the multiplayer server: Node's
   default is to exit, which turned a single aborted analytics upload into
   sitewide 502s (2026-08-20). Log loudly instead — a real bug shows up here
   as a stack trace, not an outage. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason)
})

/* flush debounced frame writes before the process dies — with a hard-exit
   timeout so a wedged DB can never keep the process (and the port) alive */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 1500).unref()
    persist
      .flush((id) => store.getFrame(id))
      .catch((err) => console.error('flush on shutdown failed', err))
      .finally(() => process.exit(0))
  })
}

/* ------------------------------------------------- realtime rooms */

interface Conn {
  ws: WebSocket
  canvasId: string
  /** the session's user — the role is re-read from it on every message, so
   *  a link changed mid-visit takes effect without a reconnect. Unset for a
   *  signed-out guest on a link-shared canvas. */
  userId?: string
  presence: Presence
  /** an admin viewing as someone else: receives updates, emits nothing.
   *  Showing their borrowed identity as a live cursor would tell the room
   *  the owner is here when they aren't. */
  silent?: boolean
}

/* What a signed-out guest is not sent: the team's conversation (comments,
   agent tasks and their feedback, the activity feed) and its memory. A guest
   sees the frames; the rest is for people with an account. */
const GUEST_HIDDEN: ReadonlySet<ServerMessage['type']> = new Set([
  'task',
  'feedback',
  'comment',
  'activity',
  'decision',
  'proposal',
  'reference',
  'guidelines',
  'skill',
  /* an agent's status line is its task's summary (setAgentStatus) */
  'status',
] satisfies ServerMessage['type'][])

/** A presence as a guest sees it: without the status line, which carries
 *  the same task summary GUEST_HIDDEN keeps from them. */
function guestPresence<P extends Presence>({ status: _status, ...presence }: P): Omit<P, 'status'> {
  return presence
}

/** A room message as a guest may see it, or null when it is withheld. */
function forGuest(msg: ServerMessage): ServerMessage | null {
  if (GUEST_HIDDEN.has(msg.type)) return null
  return msg.type === 'presence:join' ? { ...msg, presence: guestPresence(msg.presence) } : msg
}

const conns = new Map<WebSocket, Conn>()

function room(canvasId: string): Conn[] {
  return [...conns.values()].filter((c) => c.canvasId === canvasId)
}

/** A changed profile photo reaches every room the person is in: their
 *  presence is re-announced with the new face (a join for a known clientId
 *  is an update on the client). */
function refreshPresenceImage(userId: string, image: string | undefined): void {
  for (const conn of conns.values()) {
    if (conn.userId !== userId || conn.silent) continue
    conn.presence = { ...conn.presence, image }
    broadcast(conn.canvasId, { type: 'presence:join', presence: conn.presence }, conn.presence.clientId)
  }
}

/** The live role of one room connection (null once access is gone). */
function connRole(conn: Conn): CanvasRole | null {
  const canvas = store.getCanvas(conn.canvasId)
  if (!canvas) return null
  return conn.userId ? canvasRole(conn.userId, canvas) : guestCanvasRole(canvas)
}

/* After a share-link change: everyone in the room learns their new role (the
   editor goes read-only, or back), and anyone left with no access at all is
   disconnected rather than kept on the live feed. */
function refreshRoomRoles(canvasId: string) {
  for (const conn of room(canvasId)) {
    const role = connRole(conn)
    if (!role) {
      conn.ws.close(4403, 'no access')
      continue
    }
    send(conn.ws, { type: 'role', role })
    /* the room now drops this visitor's editing messages, including the one
       that would clear their badge, so clear it for them */
    if (!roleAllows(role, 'edit') && conn.presence.activeFrameId) {
      conn.presence.activeFrameId = null
      broadcast(canvasId, { type: 'editing', clientId: conn.presence.clientId, frameId: null }, conn.presence.clientId)
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(canvasId: string, msg: ServerMessage, excludeClientId?: string) {
  for (const c of room(canvasId)) {
    if (excludeClientId && c.presence.clientId === excludeClientId) continue
    const shown = c.userId ? msg : forGuest(msg)
    if (shown) send(c.ws, shown)
  }
}

/* Agents show up in presence while they are actively calling tools. */
interface AgentPresence extends Presence {
  lastSeen: number
}
const agentPresences = new Map<string, Map<string, AgentPresence>>() // canvasId -> name -> presence

function agentTouch(
  canvasId: string,
  agentName: string,
  frameId?: string | null,
  status?: string | null,
  owner?: string,
) {
  let byName = agentPresences.get(canvasId)
  if (!byName) agentPresences.set(canvasId, (byName = new Map()))
  let p = byName.get(agentName)
  const isNew = !p
  if (!p) {
    p = {
      clientId: `agent:${agentName}`,
      name: agentName,
      color: colorFor(agentName),
      kind: 'agent',
      owner,
      lastSeen: Date.now(),
      activeFrameId: frameId ?? null,
    }
    byName.set(agentName, p)
  }
  p.lastSeen = Date.now()
  if (owner && !p.owner) p.owner = owner
  if (frameId !== undefined) p.activeFrameId = frameId
  let statusChanged = false
  if (status !== undefined) {
    const next = status?.trim() || undefined
    if (p.status !== next) {
      p.status = next
      statusChanged = true
    }
  }
  if (isNew) {
    broadcast(canvasId, { type: 'presence:join', presence: p })
  } else {
    if (frameId !== undefined) {
      broadcast(canvasId, { type: 'editing', clientId: p.clientId, frameId: p.activeFrameId ?? null })
    }
    if (statusChanged) {
      broadcast(canvasId, { type: 'status', clientId: p.clientId, status: p.status ?? null })
    }
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [canvasId, byName] of agentPresences) {
    for (const [name, p] of byName) {
      /* an agent with a posted status is likely thinking between tool calls —
         keep it (and its status) on screen longer before expiring */
      if (now - p.lastSeen > (p.status ? 60_000 : 20_000)) {
        byName.delete(name)
        broadcast(canvasId, { type: 'presence:leave', clientId: p.clientId })
        actions.endAgentTasks(canvasId, p.name) // an agent that went silent is no longer "working on" anything
      }
    }
  }
}, 5000)

actions.wire(broadcast, agentTouch)
wireDevTasks(broadcast)
/* a `queued` dev task's launch job lives in this process's memory — after a
   restart nothing can claim it, so it is failed like an expired one */
void failStaleDevTasks()
setInterval(() => void failStaleDevTasks(), 60_000).unref()
wireRenderJobs(broadcast)
/* after the room has been told: email for the people who were not in it */
onCanvasEvent(commentNotifications.onCanvasEvent)
onCanvasEvent(webhooks.onCanvasEvent)
onCanvasEvent(imageDescriptions.onCanvasEvent)

/* ------------------------------------------------- http api */

const app = express()

/* Railway/Fly terminate TLS in front of us; trust the proxy so req.protocol
   and secure cookies see https, and OAuth metadata echoes the right origin */
app.set('trust proxy', 1)

app.get('/healthz', (_req, res) => res.json({ ok: true }))

/* how many canvases have their frame HTML in memory (store.load / evictIdle) */
app.get('/healthz/store', (_req, res) => {
  res.json(store.stats())
})
/* The headless renderer's counters, for an uptime check that alerts when
   renders stop (kills climbing, a queue that never drains). Lazy, so a boot
   never pays for puppeteer-core just to answer it. */
app.get('/healthz/renderer', async (_req, res) => {
  const { rendererStatus } = await import('./screenshot.ts')
  res.json(rendererStatus())
})

/* ------------------------------------------------------------------ */
/* PostHog relay: the client sends analytics + session-replay traffic  */
/* to this origin (/relay/...) and we forward it, so ad blockers that  */
/* match PostHog's domains never see a request to block. Mounted       */
/* before express.json — replay payloads are compressed binary and     */
/* must pass through untouched. Cookies are stripped: our auth session */
/* must not leak to a third party.                                     */
/* ------------------------------------------------------------------ */

const PH_INGEST = env.POSTHOG_INGEST_HOST
const PH_ASSETS = env.POSTHOG_ASSETS_HOST
const PH_DROP_HEADERS = new Set(['host', 'connection', 'cookie', 'content-length', 'accept-encoding'])

app.use('/relay', async (req, res) => {
  /* /static/* is PostHog's CDN (lazy bundles, toolbar); everything else
     (/e, /s, /flags, /array) is the ingestion API */
  const upstream = req.url.startsWith('/static/') ? PH_ASSETS : PH_INGEST

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && !PH_DROP_HEADERS.has(k)) headers[k] = v
  }
  /* keep the incoming XFF chain — its first entry is the real client IP
     and PostHog geolocates from it. Overwriting with req.ip would send
     Railway's edge-PoP address instead (trust proxy only strips one hop).
     Fall back to req.ip when there is no chain (local dev). */
  if (!headers['x-forwarded-for'] && req.ip) headers['x-forwarded-for'] = req.ip

  try {
    /* the body read must sit inside the try: navigating away mid-upload
       aborts big session-replay POSTs, which rejects this stream — left
       uncaught, that single abort would take down the whole process */
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    const r = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    /* accept-encoding was stripped, so the body is identity — but drop
       length/encoding headers anyway and let Express size the response */
    res.status(r.status)
    r.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding' && k !== 'connection')
        res.set(k, v)
    })
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch {
    /* analytics must never surface errors to the app */
    if (!res.headersSent) res.status(502)
    res.end()
  }
})

/* ------------------------------------------------------------------ */
/* Public frame images: /i/<frameId>.png|jpg — shareable/hotlinkable   */
/* (og:image etc). Unauthenticated by the same unguessable-id logic as */
/* canvas share links; renders the CURRENT frame, so embedded images   */
/* stay up to date as the design iterates. Caching, rate limiting and  */
/* render dispatch live in previews.ts — this route is HTTP only.      */
/* ------------------------------------------------------------------ */

/** A full render queue is a 503 with Retry-After, not a 500: the renderer is
 *  healthy, only busy, and the client should come back in a few seconds. */
function sendRenderFailure(res: express.Response, error: unknown, fallback = 'render failed') {
  if (error instanceof RendererBusyError) {
    res.set('Retry-After', '10')
    return res.status(503).json({ error: error.message })
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : fallback })
}

app.get('/i/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  if (ext !== 'png' && ext !== 'jpg') return res.status(404).end()
  /* metadata only: a cached image needs no html, and a render reads the
     one frame's html when it starts (store.renderableFrame) */
  const frame = store.getFrame(id)
  if (!frame) return res.status(404).end()

  /* any multiplier the export picker offers; a missing or unreadable one
     is 1x, as before there was a picker */
  const scale = fitExportScale(frame, parseExportScale(req.query.scale) ?? 1)
  /* ?lod=<width> — a stage image (shared/framePreview.ts), one of a few widths */
  const lod = req.query.lod === undefined ? undefined : parsePreviewWidth(req.query.lod)
  if (lod === null) return res.status(400).json({ error: 'unknown preview width' })
  let result: Awaited<ReturnType<typeof getImage>>
  try {
    result = await getImage(frame, {
      ext,
      scale,
      lod,
      quality: Math.min(100, Math.max(1, Number(req.query.quality) || 90)),
      /* ?preview — the dashboard-card variant; see previews.ts */
      preview: req.query.preview !== undefined,
      ip: req.ip ?? 'unknown',
      /* the render limit targets anonymous hotlink abuse — a logged-in user
         loading a dashboard of many canvases shouldn't hit it (and behind
         the Railway proxy many users can share one req.ip). Only called
         when the budget is exhausted, so cached serves stay auth-free. */
      isAuthenticated: async () =>
        !!(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)),
    })
  } catch (e) {
    return sendRenderFailure(res, e)
  }
  if (result.status === 'rate-limited') {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'render rate limit — cached URLs are unaffected' })
  }
  const { buf } = result

  res.set('Content-Type', (result.ext ?? ext) === 'jpg' ? 'image/jpeg' : 'image/png')
  if (result.fresh === false) {
    /* an older design while the current one renders: the stage asks again */
    res.set('Cache-Control', 'no-store')
    res.set('X-Doop-Preview', 'stale')
  } else if (lod && req.query.v === String(frame.updatedAt)) {
    /* the URL names the version it shows, so it never changes */
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
  } else res.set('Cache-Control', 'public, max-age=60')
  if (req.query.download !== undefined) {
    const safe = frame.name.replace(/[^\w\- ]+/g, '').trim() || 'frame'
    res.set('Content-Disposition', `attachment; filename="${safe}${exportScaleSuffix(scale)}.${ext}"`)
  }
  res.send(buf)
})

/* ------------------------------------------------------------------ */
/* Uploaded assets: /a/<assetId>.<ext> — written once by the upload_asset */
/* MCP tool, immutable thereafter, so far-future caching is safe. Public  */
/* by the same unguessable-id logic as /i/ (frame HTML embedding these    */
/* URLs renders for anyone who can see the canvas).                       */
/* ------------------------------------------------------------------ */

app.get('/a/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  try {
    const found = await getAsset(id)
    if (!found || found.meta.ext !== ext) return res.status(404).end()
    res.set('Content-Type', found.meta.mime)
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('X-Content-Type-Options', 'nosniff')
    /* Fonts load with CORS from sandboxed frames with opaque origins.
       Assets are public by unguessable id. */
    res.set('Access-Control-Allow-Origin', '*')
    /* svg can script when opened as a document — neuter it; <img> embeds
       are unaffected */
    if (found.meta.mime === 'image/svg+xml')
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    if (req.query.download !== undefined) res.set('Content-Disposition', `attachment; filename="${id}.${ext}"`)
    res.send(found.buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'asset fetch failed' })
  }
})

/* Curated background library (server/backgrounds.ts): /bg/<id>.webp and  */
/* /bg/<id>-t.webp straight from object storage. Public and immutable —  */
/* the catalog is checked in, the bytes are put there by the import      */
/* script and never rewritten under the same id.                         */
app.get('/bg/:file', async (req, res) => {
  const key = backgrounds.keyForFile(req.params.file)
  if (!key) return res.status(404).end()
  try {
    const buf = await storage.getObject(key)
    if (!buf) return res.status(404).end()
    res.set('Content-Type', 'image/webp')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('X-Content-Type-Options', 'nosniff')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'background fetch failed' })
  }
})

/* ------------------------------------------------------------------ */
/* One-time asset uploads: the upload_asset MCP tool mints a ticket and */
/* the agent curls the file here (curl -T file /u/<token>), so bytes    */
/* go disk -> doop without ever passing through the model. Mounted      */
/* before express.json — the body IS the file. The token is the         */
/* capability: unguessable, single-use, 15-minute TTL.                  */
/* ------------------------------------------------------------------ */

app.put('/u/:token', async (req, res) => {
  const { token } = req.params
  const ticket = beginTicketUpload(token)
  if (!ticket)
    return res.status(410).json({
      error:
        'invalid, expired or already-used upload ticket — request a new one via the upload_asset or upload_font tool',
    })
  let success = false
  try {
    /* on any early rejection, destroy the request stream — otherwise curl
       keeps sending a body nobody reads and the connection deadlocks */
    const { font } = ticket
    const limit = font ? MAX_FONT_BYTES : MAX_ASSET_BYTES
    const tooBig = { error: `file exceeds the ${limit / 1024 / 1024} MB limit` }
    if (Number(req.headers['content-length'] || 0) > limit) {
      res.status(413).json(tooBig)
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).length
      if (total > limit) {
        res.status(413).json(tooBig)
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const buf = Buffer.concat(chunks)
    if (font) {
      /* addFont asks again whether the uploader may still change the library */
      try {
        const added = await addFont(font.scope, font.user, buf, font.fileName)
        success = true
        return res.json(fontUploaded(added, font.scope))
      } catch (e) {
        if (e instanceof FontInputError) return res.status(400).json({ error: e.message })
        console.error('[fonts] ticket upload failed', e)
        return res.status(500).json({ error: 'the font could not be saved — try again' })
      }
    }
    const asset = await createAsset(buf, {
      canvasId: ticket.canvasId,
      ownerId: ticket.ownerId,
      uploadedBy: ticket.uploadedBy,
    })
    success = true
    const url = `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`
    const uploaded = { ok: true, url, mime: asset.mime, size_bytes: asset.size, usage: `<img src="${url}" alt="">` }
    const { place, canvasId } = ticket
    if (!place || !canvasId)
      return res.json({ ...uploaded, note: 'Permanent public URL — reference it in frame HTML.' })
    /* the ticket was minted with edit access, up to 15 minutes ago: placing
       changes the canvas, so access is asked again now that the bytes are here */
    const frame = await store.withCanvas(canvasId, async (canvas) =>
      canvas && canEditCanvas(ticket.ownerId, canvas)
        ? placeImage(canvasId, { url, buf, mime: asset.mime }, place.placement, place.actor)
        : undefined,
    )
    res.json({ ...uploaded, ...placedImageResult(frame) })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
  } finally {
    endTicketUpload(token, success)
  }
})

/* better-auth handles /api/auth/* — mounted before express.json (it reads
   the raw body itself) and before the session gate below. Being mounted
   earlier means it also escapes the read-only rule on /api, so an admin
   who is viewing as someone else is filtered here instead:
     - the MCP OAuth flow authorises off the browser session, so it would
       mint a long-lived agent token belonging to the person being viewed,
       outliving the 15-minute view-as session entirely;
     - every other write (update-user, change-email, revoke-sessions, …)
       would edit the account of the person being viewed while the banner
       says "read only".
   An allowlist, not a blocklist: whatever endpoints a future better-auth
   plugin adds are refused by default rather than discovered later. */
const MCP_OAUTH_PATHS = /^\/api\/auth\/(mcp\/|oauth2\/(authorize|consent|token))/
const VIEW_AS_ALLOWED = /^\/api\/auth\/(sign-out|admin\/stop-impersonating)$/
app.all('/api/auth/*', async (req, res, next) => {
  /* Admin → Sign-in turned email/password sign-up off: the form is hidden,
     and the call it would make is refused too. Sign-in, password resets and
     provider sign-ups go on as before. */
  if (req.path === '/api/auth/sign-up/email' && !getInstanceSettings().emailPasswordSignup) {
    return res
      .status(403)
      .json({ code: 'SIGNUP_DISABLED', message: 'Sign-up with email and password is off on this instance.' })
  }
  const restricted = MCP_OAUTH_PATHS.test(req.path) || (req.method !== 'GET' && !VIEW_AS_ALLOWED.test(req.path))
  if (restricted) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
    if (session && (session.session as { impersonatedBy?: string | null }).impersonatedBy) {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
  }
  toNodeHandler(auth)(req, res).catch(next)
})

/* Stripe webhooks: the signature covers the exact bytes, so this route takes
   the raw body and sits ahead of the JSON parser; no session — Stripe is the
   caller. Everything it does is in server/workspaces.ts. */
app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  workspaces.handleStripeWebhook(req, res).catch((err) => {
    console.error('[billing] webhook crashed', err)
    if (!res.headersSent) res.status(500).json({ error: 'webhook handling failed' })
  })
})

for (const extension of extensions) {
  if (extension.webhookRouter) app.use(`/webhooks/${extension.id}`, extension.webhookRouter())
}

/* Built page deliveries (server/builtRoutes.ts): a preview deploy's signed
   POST. Ahead of the JSON parser — the signature covers the raw bytes — and
   of the session gate, since the signature is the credential. */
app.post('/api/canvases/:id/built', express.raw({ type: () => true, limit: BUILT_BODY_LIMIT }), (req, res) => {
  handleBuiltDelivery(req, res).catch((err) => {
    console.error('[built] delivery crashed', err)
    if (!res.headersSent) res.status(500).json({ error: 'delivery failed' })
  })
})

app.use(express.json({ limit: '10mb' }))
app.all('/gemini-cloud/mcp/:id', (req, res, next) => {
  handleGeminiCloudMcp(req, res).catch(next)
})
app.all('/local-agent/mcp/:id', (req, res, next) => {
  handleLocalAgentMcp(req, res).catch(next)
})

/* Where a brand-new account lands: the canvas signup created for it
   (server/auth.ts databaseHooks), where the demo agent is waiting to
   perform. better-auth sends new Google / Microsoft / SSO users here as
   their newUserCallbackURL and the email form comes here too, so every
   signup path shares one landing. Signed out, or without a canvas of their
   own any more, the dashboard will do. Ahead of the /api session guard:
   a browser arrives here, so a missing session is a redirect, not a 401. */
app.get(FIRST_CANVAS_PATH, async (req, res) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  /* ?connect=1 rides along: the lifecycle emails link here with a static URL
     and the canvas page opens the Connect AI modal on it. Signed out (an
     email opened in a fresh browser), the login page gets this URL as its
     redirect_to, so the destination survives the sign-in. The bare path
     keeps sending a signed-out browser to the dashboard as before. */
  const connect = req.query.connect === '1' ? '?connect=1' : ''
  if (!session)
    return res.redirect(connect ? `/?redirect_to=${encodeURIComponent(`${FIRST_CANVAS_PATH}${connect}`)}` : '/')
  /* ?signup=<method>: a provider sign-in that just created this account
     (src/pages/AuthPage.tsx). It rides on to wherever the account lands so
     the app can report the signup with its method, then drops it. */
  const method = typeof req.query[SIGNUP_PARAM] === 'string' ? parseSignupMethod(req.query[SIGNUP_PARAM]) : null
  const landing = new URLSearchParams(connect.slice(1))
  if (method) landing.set(SIGNUP_PARAM, method)
  const query = landing.size ? `?${landing}` : ''
  const canvas = store.firstCanvasOf(session.user.id)
  res.redirect(canvas ? `/c/${canvas.id}${query}` : `/${query}`)
})

/* Public: does an account exist for this email? Drives the login page's
   "no account found — sign up instead" prompt. Existence is already
   observable through signup's "user already exists" error, so this
   endpoint reveals nothing new. */
app.post('/api/account-exists', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const [row] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  res.json({ exists: !!row })
})

/* Public: is SSO configured, and what should the login button say? Static
   build shared across self-hosted deploys can't know this at build time —
   see server/auth.ts loginProvidersConfig for what's safe to expose here. */
app.get('/api/oidc-config', (req, res) => {
  const providers = loginProvidersConfig()
  res.json({ ...providers, ...loginPolicy(providers.enabled) })
})

/* Public: which build is running (version, commit, build date). No secrets;
   the update check (server/updateCheck.ts) compares this commit with the
   repository's. */
app.get('/api/version', (_req, res) => {
  res.json(buildInfo())
})

/* Public: the interface language for visitors who have not picked one. The
   client asks before its first render, so sign-in already speaks it. */
app.get('/api/locale-config', (_req, res) => {
  const config: LocaleConfig = { defaultLocale: env.DEFAULT_LOCALE }
  res.json(config)
})

/* ------------------------------------------------------------------ */
/* Design sync ingest: the doop-sync snippet on a foreign origin posts */
/* DOM snapshots here. The canvas-scoped write-only secret in the path */
/* is the whole credential (no cookies), so this stays outside the     */
/* /api session gate and answers its own CORS preflight. The route-    */
/* level parser also accepts text/plain — that's what sendBeacon      */
/* sends when a page unloads mid-capture.                              */
/* ------------------------------------------------------------------ */

app.options('/ingest/:key', (_req, res) => {
  ingest.setIngestCors(res)
  res.status(204).end()
})

app.post('/ingest/:key', express.json({ limit: '10mb', type: () => true }), (req, res) => {
  ingest.handleIngest(req, res).catch((err) => {
    console.error('[ingest] failed', err)
    if (!res.headersSent) res.status(500).json({ error: 'sync failed' })
  })
})

/* ------------------------------------------------------------------ */
/* CI drift hook (server/drift.ts): an agent key posts the deploy's     */
/* preview URL for a frame and gets the same designed-vs-shipped        */
/* comparison the in-app action runs. Mounted before the session gate — */
/* the key IS the credential, like /ingest.                             */
/* ------------------------------------------------------------------ */

const driftWebhookHits = new Map<string, number[]>()

app.post('/api/canvases/:id/drift', async (req, res) => {
  const bearer = /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
  if (!agentKeys.isAgentKeySecret(bearer)) {
    return res.status(401).json({ error: 'an agent key is required (Authorization: Bearer dpk_…)' })
  }
  const verified = await agentKeys.verifyAgentKey(bearer)
  const userId = verified?.userId
  if (!userId) return res.status(401).json({ error: 'invalid agent key' })
  if (await isBanned(userId)) return res.status(403).json({ error: 'this account is suspended' })
  const now = Date.now()
  const hits = (driftWebhookHits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= env.DRIFT_WEBHOOKS_PER_MIN) {
    return res
      .status(429)
      .json({ error: `rate limited — at most ${env.DRIFT_WEBHOOKS_PER_MIN} drift comparisons a minute` })
  }
  hits.push(now)
  driftWebhookHits.set(userId, hits)
  /* the loadFirst middleware sits behind the session gate, so this route
     brings its canvas into memory itself */
  await store.load(req.params.id)
  res.once('close', store.hold(req.params.id))
  const canvas = store.getCanvas(req.params.id)
  if (!canvas) return res.status(404).json({ error: 'not found' })
  if (!roleAllows(canvasRole(userId, canvas), 'edit')) {
    return res.status(403).json({ error: "this key's account cannot edit this canvas" })
  }
  const frameId = String(req.body?.frameId ?? '')
  const frame = canvas.frames.find((f) => f.id === frameId)
  if (!frame) return res.status(404).json({ error: 'frame not found on this canvas' })
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url || url.length > 2048) return res.status(400).json({ error: 'url required' })
  /* a CI has no desktop: local URLs are refused up front rather than left
     to time out inside the capture */
  if (classifyDriftUrl(url).kind === 'local') {
    return res.status(422).json({
      error: 'local URLs are fetched through the Diazo desktop app — run the compare from the app, not from CI',
    })
  }
  try {
    const { comparison, shipped } = await compareFrameWithUrl({
      frame,
      url,
      actor: actions.resolveActor({ name: (await getUserName(userId)) ?? 'CI', kind: 'agent' }),
      userId,
      source: 'webhook',
    })
    res.status(201).json({ comparison, shippedFrame: shipped })
  } catch (error) {
    const { status, message } = driftErrorMessage(error)
    res.status(status).json({ error: message })
  }
})

/* everything else under /api requires a logged-in user; the session's user
   is authoritative for names — clients don't get to pick who they are */
interface SessionUser {
  id: string
  name: string
  email: string
  /** the profile photo's URL; shown only when avatarUrl() admits it */
  image?: string | null
  role?: string | null
}
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      /** admin's user id when this session is a "view as" — see /api/admin */
      impersonatedBy?: string
      /** a server render's scoped read token — server/motionRender.ts */
      renderGrant?: { canvasId: string; pageId: string }
    }
  }
}
/* an OAuth redirect begun in the desktop app lands in the system browser,
   whose session (if any) is not the app's: relay it back to the app before
   the gate looks at that session (shared/desktopConnect.ts) */
app.get('/api/integrations/:provider/callback', relayDesktopCallback)
/* canvas reads are megabytes of JSON; the event stream asks for no transform
   and is left alone by the middleware */
app.use('/api', compression())
app.use('/api/live-activities', logLiveActivityRequests)
app.use('/api', async (req, res, next) => {
  try {
    /* a server render's token stands in for a session on exactly the two
       harness GETs it was minted for — renderAccess checks method, path,
       (canvasId, pageId) and expiry; anything else falls through to the
       session gate (server/motionRender.ts) */
    const grant = renderAccess(req.headers.cookie, req.method, req.path)
    if (grant) {
      req.renderGrant = grant
      return next()
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    req.user = session.user
    req.impersonatedBy = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? undefined
    /* Viewing as someone else is read-only, full stop. Every doop mutation is
       a non-GET REST call — the websocket after `join` carries only cursor,
       editing and frame:drag — so this single rule covers the whole surface.
       better-auth's own routes are mounted earlier (/api/auth/*), so signing
       out and stop-impersonating are unaffected. */
    if (req.impersonatedBy && req.method !== 'GET') {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
    next()
  } catch (err) {
    next(err)
  }
})

/* Every route naming a canvas, frame or comment gets that canvas's frame
   HTML loaded before its handler runs (store.load), so handlers keep
   reading the store synchronously, and held until the response is done, so
   a handler awaiting something slow (an import, a render) keeps it.
   Behind the session gate, so only a signed-in request can bring a canvas
   into memory. */
function loadFirst(canvasOf: (id: string) => string | undefined): express.RequestHandler {
  return (req, res, next) => {
    const canvasId = canvasOf(String(req.params.id))
    if (!canvasId) return next()
    store.load(canvasId).then(() => {
      res.once('close', store.hold(canvasId))
      next()
    }, next)
  }
}
app.use(
  '/api/canvases/:id',
  loadFirst((id) => id),
)
app.use(
  '/api/frames/:id',
  loadFirst((id) => store.getFrame(id)?.canvasId),
)
app.use(
  '/api/comments/:id',
  loadFirst((id) => actions.findComment(id)?.canvasId),
)

/* Whether a newer build of this fork is out (server/updateCheck.ts). 404 to
   anyone but an instance admin or a local install's user, like /api/admin. */
app.get('/api/update-status', async (req, res, next) => {
  if (!maySeeUpdates(req.user)) return res.status(404).end()
  try {
    res.json(await updateStatus())
  } catch (err) {
    next(err)
  }
})

/* Home's push channel: tells an open dashboard its canvas list changed */
app.get('/api/me/events', userEvents.subscribe)

app.get('/api/me', async (req, res) => {
  const { id, name, email, image } = req.user!
  res.json({
    id,
    name,
    email,
    image: avatarUrl(image),
    admin: isAdmin(req.user),
    /* 'team' while a member of a live paid workspace — the account menu's plan line */
    plan: workspaces.planFor(id),
    /* the SPA cannot infer this: impersonation swaps the session cookie
       outright, so everything else on this response describes the person
       being viewed, not the admin doing the viewing */
    impersonating: req.impersonatedBy ? { byName: (await getUserName(req.impersonatedBy)) ?? 'an admin' } : undefined,
  })
})

/* The profile photo: raw image bytes in, the face's URL out. Rooms the
   person is in see the new face at once; the session the browser holds is
   re-read by the page, since better-auth serves it from the row. */
app.post('/api/me/avatar', express.raw({ type: () => true, limit: MAX_AVATAR_BYTES + 1024 }), async (req, res) => {
  try {
    const image = await setAvatar(req.user!.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
    refreshPresenceImage(req.user!.id, image)
    res.json({ image })
  } catch (e) {
    if (e instanceof AvatarInputError) res.status(400).json({ error: e.message })
    else {
      console.error('[avatar] upload failed', e)
      res.status(500).json({ error: 'the photo could not be saved — try again' })
    }
  }
})

app.delete('/api/me/avatar', async (req, res, next) => {
  try {
    await clearAvatar(req.user!.id)
    refreshPresenceImage(req.user!.id, undefined)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})

/* Resolve the application from the consent code itself, never a client name or
   id supplied by the page. Only the account authorizing the code may use it. */
async function mcpConsent(code: string, userId: string) {
  const [request] = await db.select().from(authSchema.verification).where(eq(authSchema.verification.identifier, code))
  if (!request || request.expiresAt <= new Date()) return null
  let value: { userId?: string; clientId?: string; requireConsent?: boolean } | null
  try {
    value = JSON.parse(request.value)
  } catch {
    return null
  }
  if (!value || value.userId !== userId || value.requireConsent !== true || typeof value.clientId !== 'string')
    return null
  const [client] = await db
    .select()
    .from(authSchema.oauthApplication)
    .where(eq(authSchema.oauthApplication.clientId, value.clientId))
  return client && !client.disabled ? { name: client.name } : null
}

app.get('/api/mcp-consent/:code', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    const client = await mcpConsent(req.params.code!, req.user!.id)
    if (!client)
      return res.status(404).json({ error: 'This connection request has expired. Start again from your agent.' })
    res.json(client)
  } catch (error) {
    next(error)
  }
})

app.post('/api/mcp-consent/:code', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store')
    if (typeof req.body?.accept !== 'boolean') return res.status(400).json({ error: 'Choose whether to connect.' })
    if (!(await mcpConsent(req.params.code!, req.user!.id)))
      return res.status(404).json({ error: 'This connection request has expired. Start again from your agent.' })
    const result = await auth.api.oAuthConsent({
      headers: fromNodeHeaders(req.headers),
      body: { accept: req.body.accept, consent_code: req.params.code! },
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

/* Canvas access on the REST surface: resolve the canvas (or the frame's
   canvas) and check the caller's role against what the route needs before
   touching anything — 'view' for reads, 'comment' for comment threads,
   'edit' for every other write. `need` is required on purpose: a route
   that forgets it does not compile, rather than defaulting open.
   Both helpers write the error response themselves and return null. */
/** The signed-in person as the actor of a REST write. The name is the
 *  account's, never the body's; the body's `actor.clientId` is kept, since it
 *  is only the browser tab's presence token, which lets the room tell that
 *  tab's own writes from everyone else's (the remote-edit flash). */
function userActor(req: express.Request) {
  const clientId = req.body?.actor?.clientId
  return actions.resolveActor({
    name: req.user!.name,
    kind: 'user',
    clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : undefined,
  })
}

function requireCanvas(req: express.Request, res: express.Response, canvasId: string, need: CanvasRole) {
  const c = store.getCanvas(canvasId)
  if (!c) {
    res.status(404).json({ error: 'not found' })
    return null
  }
  return checkRole(req, res, c, need) ? c : null
}

/* a server render's token reads its own canvas like a viewer — it only
   exists on the two harness GETs renderAccess admits (motionRender.ts) */
function requireCanvasOrRenderGrant(req: express.Request, res: express.Response, canvasId: string) {
  if (req.renderGrant?.canvasId === canvasId) {
    const c = store.getCanvas(canvasId)
    if (!c) res.status(404).json({ error: 'not found' })
    return c ?? null
  }
  return requireCanvas(req, res, canvasId, 'view')
}

function checkRole(req: express.Request, res: express.Response, canvas: Canvas, need: CanvasRole): boolean {
  const role = canvasRole(req.user!.id, canvas)
  if (!role) {
    res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
    return false
  }
  if (!roleAllows(role, need)) {
    res.status(403).json({ error: ROLE_DENIED[need], role })
    return false
  }
  return true
}

const ROLE_DENIED: Record<CanvasRole, string> = {
  view: 'this canvas is private — ask the owner for access',
  comment: 'you can view this canvas but not comment — ask the owner for access',
  edit: 'you can view this canvas but not edit it — ask the owner for edit access',
}

/* An @mention hands the resident agent a command that changes frames, so a
   comment-only visitor may comment but not mention an agent: otherwise the
   agent would make the edits the link withholds. Answers the 403 itself. */
function refuseAgentMention(req: express.Request, res: express.Response, canvasId: string, text: string): boolean {
  const canvas = store.getCanvas(canvasId)
  if (!mentionedRole(text) || (canvas && canEditCanvas(req.user!.id, canvas))) return false
  res.status(403).json({ error: 'asking an agent to change the canvas needs edit access' })
  return true
}

function requireFrame(
  req: express.Request,
  res: express.Response,
  frameId: string,
  need: CanvasRole,
  expectedUpdatedAt?: unknown,
) {
  const frame = store.getFrame(frameId)
  if (!frame) {
    res.status(404).json({ error: 'frame not found' })
    return null
  }
  const c = store.getCanvas(frame.canvasId)
  if (!c) {
    res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
    return null
  }
  if (!checkRole(req, res, c, need)) return null
  if (expectedUpdatedAt !== undefined) {
    if (typeof expectedUpdatedAt !== 'number' || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      res.status(400).json({ error: 'expectedUpdatedAt must be a nonnegative integer' })
      return null
    }
    // PATCH and DELETE mutate the store synchronously after this check.
    if (frame.updatedAt !== expectedUpdatedAt) {
      res.status(409).json({ error: 'The frame changed while you were editing. Please try again.', frame })
      return null
    }
  }
  return frame
}

app.use('/api/local-agent', localAgentRouter)
app.use('/api/local-repo', localRepoRouter)
app.use('/api/local-drift', localDriftRouter)
app.use('/api/image-descriptions', imageDescriptions.imageDescriptionsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/webhooks', webhooksRouter)
app.use('/api/fonts', fontsRouter)
app.use('/api/libraries', libraryRouter)
app.use('/api/library-curations', curationRouter)

/* the font library a canvas designs with: its workspace's, or its owner's */
app.get('/api/canvases/:id/fonts', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (canvas) res.json(fontsForCanvas(canvas))
})

/* ---- a folder on the caller's own computer, linked to this canvas. The
   server stores only the link — the absolute path stays inside the desktop
   app's grant file and reads ride the /api/local-repo poll bridge. The link
   is the caller's own: the agent reads the requester's project. */

app.get('/api/canvases/:id/repo', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  const link = await linkFor(req.user!.id, c.id)
  const device = localRepo.deviceFor(req.user!.id)
  res.json({
    link: link ?? null,
    online: !!device,
    deviceMismatch: !!link && !!device && device.id !== link.deviceId,
  })
})

app.post('/api/canvases/:id/repo', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = z
    .object({ linkId: z.string().uuid(), name: z.string().min(1).max(200), deviceId: z.string().uuid() })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid link' })
  const link = await putLink(req.user!.id, c.id, {
    id: parsed.data.linkId,
    name: parsed.data.name,
    deviceId: parsed.data.deviceId,
  })
  res.json({ link })
})

app.delete('/api/canvases/:id/repo', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  res.json({ ok: await deleteLink(req.user!.id, c.id) })
})

/* ---- Send to Orca (docs/orca.md). A ready-for-dev frame launches a dev
   task: the pack is built and stored on the row, the launch job rides the
   same poll bridge to the requester's desktop, which runs the typed orca.rs
   commands. Status comes back through the report route and the coding
   agent's own update_dev_task; every stored change broadcasts `dev-task`. */

const devTaskCreateSchema = z
  .object({
    agent: z.enum(DEV_TASK_AGENTS),
    /* the same charset the shell's valid_flag_value enforces, checked now
       so a bad value fails before the row exists */
    model: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._:-]{0,59}$/i)
      .optional(),
    effort: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._:-]{0,29}$/i)
      .optional(),
    /* an Orca environment name (`vps`); the shell re-checks it against
       `orca host list` before passing --environment */
    environment: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,59}$/i)
      .optional(),
  })
  .refine((d) => !d.effort || d.model)

/* a launch builds its brief (a frame render) before the device's native
   confirm gates it — bound that build rate like the importer's */
const devTaskLaunchHits = new Map<string, number[]>()
function takeDevTaskLaunchSlot(userId: string): boolean {
  const now = Date.now()
  const hits = (devTaskLaunchHits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= 5) return false
  hits.push(now)
  devTaskLaunchHits.set(userId, hits)
  return true
}

app.post('/api/frames/:id/dev-tasks', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'edit')
  if (!frame) return
  const c = store.getCanvas(frame.canvasId)!
  const parsed = devTaskCreateSchema.safeParse(req.body ?? {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid dev task request' })
  if (frame.approval?.status !== 'ready_for_dev')
    return res.status(409).json({ error: 'the frame is not signed off ready for dev' })
  const link = await linkFor(req.user!.id, c.id)
  const device = localRepo.deviceFor(req.user!.id)
  if (!link || !device || !device.grants.has(link.id))
    return res.status(409).json({ error: "the linked project isn't reachable — open the Diazo desktop app holding it" })
  if (!takeDevTaskLaunchSlot(req.user!.id))
    return res.status(429).json({ error: 'too many dev task launches — wait a minute' })
  try {
    const codeLinks = await listCodeLinks(c.id).catch(() => [])
    const brief = await buildDevTaskBrief(c, [frame], { codeLinks })
    const task = await createDevTask({
      canvasId: c.id,
      frameIds: [frame.id],
      frameRevision: frame.approval.approvedFrameUpdatedAt,
      brief,
      link,
      userId: req.user!.id,
      userName: req.user!.name || 'someone',
      ...parsed.data,
    })
    res.json({ task })
  } catch (e) {
    if (e instanceof FrameHtmlNotLoadedError) return res.status(503).json({ error: e.message })
    throw e
  }
})

app.get('/api/canvases/:id/dev-tasks', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  res.json({ tasks: await devTasksForCanvas(c.id) })
})

app.get('/api/frames/:id/dev-tasks', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'view')
  if (!frame) return
  const tasks = (await devTasksForCanvas(frame.canvasId)).filter((t) => t.frameIds.includes(frame.id))
  res.json({ tasks })
})

const devTaskReportSchema = z.object({
  deviceId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
  launch: z
    .object({
      ok: z.boolean(),
      cancelled: z.boolean().optional(),
      error: z.string().max(1_000).optional(),
      orcaIdentity: z.string().max(120).optional(),
      branch: z.string().max(200).optional(),
      launchKind: z.string().max(40).optional(),
      launchHandle: z.string().max(200).optional(),
      orcaSessionId: z.string().max(200).optional(),
      operationId: z.string().max(120).optional(),
    })
    .optional(),
  poll: z
    .object({
      found: z.boolean(),
      status: z.string().max(40).optional(),
      agentState: z.string().max(40).optional(),
      outcome: z.string().max(40).optional(),
      lastAssistantMessage: z
        .string()
        .max(DEV_TASK_SUMMARY_CHARS + 500)
        .optional(),
      linkedPR: z.string().max(500).nullable().optional(),
      orcaSessionId: z.string().max(200).optional(),
      branch: z.string().max(200).optional(),
      workspaceStatus: z.string().max(60).optional(),
      devUrl: z.string().max(500).nullable().optional(),
    })
    .optional(),
})

app.post('/api/dev-tasks/:id/report', async (req, res) => {
  const parsed = devTaskReportSchema.safeParse(req.body ?? {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid dev task report' })
  const outcome = await applyDeviceReport(req.user!.id, req.params.id, parsed.data)
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error })
  res.json({ ok: true, task: outcome.task })
})

app.post('/api/dev-tasks/:id/cancel', async (req, res) => {
  const task = await devTaskFor(req.params.id)
  if (!task) return res.status(404).json({ error: 'no such dev task' })
  const c = requireCanvas(req, res, task.canvasId, 'edit')
  if (!c) return
  res.json({ task: await cancelDevTask(task.id) })
})

/* ---- component ↔ file mapping (shared/codeLinks.ts): where a component or
   a frame lives in the linked repo. Storing a mapping never reads or writes
   the repo; it is a canvas-level note every implementer reads. */

const codeLinkBody = z.object({
  targetKind: z.enum(CODE_LINK_KINDS),
  targetId: z.string().min(1).max(100),
  path: z.string().max(CODE_LINK_MAX_PATH + 20),
  exportName: z.string().max(CODE_LINK_MAX_EXPORT).nullable().optional(),
  source: z.enum(CODE_LINK_SOURCES).optional(),
})

app.get('/api/canvases/:id/code-links', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  res.json({ links: await listCodeLinks(c.id) })
})

app.put('/api/canvases/:id/code-links', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = codeLinkBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid code link' })
  try {
    res.json({ link: await putCodeLink(c.id, parsed.data, req.user!.name) })
  } catch (e) {
    if (e instanceof CodeLinkError) return res.status(e.status).json({ error: e.message })
    throw e
  }
})

/* suggestions read the caller's own linked project (repo_search + repo_list) */
app.post('/api/canvases/:id/code-links/suggest', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = z
    .object({ targetKind: z.enum(CODE_LINK_KINDS), targetId: z.string().min(1).max(100) })
    .safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid target' })
  const { targetKind, targetId } = parsed.data
  try {
    res.json(
      await suggestCodeLinks(
        req.user!.id,
        c.id,
        targetKind === 'frame' ? { frame_id: targetId } : { component: targetId },
      ),
    )
  } catch (e) {
    if (e instanceof CodeLinkError) return res.status(e.status).json({ error: e.message })
    throw e
  }
})

app.delete('/api/canvases/:id/code-links/:kind/:targetId', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const kind = req.params.kind
  if (!isCodeLinkKind(kind)) return res.status(400).json({ error: "kind must be 'component' or 'frame'" })
  res.json({ ok: await deleteCodeLink(c.id, kind, req.params.targetId!) })
})

/* ---- two-way token sync (shared/tokenSync.ts): the repo's CSS variables and
   Tailwind theme, read through the caller's linked project and diffed
   against the canvas's tokens. Reading only — nothing is applied here. */

app.post('/api/canvases/:id/token-sync', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  try {
    res.json(await previewTokenSync(req.user!.id, c.id))
  } catch (e) {
    if (e instanceof TokenSyncError) return res.status(e.status).json({ error: e.message })
    throw e
  }
})

const approvedTokens = z.object({
  tokens: z
    .array(
      z.object({
        name: z.string().max(200),
        type: z.enum(TOKEN_TYPES),
        value: z.string().max(MAX_TOKEN_VALUE),
        themes: z.record(z.string().max(MAX_TOKEN_VALUE)).optional(),
      }),
    )
    .min(1)
    .max(200),
})

/* the person ticked these repo values in the sync modal: take them in */
app.post('/api/canvases/:id/token-sync/apply', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = approvedTokens.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tokens' })
  const results = applyRepoTokens(c.id, parsed.data.tokens, userActor(req))
  res.json({ results, tokens: store.getTokens(c.id) })
})

const tokenNames = z.object({ names: z.array(z.string().max(200)).min(1).max(200) })

/* doop → repo: the patch the canvas's values make against the repo's style
   files — previewed here, written only through the desktop app's dialog */
app.post('/api/canvases/:id/token-sync/patch', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = tokenNames.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid token names' })
  try {
    const plan = await previewTokenPatch(req.user!.id, c.id, parsed.data.names)
    res.json({ ...plan, summary: plan.patch ? checkPatch(plan.patch) : null })
  } catch (e) {
    if (e instanceof TokenSyncError || e instanceof RepoPatchError)
      return res.status(e.status).json({ error: e.message })
    throw e
  }
})

/* the write rebuilds the patch from a fresh read: it must be the one the
   person previewed, else the repo or the canvas moved in between */
app.post('/api/canvases/:id/token-sync/write', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const parsed = tokenNames.extend({ patch: z.string().max(PATCH_MAX_BYTES) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid write request' })
  try {
    const plan = await previewTokenPatch(req.user!.id, c.id, parsed.data.names)
    if (!plan.patch) return res.status(409).json({ error: 'nothing to write — the repo already has these values' })
    if (plan.patch !== parsed.data.patch)
      return res.status(409).json({ error: 'the repo or the tokens changed since the preview — preview again' })
    const result = await applyRepoPatch(req.user!.id, c.id, plan.patch, `Token sync: ${plan.names.length} token(s)`)
    res.json({ ok: true, result })
  } catch (e) {
    if (e instanceof TokenSyncError || e instanceof RepoPatchError)
      return res.status(e.status).json({ error: e.message })
    throw e
  }
})

/* ---- frame → code: the generated component as a patch against what the
   linked repo holds at its paths — previewed here, written only through
   the desktop app's repo_apply_patch dialog */

const frameCodeBody = z.object({
  framework: z.enum(FRAME_CODE_FRAMEWORKS),
  path: z.string().max(CODE_LINK_MAX_PATH).optional(),
  name: z.string().max(100).optional(),
})

function frameCodeError(res: express.Response, e: unknown) {
  if (e instanceof RepoPatchError) return res.status(e.status).json({ error: e.message })
  if (e instanceof FrameCodeError) return res.status(400).json({ error: e.message })
  throw e
}

app.post('/api/frames/:id/code/preview', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'edit')
  if (!frame) return
  const parsed = frameCodeBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid export request' })
  try {
    res.json(await frameCodePatch(req.user!.id, frame, parsed.data))
  } catch (e) {
    frameCodeError(res, e)
  }
})

/* the write rebuilds the patch from a fresh read and must match the preview;
   once the desktop app wrote it, the frame maps to the file it now lives in */
app.post('/api/frames/:id/code/write', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'edit')
  if (!frame) return
  const parsed = frameCodeBody.extend({ patch: z.string().max(PATCH_MAX_BYTES) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid write request' })
  const { patch, ...opts } = parsed.data
  try {
    const preview = await frameCodePatch(req.user!.id, frame, opts)
    if (!preview.patch)
      return res.status(409).json({ error: 'nothing to write — the repo already holds this component' })
    if (preview.patch !== patch)
      return res.status(409).json({ error: 'the frame or the repo changed since the preview — preview again' })
    const result = await applyRepoPatch(req.user!.id, frame.canvasId, patch, `Frame → code: "${frame.name}"`)
    const main = preview.code.files[0]!
    const link = await putCodeLink(
      frame.canvasId,
      { targetKind: 'frame', targetId: frame.id, path: main.path, exportName: preview.code.name, source: 'generated' },
      req.user!.name,
    )
    res.json({ ok: true, result, link })
  } catch (e) {
    frameCodeError(res, e)
  }
})

app.use('/api/admin', adminRouter)
app.use('/api/community', communityRouter)
app.use('/api/automations', automationsRouter)
app.use('/api/integrations', integrationsRouter)
app.use('/api/workspaces', workspaces.workspacesRouter)
app.use('/api/live-activities', liveActivitiesRouter)
startLiveActivityDelivery()
app.use('/api/billing', billing.billingRouter)

/* free-tier meter for the resident team: {used, limit, connected, byoModel} */
app.get('/api/agent-allowance', (req, res) => {
  allowance
    .getAllowance(req.user!.id)
    .then((a) => res.json(a))
    .catch(() => res.status(500).json({ error: 'allowance unavailable' }))
})

/* the connections the composer may send a task to, and the Settings default */
app.get('/api/agent-runners', (req, res) => {
  listRunners(req.user!.id)
    .then((runners) => res.json(runners))
    .catch(() => res.status(500).json({ error: 'runners unavailable' }))
})

/* which connection comments, @mentions and automations run on; it has to be
   one that is connected and on right now */
app.put('/api/agent-runners/default', async (req, res) => {
  const provider: unknown = req.body?.provider
  if (!isRunnerProvider(provider)) return res.status(400).json({ error: 'unknown connection' })
  try {
    const userId = req.user!.id
    const usable =
      provider === 'claude-local'
        ? (await getLocalAgentPreference(userId)).enabled
        : isAcpRunnerProvider(provider)
          ? (await getAcpPreference(userId, acpAgentOf(provider))).enabled
          : (await modelAccounts.getAccount(userId, provider))?.enabled
    if (!usable) return res.status(400).json({ error: 'connect and switch that on first' })
    await setStoredDefault(userId, provider)
    res.json(await accountsView(userId))
    wakeUserWork(userId)
  } catch {
    res.status(500).json({ error: 'could not change the default' })
  }
})

/* ---- the user's own model account: what keeps the Doop Agent running once
   the free tasks are gone. Tokens live server-side and are never returned. */

/* Every account route answers with the whole Settings view (every account,
   on or off, and the default): the client re-renders straight from it. */
app.get('/api/model-account', (req, res) => {
  accountsView(req.user!.id)
    .then((view) => res.json(view))
    .catch(() => res.status(500).json({ error: 'account status unavailable' }))
})

app.get('/api/model-account/models', async (req, res) => {
  try {
    const kind: unknown = req.query.kind
    if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
    const account = await modelAccounts.getAccount(req.user!.id, kind)
    if (!account) return res.json({ models: [], live: false })
    /* the same catalog merge the runners list serves (agentRunners.ts):
       the provider's own list over the curated menu, a stale token
       refreshed first where the account has one */
    res.json(await catalogForAccount(account))
  } catch {
    res.status(500).json({ error: 'models unavailable' })
  }
})

/* one account's model tier, (OpenAI kinds) how hard it thinks, or whether
   it is switched on — one field per request, the view comes back either way */
app.patch('/api/model-account/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
  try {
    const userId = req.user!.id
    const { model, effort, enabled } = (req.body ?? {}) as { model?: unknown; effort?: unknown; enabled?: unknown }
    if (typeof enabled === 'boolean') await modelAccounts.setAccountEnabled(userId, kind, enabled)
    else if (effort !== undefined) await modelAccounts.setAccountEffort(userId, kind, String(effort))
    else await modelAccounts.setAccountModel(userId, kind, String(model ?? ''))
    res.json(await accountsView(userId))
    /* switching one on can make queued work runnable */
    if (enabled === true) wakeUserWork(userId)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not change that account' })
  }
})

/* OpenAI's only registered redirect is a loopback URL, so the browser's
   callback is reachable by us exactly when the browser is on this machine.
   A forwarded request came through a proxy and is by definition not. */
function isSameMachine(req: express.Request): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false
  const ip = req.socket.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/* step 1 of the ChatGPT flow: hand back the OpenAI authorize URL to open.
   `catching` tells the client we will pick the redirect up ourselves, so it
   can poll instead of asking the user to copy anything. */
app.post('/api/model-account/chatgpt/authorize', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  const started = modelAccounts.beginChatgptAuth(req.user!.id)
  const catching = isSameMachine(req) ? await modelAccounts.startCallbackCatcher() : false
  res.json({ ...started, catching })
})

/* step 2: the user pastes the redirect URL they landed on; we do the code
   exchange server-side, so the browser never handles a token */
app.post('/api/model-account/chatgpt', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    await modelAccounts.completeChatgptAuth(req.user!.id, String(req.body?.redirect ?? ''))
    res.json(await accountsView(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect that ChatGPT account' })
  }
})

/* device flow: no redirect URI at all, so it works wherever Doop is hosted.
   We poll OpenAI in the background; the browser polls the status below. */
app.post('/api/model-account/chatgpt/device', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    res.json(await modelAccounts.beginDeviceAuth(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not start a device sign-in' })
  }
})

app.get('/api/model-account/chatgpt/device', (req, res) => {
  res.json(modelAccounts.deviceAuthStatus(req.user!.id) ?? { status: 'none' })
})

app.delete('/api/model-account/chatgpt/device', (req, res) => {
  modelAccounts.cancelDeviceAuth(req.user!.id)
  res.json({ ok: true })
})

/* each key connects beside whatever else is connected: nothing is switched
   off, and the default changes only when the person marks another one */
const KEY_CONNECTS = {
  'openai-key': modelAccounts.connectApiKey,
  'anthropic-key': modelAccounts.connectAnthropicKey,
  'openrouter-key': modelAccounts.connectOpenRouterKey,
  'gemini-key': modelAccounts.connectGeminiKey,
  'deepseek-key': modelAccounts.connectDeepSeekKey,
  'kimi-key': modelAccounts.connectKimiKey,
  'kimi-code': modelAccounts.connectKimiCodeKey,
  'elevenlabs-key': modelAccounts.connectElevenLabsKey,
} as const
for (const [kind, connect] of Object.entries(KEY_CONNECTS)) {
  app.post(`/api/model-account/${kind}`, async (req, res) => {
    try {
      await connect(req.user!.id, String(req.body?.apiKey ?? ''))
      res.json(await accountsView(req.user!.id))
      wakeUserWork(req.user!.id)
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'could not save that API key' })
    }
  })
}

/* ---- custom providers: any OpenAI- or Anthropic-compatible endpoint, by
   its base URL. One is a model account of kind `custom:<id>`, so switching it
   on or off, picking its model, making it the default and disconnecting it
   are the routes above; these create and edit it, and help set it up. */

app.use('/api/custom-providers', (_req, res, next) => {
  if (!customProvidersEnabled()) return res.status(404).json({ error: 'custom providers are off on this server' })
  next()
})

/** The key and headers a request carries: a field left out is undefined, so
 *  an edit keeps the stored one; an empty key clears it. */
function customSecrets(body: Record<string, unknown>): { apiKey?: string; headers?: Record<string, string> } {
  const secrets: { apiKey?: string; headers?: Record<string, string> } = {}
  if (body.apiKey !== undefined) {
    const key = parseCustomKey(body.apiKey)
    if (!key.ok) throw new CustomProviderError(key.error)
    secrets.apiKey = key.value
  }
  if (body.headers !== undefined) {
    const headers = parseCustomHeaders(body.headers)
    if (!headers.ok) throw new CustomProviderError(headers.error)
    secrets.headers = headers.value
  }
  return secrets
}

/** A validated provider description whose URL this server may reach. */
function customConfig(body: unknown) {
  const config = parseCustomProviderConfig(body)
  if (!config.ok) throw new CustomProviderError(config.error)
  reachableUrl(config.value.baseUrl)
  return config.value
}

/** The secrets a set-up request should use: what it carries, else (for a
 *  provider being edited) what is stored for it. */
async function probeSecrets(userId: string, body: Record<string, unknown>) {
  const given = customSecrets(body)
  const stored = isCustomProviderKind(body.kind) ? await modelAccounts.getAccount(userId, body.kind) : null
  const apiKey = given.apiKey ?? stored?.apiKey
  const headers = given.headers ?? stored?.headers
  return { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) }
}

function customFailure(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof CustomProviderError || error instanceof CustomProviderUrlError) {
    return res.status(400).json({ error: error.message })
  }
  /* the provider's own error text (a 400 body, a refused model) is what the
     person needs to fix their endpoint; never a stack */
  const message = error instanceof Error ? error.message.slice(0, 500) : fallback
  return res.status(400).json({ error: message || fallback })
}

app.post('/api/custom-providers', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const config = customConfig(body)
    await modelAccounts.connectCustomProvider(req.user!.id, config, customSecrets(body))
    res.json(await accountsView(req.user!.id))
    wakeUserWork(req.user!.id)
  } catch (error) {
    customFailure(res, error, 'could not add that provider')
  }
})

app.put('/api/custom-providers/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!isCustomProviderKind(kind)) return res.status(400).json({ error: 'unknown provider' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    await modelAccounts.updateCustomProvider(req.user!.id, kind, customConfig(body), customSecrets(body))
    res.json(await accountsView(req.user!.id))
    wakeUserWork(req.user!.id)
  } catch (error) {
    customFailure(res, error, 'could not save that provider')
  }
})

/* the endpoint's own model list, to fill the form's rows */
app.post('/api/custom-providers/models', async (req, res) => {
  const userId = req.user!.id
  if (!takeProbeSlot(userId)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const apiType = CUSTOM_API_TYPES.find((type) => type === body.apiType)
    if (!apiType) throw new CustomProviderError('Pick the API type')
    const baseUrl = normalizeBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '')
    if (!baseUrl.ok) throw new CustomProviderError(baseUrl.error)
    const models = await discoverCustomModels({
      config: { apiType, baseUrl: baseUrl.value },
      ...(await probeSecrets(userId, body)),
    })
    res.json({ models })
  } catch (error) {
    customFailure(res, error, 'could not list that endpoint’s models')
  }
})

/* one short turn that has to call a tool: the agent cannot work without it */
app.post('/api/custom-providers/test', async (req, res) => {
  const userId = req.user!.id
  if (!takeProbeSlot(userId)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' })
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const config = customConfig(body)
    const model = config.models.find((option) => option.id === body.model) ?? config.models[0]
    if (!model) throw new CustomProviderError('Add a model to test')
    await testCustomProvider({ config, ...(await probeSecrets(userId, body)) }, model)
    res.json({ ok: true, model: model.id })
  } catch (error) {
    customFailure(res, error, 'the test turn failed')
  }
})

app.delete('/api/model-account/:kind', async (req, res) => {
  const kind = req.params.kind
  if (!modelAccounts.isAccountKind(kind)) return res.status(400).json({ error: 'unknown account kind' })
  await modelAccounts.disconnect(req.user!.id, kind)
  res.json(await accountsView(req.user!.id))
})

/* ---- which image model generate_image draws with (the shared registry;
   entries the payer cannot run are shown but disabled) */

app.get('/api/image-model', (req, res) => {
  imageModelAvailability(req.user!.id)
    .then((models) => res.json({ models }))
    .catch(() => res.status(500).json({ error: 'image models unavailable' }))
})

app.put('/api/image-model', async (req, res) => {
  try {
    const model = String(req.body?.model ?? '')
    const models = await imageModelAvailability(req.user!.id)
    const entry = models.find((m) => m.id === model)
    if (!entry) throw new Error('unknown image model')
    if (!entry.available) throw new Error('that image model is not available on your account or this server')
    await setImagePref(req.user!.id, model)
    res.json({ models: await imageModelAvailability(req.user!.id) })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not change the image model' })
  }
})

/* ---- Agent keys: account-scoped bearer credentials for /mcp, the headless
   agent path (see server/agentKeys.ts). The secret appears exactly once, in
   the create response; the list carries only each key's start. The /api
   session gate above means impersonating admins can look but not mint. */

app.get('/api/agent-keys', async (req, res) => {
  res.json(await agentKeys.listAgentKeys(req.user!.id))
})

app.post('/api/agent-keys', async (req, res) => {
  const key = await agentKeys.createAgentKey(req.user!.id, String(req.body?.name ?? ''))
  if (!key) return res.status(400).json({ error: 'agent key limit reached — revoke one you no longer use' })
  res.json(key)
})

app.delete('/api/agent-keys/:id', async (req, res) => {
  if (!(await agentKeys.deleteAgentKey(req.user!.id, req.params.id)))
    return res.status(404).json({ error: 'agent key not found' })
  res.json({ ok: true })
})

/* ---- the reference library (Settings → Agent): the canvases the chat
   agent searches with find_references, and the only canvases a plan's
   references may point into. Per user, like the repo link. */

app.get('/api/library', async (req, res) => {
  res.json({ canvases: await library.libraryFor(req.user!.id) })
})

app.put('/api/library', async (req, res) => {
  const ids: unknown = req.body?.canvasIds
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => (typeof id === 'string' ? id.trim() : '')))]
  if (!Array.isArray(ids) || wanted.some((id) => !id)) {
    return res.status(400).json({ error: 'canvasIds must be a list of canvas ids' })
  }
  if (wanted.length > library.LIBRARY_MAX_CANVASES) {
    return res.status(400).json({ error: `a library holds at most ${library.LIBRARY_MAX_CANVASES} canvases` })
  }
  /* only canvases the user can still open may be designated — the same set
     find_references will be allowed to search */
  const reachable = new Set(workspaces.canvasesFor(req.user!.id).map((meta) => meta.id))
  /* a public design library may be picked without canvas access */
  const unknown = wanted.find((id) => !reachable.has(id) && !libraries.libraryRole(req.user!.id, store.getCanvas(id)))
  if (unknown) return res.status(400).json({ error: `canvas ${unknown} is not yours to use as a library` })
  await library.setLibraryCanvasIds(req.user!.id, wanted)
  res.json({ canvases: await library.libraryFor(req.user!.id) })
})

app.get('/api/canvases', async (req, res) => {
  const list = workspaces.canvasesFor(req.user!.id)
  /* the people on each canvas (owner first, then invited members) resolve
     to names in one query — the home tiles wear them as an avatar stack */
  const peopleIds = new Set<string>()
  for (const c of list) for (const id of canvasPeopleIds(c.id)) peopleIds.add(id)
  const users = new Map<string, { name: string; image: string | null }>()
  if (peopleIds.size) {
    const rows = await db
      .select({ id: authSchema.user.id, name: authSchema.user.name, image: authSchema.user.image })
      .from(authSchema.user)
      .where(inArray(authSchema.user.id, [...peopleIds]))
    for (const r of rows) users.set(r.id, r)
  }
  res.json(
    list.map((c) => {
      /* which agents have worked on this canvas (most recent first), with
         the user whose token they connected under and when they last worked */
      const seen = new Map<string, { owner?: string; lastAt: number }>()
      for (const t of actions.getTasks(c.id)) {
        if (!t.agentName) continue // unclaimed board cards have no agent yet
        if (!seen.has(t.agentName)) seen.set(t.agentName, { owner: t.owner, lastAt: t.startedAt })
      }
      return {
        ...c,
        people: canvasPeopleIds(c.id).map((id) => ({
          id,
          name: users.get(id)?.name ?? 'Unknown',
          image: avatarUrl(users.get(id)?.image),
        })),
        agents: [...seen].slice(0, 8).map(([name, v]) => ({ name, owner: v.owner, lastAt: v.lastAt })),
        activeTasks: activeAgentTasks(actions.getTasks(c.id)),
      }
    }),
  )
})

/** owner first, then invited members, each once */
function canvasPeopleIds(canvasId: string): string[] {
  const c = store.getCanvas(canvasId)
  if (!c) return []
  return [...new Set([...(c.ownerId ? [c.ownerId] : []), ...(c.memberIds ?? [])])]
}

/* A workspace canvas needs membership and a workspace that may still grow —
   the 402 is what every client turns into the upgrade modal. */
function requireGrowableWorkspace(req: express.Request, res: express.Response, workspaceId: string) {
  const ws = workspaces.getWorkspace(workspaceId)
  if (!ws || !workspaces.isWorkspaceMember(ws.id, req.user!.id)) {
    res.status(404).json({ error: 'workspace not found' })
    return null
  }
  if (!workspaces.isActive(ws)) {
    workspaces.planRequired(res, ws)
    return null
  }
  return ws
}

app.post('/api/canvases', (req, res) => {
  const name = String(req.body?.name || 'Untitled canvas')
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : undefined
  if (workspaceId && !requireGrowableWorkspace(req, res, workspaceId)) return
  res.json(store.createCanvas(name, req.user!.id, workspaceId))
})

app.post('/api/canvases/:id/duplicate', async (req, res) => {
  const source = store.getCanvas(req.params.id)
  if (!source) return res.status(404).json({ error: 'not found' })
  if (!hasDurableCanvasAccess(req.user!.id, source)) return res.status(403).json({ error: 'access denied' })
  /* a copy stays in the workspace when the copier is a member of it and the
     workspace may still take canvases; otherwise it lands in their personal space */
  const sourceWs = source.workspaceId ? workspaces.getWorkspace(source.workspaceId) : undefined
  const workspaceId =
    sourceWs && workspaces.isWorkspaceMember(sourceWs.id, req.user!.id) && workspaces.isActive(sourceWs)
      ? sourceWs.id
      : undefined
  try {
    const copy = await store.duplicateCanvas(source.id, req.user!.id, req.user!.name, { workspaceId })
    res.json(copy)
  } catch (error) {
    console.error('[canvas] duplicate failed', error)
    res.status(500).json({ error: 'could not duplicate canvas' })
  }
})

/* `?pageId=<id>` opens the canvas on one page: only its frames carry their HTML,
   the rest arrive `htmlDeferred` (GET /api/frames/:id has the HTML of any). With
   no `pageId` every frame is complete, as it always was. */
app.get('/api/canvases/:id', (req, res) => {
  const c = requireCanvasOrRenderGrant(req, res, req.params.id)
  if (!c) return
  /* the caller's own role rides along, so the editor knows to go read-only */
  const role = req.renderGrant ? ('view' as const) : canvasRole(req.user!.id, c)
  const { pageId } = req.query
  if (pageId === undefined) return res.json({ ...c, role })
  if (typeof pageId !== 'string' || !canvasPages(c).some((page) => page.id === pageId))
    return res.status(400).json({ error: 'page not found' })
  res.json({ ...canvasOpenedOn(c, pageId), role })
})

/* Community gallery listing — the owner's call alone, like link access.
   PUT both lists and re-describes; DELETE takes it down. */
app.put('/api/canvases/:id/publish', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can publish a canvas' })
  if (!publishableFrames(c).length) return res.status(400).json({ error: 'add a frame before publishing' })
  const listing = parseListing(req.body)
  if (typeof listing === 'string') return res.status(400).json({ error: listing })
  const published = store.publishCanvas(c.id, listing)!
  res.json({ publishedAt: published.publishedAt, description: published.description, category: published.category })
})

app.delete('/api/canvases/:id/publish', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can unpublish a canvas' })
  store.unpublishCanvas(c.id)
  res.json({ ok: true })
})

/* Move a canvas into a workspace (its owner, who must be a member, while it
   may grow) or back out to its owner's personal space (the owner, or a
   workspace admin). Moving is an access change, not an edit: every member
   of the target workspace can open it from now on. */
app.put('/api/canvases/:id/workspace', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const target = req.body?.workspaceId
  if (target !== null && typeof target !== 'string')
    return res.status(400).json({ error: 'workspaceId must be a workspace id or null' })
  if (!canManageCanvas(req.user!.id, c))
    return res.status(403).json({ error: 'only the canvas owner or a workspace admin can move it' })
  if (target !== null) {
    if (target === c.workspaceId) return res.json({ ok: true })
    /* an admin's say over a workspace canvas ends at moving it out: re-homing
       it into another workspace — one the owner may not even belong to — is
       the owner's call alone */
    if (c.ownerId !== req.user!.id)
      return res.status(403).json({ error: 'only the canvas owner can move it into a workspace' })
    if (!requireGrowableWorkspace(req, res, target)) return
  }
  store.setWorkspace(c.id, target ?? undefined)
  res.json({ ok: true })
})

app.post('/api/canvases/:id/claim', (req, res) => {
  const c = store.claimCanvas(req.params.id, req.user!.id)
  if (!c) return res.status(409).json({ error: 'not found or already owned' })
  res.json({ ok: true })
})

/* recent activity across all of the user's canvases, for the home dashboard */
app.get('/api/home/activity', (req, res) => {
  const canvases = workspaces.canvasesFor(req.user!.id)
  const items = canvases.flatMap((c) =>
    actions
      .getActivity(c.id)
      .slice(0, 20)
      .map((a) => ({ ...a, canvasId: c.id, canvasName: c.name })),
  )
  items.sort((a, b) => b.at - a.at)
  res.json(items.slice(0, 14))
})

app.delete('/api/canvases/:id', (req, res) => {
  const c = store.getCanvas(req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  /* only the owner (or an admin of its workspace) may delete; unclaimed
     (legacy) canvases are reachable only by direct link and must be claimed
     before they can be destroyed */
  if (!c.ownerId) return res.status(403).json({ error: 'claim it first' })
  if (!canManageCanvas(req.user!.id, c)) return res.status(403).json({ error: 'not yours' })
  actions.deleteCanvas(c.id)
  res.json({ ok: true })
})

app.patch('/api/canvases/:id', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  const { name, linkAccess } = req.body ?? {}
  /* the link policy is the owner's alone — collaborators can rename, not lock */
  if (linkAccess !== undefined) {
    if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can change link access' })
    if (!isLinkAccess(linkAccess))
      return res.status(400).json({ error: 'linkAccess must be "none", "view", "comment" or "edit"' })
    store.setLinkAccess(c.id, linkAccess)
    refreshRoomRoles(c.id)
  }
  if (typeof name === 'string' && name.trim()) {
    const actor = userActor(req)
    actions.renameCanvas(c.id, name.trim(), actor)
  }
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* Collaborators: Figma-style invites. The owner invites existing doop */
/* accounts by email; members get full edit access regardless of the   */
/* link setting. Management is owner-only (members may remove          */
/* themselves); the people list is visible to anyone with access.      */
/* ------------------------------------------------------------------ */

app.get('/api/canvases/:id/members', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  const ids = [...(c.ownerId ? [c.ownerId] : []), ...(c.memberIds ?? [])]
  const rows = ids.length
    ? await db
        .select({
          id: authSchema.user.id,
          name: authSchema.user.name,
          email: authSchema.user.email,
          image: authSchema.user.image,
        })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, ids))
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  res.json(
    ids.map((id) => ({
      userId: id,
      name: byId.get(id)?.name ?? 'Unknown',
      email: byId.get(id)?.email ?? '',
      image: avatarUrl(byId.get(id)?.image),
      owner: id === c.ownerId,
    })),
  )
})

app.post('/api/canvases/:id/members', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can invite people' })
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const [row] = await db
    .select({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      image: authSchema.user.image,
    })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (!row) return res.status(404).json({ error: 'no Diazo account with that email — ask them to sign up first' })
  if (row.id === c.ownerId) return res.status(400).json({ error: 'the owner already has access' })
  const isNew = !c.memberIds?.includes(row.id)
  store.addMember(c.id, row.id, req.user!.id)
  if (isNew) {
    void emailShare(req.user!, row.id, c)
    userEvents.notifyUsers([row.id], { type: 'canvases' })
  }
  res.json({ userId: row.id, name: row.name, email: row.email, image: avatarUrl(row.image), owner: false })
})

app.delete('/api/canvases/:id/members/:userId', (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  if (c.ownerId !== req.user!.id && req.params.userId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner can remove collaborators' })
  if (!store.removeMember(c.id, req.params.userId)) return res.status(404).json({ error: 'not a collaborator' })
  userEvents.notifyUsers([req.params.userId], { type: 'canvases' })
  res.json({ ok: true })
})

/* ---- design-sync keys: mint/list/revoke the write-only snippet creds.
   Owner and invited members only — NOT link-edit visitors. A key is a
   durable bearer credential, so someone whose access is only the share
   link must not be able to mint one (or read an existing secret) and
   keep writing frames after the owner turns the link off. */

function requireDurableCanvas(req: express.Request, res: express.Response, canvasId: string) {
  const c = requireCanvas(req, res, canvasId, 'view')
  if (!c) return null
  if (!hasDurableCanvasAccess(req.user!.id, c)) {
    res.status(403).json({ error: 'sync keys are managed by the owner and invited members' })
    return null
  }
  return c
}

app.get('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const keys = await ingest.listSyncKeys(c.id)
  res.json(keys.map((k) => ({ ...k, frames: ingest.syncedFrameCount(c, k.id) })))
})

app.post('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const key = await ingest.createSyncKey(c.id, String(req.body?.name ?? ''), req.user!.id)
  res.json({ ...key, frames: 0 })
})

/* the flow map is design insight, not a credential — anyone who can see the
   frames can see how they connect */
app.get('/api/canvases/:id/sync-flow', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id, 'view')
  if (!c) return
  res.json(await ingest.getSyncFlow(c))
})

app.delete('/api/canvases/:id/sync-keys/:keyId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await ingest.deleteSyncKey(req.params.id, req.params.keyId)))
    return res.status(404).json({ error: 'sync key not found' })
  res.json({ ok: true })
})

/* ---- Built page (server/built.ts): the canvas's preview-deploy hook. Same
   durable-access rule as sync keys — the secret is a standing credential —
   plus edit, since deliveries write frames. The secret leaves on POST only. */

function requireBuiltCanvas(req: express.Request, res: express.Response, canvasId: string) {
  const c = requireDurableCanvas(req, res, canvasId)
  if (!c) return null
  if (!roleAllows(canvasRole(req.user!.id, c), 'edit')) {
    res.status(403).json({ error: 'deploy hooks need edit access' })
    return null
  }
  return c
}

app.get('/api/canvases/:id/built-hook', async (req, res) => {
  const c = requireBuiltCanvas(req, res, req.params.id)
  if (!c) return
  const row = await built.getHook(c.id)
  res.json({ hook: row ? built.hookInfo(row, c) : null })
})

/* create the hook, or rotate its secret */
app.post('/api/canvases/:id/built-hook', async (req, res) => {
  const c = requireBuiltCanvas(req, res, req.params.id)
  if (!c) return
  const { row, secret } = await built.issueHook(c.id, req.user!.id)
  res.json({ hook: built.hookInfo(row, c), secret })
})

app.put('/api/canvases/:id/built-hook/mappings', async (req, res) => {
  const c = requireBuiltCanvas(req, res, req.params.id)
  if (!c) return
  const raw: unknown = req.body?.mappings
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'mappings must be a list of { route, frame }' })
  const input = raw.map((m: { route?: unknown; frame?: unknown } | null) => ({
    route: typeof m?.route === 'string' ? m.route : '',
    frame: typeof m?.frame === 'string' ? m.frame : '',
  }))
  try {
    await built.setMappings(c, input)
  } catch (error) {
    if (error instanceof built.BuiltInputError) return res.status(400).json({ error: error.message })
    console.error('[built] mappings failed', error)
    return res.status(500).json({ error: 'the mappings could not be saved' })
  }
  const row = await built.getHook(c.id)
  res.json({ hook: row ? built.hookInfo(row, c) : null })
})

app.delete('/api/canvases/:id/built-hook', async (req, res) => {
  const c = requireBuiltCanvas(req, res, req.params.id)
  if (!c) return
  if (!(await built.deleteHook(c.id))) return res.status(404).json({ error: 'no deploy hook on this canvas' })
  res.json({ ok: true })
})

/* ---- GitHub import source: connect a repo, enumerate its screens, land the
   selected ones as frames. Same durable-access rule as sync keys — the
   stored PAT is a standing credential, so link-edit visitors must not be
   able to create or exercise a connection. Tokens never leave the server. */

app.get('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const connections = await github.listConnections(c.id)
  res.json(
    connections.map((conn) => ({ ...github.connectionInfo(conn), frames: github.importedFrameCount(c, conn.id) })),
  )
})

app.post('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  try {
    /* app mode: a signed pass from the install round-trip stands in for the
       token, binding the GitHub App installation to this canvas */
    let grants: githubApp.InstallationGrant[] | undefined
    if (typeof req.body?.pass === 'string') {
      grants = githubApp.redeemInstallPass(req.body.pass, c.id)
      if (!grants) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
    }
    const conn = await github.createConnection({
      canvasId: c.id,
      repo: String(req.body?.repo ?? ''),
      token: typeof req.body?.token === 'string' ? req.body.token : undefined,
      grants,
      branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
      createdBy: req.user!.id,
    })
    res.json({ ...github.connectionInfo(conn), frames: 0 })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect the repository' })
  }
})

/* ---- GitHub App install flow: click Connect on the canvas, pick repos on
   GitHub's install screen, land back on the canvas with a repo picker. The
   signed state/pass pair keeps guessable installation ids from being bound
   to canvases that never started an install (server/githubApp.ts). */

app.get('/api/github/app', (req, res) => {
  res.json({ enabled: githubApp.appEnabled(), slug: githubApp.appSlug() })
})

app.post('/api/canvases/:id/github/app/start', (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  if (!githubApp.appEnabled()) return res.status(400).json({ error: 'the GitHub App is not configured' })
  /* authorize first: it finds installations the user already has, so a new
     canvas skips the install screen (see the setup callback) */
  res.json({ url: githubApp.oauthBounceUrl(githubApp.signFindState(c.id, req.user!.id)) })
})

/* "Add repositories on GitHub" from the repo picker: a plain link the
   picker opens in a new tab, straight to the install screen with a state
   for this canvas, so a fresh install on another account returns here too. */
app.get('/api/canvases/:id/github/app/install', (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  if (!githubApp.appEnabled()) return res.status(400).json({ error: 'the GitHub App is not configured' })
  res.redirect(githubApp.installUrl(githubApp.signInstallState(c.id, req.user!.id)))
})

/* GitHub's post-install redirect (the app's callback URL, with "request
   user authorization during installation" on). Verifies the state minted at
   start AND that the OAuth code's user actually owns the installation —
   installation ids are guessable, and without the ownership proof a valid
   state could bind someone else's installation. The same user token lists
   the repos GitHub lets THIS user reach through it (an org installation
   covers more than one member may see); that snapshot is what the pass
   stands for. Then swaps state for the pass and returns to the canvas,
   where the import modal shows the repo picker. */
app.get('/api/github/app/setup', async (req, res) => {
  const rawState = String(req.query.state ?? '')
  const code = String(req.query.code ?? '')
  /* failures land back on the canvas with a visible reason — a silent
     homepage redirect reads as "nothing happened" */
  const fail = (canvasId: string, reason: string) =>
    res.redirect(`/c/${encodeURIComponent(canvasId)}?ghError=${encodeURIComponent(reason)}`)
  const succeed = (canvasId: string, grants: githubApp.InstallationGrant[]) =>
    res.redirect(
      `/c/${encodeURIComponent(canvasId)}?ghInstall=${encodeURIComponent(githubApp.issueInstallPass(canvasId, grants))}`,
    )

  /* return leg of Connect's authorize step: the installations this GitHub
     user already has go straight to the repo picker; none, on to install */
  const find = githubApp.verifyFindState(rawState)
  if (find) {
    if (!code) return fail(find.canvasId, 'GitHub authorization was cancelled — connect again when you’re ready')
    try {
      const grants = await githubApp.userAccess(code)
      if (grants?.length) return succeed(find.canvasId, grants)
      if (grants) return res.redirect(githubApp.installUrl(githubApp.signInstallState(find.canvasId, find.userId)))
    } catch {
      /* fall through to the error redirect */
    }
    return fail(find.canvasId, 'GitHub couldn’t confirm your account — try connecting again')
  }

  /* return leg of the already-installed bounce: the authorize round-trip
     produced the code the configure screen didn't */
  const oauth = githubApp.verifyOauthState(rawState)
  if (oauth) {
    try {
      const grants = await githubApp.userAccess(code, [oauth.installationId])
      if (grants?.length) return succeed(oauth.canvasId, grants)
    } catch {
      /* fall through to the error redirect */
    }
    return fail(oauth.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
  }

  const state = githubApp.verifyInstallState(rawState)
  if (!state) return res.redirect('/')
  const installationId = String(req.query.installation_id ?? '')
  if (!/^\d+$/.test(installationId))
    return fail(state.canvasId, 'GitHub sent no installation back — try connecting again')

  /* app already installed on that account: GitHub showed the configure
     screen and returned WITHOUT an OAuth code — bounce through authorize
     (instant for an already-authorized user) purely to get one */
  if (!code) return res.redirect(githubApp.oauthBounceUrl(githubApp.signOauthState(state.canvasId, installationId)))

  try {
    const grants = await githubApp.userAccess(code, [installationId])
    if (grants?.length) return succeed(state.canvasId, grants)
  } catch {
    /* fall through to the error redirect */
  }
  return fail(state.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
})

app.get('/api/canvases/:id/github/app/repos', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const grants = githubApp.redeemInstallPass(String(req.query.pass ?? ''), c.id)
  if (!grants) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
  res.json(githubApp.listReposAcross(grants))
})

app.delete('/api/canvases/:id/github/:connId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await github.deleteConnection(req.params.id, req.params.connId)))
    return res.status(404).json({ error: 'connection not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/github/:connId/analyze', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  try {
    res.json(await github.analyzeConnection(conn))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'repository analysis failed' })
  }
})

/* one import at a time per repo connection — see the route */
const connectionLocks = new Map<string, Promise<unknown>>()
async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  connectionLocks.set(connectionId, tail)
  try {
    return await run
  } finally {
    if (connectionLocks.get(connectionId) === tail) connectionLocks.delete(connectionId)
  }
}

app.post('/api/canvases/:id/github/:connId/import', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  // The pilot owns this user's routing. Reject before analysis, metering or
  // queueing instead of accepting cards that its canvas-only harness cannot run.
  if (geminiCloudWorkerFor(req.user!.id)) {
    return res.status(409).json({
      error:
        'Repository imports are unavailable while the Gemini cloud pilot is selected. Ask your operator to disable the pilot, then select a provider that supports repository imports.',
    })
  }
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
  /* design-system-only import is the headline flow now — screens optional */
  const designSystem = req.body?.design_system !== false
  const rawScreens = Array.isArray(req.body?.screens) ? (req.body.screens as unknown[]) : []
  if (!rawScreens.length && !designSystem)
    return res.status(400).json({ error: 'pick components or screens, or enable the design-system extraction' })
  try {
    /* the selection is resolved against a manifest computed right now — see
       matchSelection for why the client never dictates paths */
    const { screens, rejected } = rawScreens.length
      ? github.matchSelection((await github.analyzeConnection(conn)).screens, rawScreens)
      : { screens: [], rejected: [] }
    const input = { connectionId: conn.id, repo: conn.repo, screens, designSystem }
    /* plan → gate → queue runs one import at a time per connection, so two
       overlapping imports of the same screens cannot both pass the plan and
       both pay while only one queues */
    const outcome = await withConnectionLock(conn.id, async () => {
      /* nothing new to queue (all rejected, or already on the board) costs nothing */
      if (!actions.planRepoCards(c.id, input).length) return { cards: [] as string[] }
      /* the import is the Doop Agent's work, card by card — same gate as a card
         typed on the board: a free task, or the requester's own model account */
      const gate = await allowance.consumeResidentTask(req.user!.id)
      if (!gate.ok) return { limit: gate }
      const cards = actions.addRepoCards(c.id, input, req.user!.name, req.user!.id)
      return { cards: cards.map((card) => card.id) }
    })
    if (outcome.limit)
      return res.status(403).json({ error: 'resident_limit', used: outcome.limit.used, limit: outcome.limit.limit })
    res.json({ cards: outcome.cards, rejected })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

/* upsert a named design doc; empty markdown deletes it (same permission
   model as rename: any signed-in user with access) */
/* doc history, newest first — '' markdown rows mark deletions */
app.get('/api/canvases/:id/guidelines/:name/history', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  const rows = await persist.listGuidelineVersions(req.params.id, req.params.name.toLowerCase())
  res.json(rows.map((v) => ({ markdown: v.markdown, savedAt: v.savedAt, savedBy: v.savedBy })))
})

/* design tokens (shared/designTokens.ts): the canvas's CSS custom properties.
   `?format=css|tailwind|md` exports them for a codebase; the default is JSON. */
app.get('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  const tokens = store.getTokens(req.params.id)
  const themes = store.getTokenThemes(req.params.id)
  switch (req.query.format) {
    case 'css':
      return res.type('text/css').send(tokensCss(tokens, themes))
    case 'tailwind':
      return res.type('text/css').send(tokensTailwind(tokens, themes))
    case 'md':
      return res.type('text/markdown').send(tokensMarkdown(tokens, themes))
    default:
      return res.json(tokens)
  }
})

/* the token themes (light, dark, …), in display order; a theme that leaves takes its values along */
app.put('/api/canvases/:id/token-themes', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const themes = actions.setTokenThemes(req.params.id, req.body?.themes, userActor(req), req.body?.renames ?? [])
    if (!themes) return res.status(404).json({ error: 'not found' })
    res.json({ themes, tokens: store.getTokens(req.params.id) })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid themes' })
  }
})

app.post('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const inputs = Array.isArray(req.body?.tokens) ? req.body.tokens : [req.body]
  if (inputs.length > 200) return res.status(400).json({ error: 'at most 200 tokens per request' })
  const results = actions.createTokens(req.params.id, inputs, userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  res.json({ results, tokens: store.getTokens(req.params.id) })
})

/* change, rename (newName) or delete (delete: true) one token by name */
app.put('/api/canvases/:id/tokens/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {}
  const edit = { ...body, name: req.params.name }
  const results = actions.setTokens(req.params.id, [edit], userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  const [result] = results
  if (result?.result === 'error') return res.status(400).json({ error: result.message })
  res.json({ result, tokens: store.getTokens(req.params.id) })
})

app.delete('/api/canvases/:id/tokens/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const results = actions.setTokens(req.params.id, [{ name: req.params.name, delete: true }], userActor(req))
  if (!results) return res.status(404).json({ error: 'not found' })
  const [result] = results
  if (result?.result === 'error') return res.status(400).json({ error: result.message })
  res.json({ ok: true, tokens: store.getTokens(req.params.id) })
})

/* the styleguide: the canvas's tokens and its guidelines as one markdown
   document — what a coding agent pulls into a repo as its DESIGN.md */
app.get('/api/canvases/:id/styleguide.md', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const tokens = store.getTokens(req.params.id)
  const themes = store.getTokenThemes(req.params.id)
  const docs = store.getGuidelines(req.params.id)
  const parts = [
    `# ${canvas.name} — styleguide`,
    ...(tokens.length
      ? [
          `## Design tokens\n\nUse these as CSS custom properties (\`var(--name)\`); the Tailwind v4 \`@theme\` block and plain CSS are at \`/api/canvases/${canvas.id}/tokens?format=tailwind|css\`.`,
          tokensMarkdown(tokens, themes),
          '```css\n' + tokensCss(tokens, themes) + '\n```',
        ]
      : []),
    ...docs.map((d) => `## ${actions.guidelineTitle(d)}\n\n${d.markdown}`),
  ]
  res.type('text/markdown').send(parts.join('\n\n') + '\n')
})

app.put('/api/canvases/:id/guidelines/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const { markdown, x, y, title } = req.body ?? {}
  /* no markdown = metadata patch (position/title): content and history untouched */
  if (markdown === undefined) {
    const patch = {
      ...(x !== undefined || y !== undefined ? { x: Number(x), y: Number(y) } : {}),
      ...(typeof title === 'string' ? { title } : {}),
    }
    if (!actions.patchGuideline(req.params.id, req.params.name, patch, actor))
      return res.status(404).json({ error: 'not found' })
    return res.json({ ok: true })
  }
  try {
    const pos = typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
    const doc = actions.setGuideline(
      req.params.id,
      req.params.name,
      String(markdown ?? ''),
      actor,
      pos,
      typeof title === 'string' ? title : undefined,
    )
    if (doc === undefined) return res.status(404).json({ error: 'not found' })
    res.json(doc ? { ok: true, doc } : { ok: true, deleted: true })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid doc' })
  }
})

/* canvas skills (shared/skills.ts): read by anyone who may view the canvas,
   as guideline history is, written by editors */
app.get('/api/canvases/:id/skills', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  res.json({ skills: store.getSkills(req.params.id) })
})

app.put('/api/canvases/:id/skills/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const { description, markdown } = req.body ?? {}
  if (typeof markdown !== 'string' || (description !== undefined && typeof description !== 'string'))
    return res.status(400).json({ error: 'markdown (string) and an optional description (string) are expected' })
  try {
    const skill = actions.setSkill(req.params.id, { name: req.params.name, description, markdown }, userActor(req))
    if (skill === undefined) return res.status(404).json({ error: 'not found' })
    res.json(skill ? { ok: true, skill } : { ok: true, deleted: true })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid skill' })
  }
})

app.delete('/api/canvases/:id/skills/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const gone = actions.setSkill(req.params.id, { name: req.params.name, markdown: '' }, userActor(req))
    if (gone === undefined) return res.status(404).json({ error: 'not found' })
    res.json({ ok: true, deleted: gone === null })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid skill' })
  }
})

/* design memory: pin/unpin reference frames, accept/dismiss rule proposals */
app.post('/api/canvases/:id/references', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  try {
    const ref = actions.pinReference(req.params.id, String(req.body?.frameId ?? ''), actor)
    if (!ref) return res.status(404).json({ error: 'canvas or frame not found' })
    res.json(ref)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'pin failed' })
  }
})

app.delete('/api/canvases/:id/references/:refId', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  if (!actions.unpinReference(req.params.id, req.params.refId, actor))
    return res.status(404).json({ error: 'reference not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/proposals/:pid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const proposal = actions.resolveProposal(req.params.id, req.params.pid, !!req.body?.accept, actor)
  if (!proposal) return res.status(404).json({ error: 'proposal not found' })
  res.json(proposal)
})

/* Browser asset uploads (paste / drop): raw image bytes in, permanent /a/
   URL out. Same createAsset pipeline as the MCP ticket flow — the bytes are
   sniffed for the real type and capped at 5 MB. express.json ignores the
   image content-type, so express.raw here sees the untouched stream. */
app.post(
  '/api/canvases/:id/assets',
  express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
  async (req, res) => {
    const c = requireCanvas(req, res, req.params.id, 'edit')
    if (!c) return
    try {
      const asset = await createAsset(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
        canvasId: c.id,
        ownerId: req.user!.id,
        uploadedBy: req.user!.name,
      })
      /* absolute like the MCP flow: frame HTML renders inside sandboxed
         srcdoc iframes where root-relative URLs don't resolve */
      res.json({ url: `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`, mime: asset.mime, size: asset.size })
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
    }
  },
)

app.put('/api/canvases/:id/pages', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pages = req.body?.pages
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > maxPages(canvas) ||
    pages.some(
      (p) =>
        !p ||
        typeof p.id !== 'string' ||
        !p.id.trim() ||
        p.id.length > 100 ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 100,
    ) ||
    new Set(pages.map((p) => p.id)).size !== pages.length
  ) {
    return res.status(400).json({
      error: `Provide 1–${maxPages(canvas).toLocaleString('en-US')} pages with unique IDs and names of up to 100 characters.`,
    })
  }
  if (!samePages(req.body?.expectedPages, canvasPages(canvas)))
    return res
      .status(409)
      .json({ error: 'Pages changed since you opened them. Please try again.', pages: canvasPages(canvas) })
  const firstId = canvas.pages?.[0]?.id ?? `${canvas.id}:page1`
  if (canvas.frames.some((f) => !pages.some((p) => p.id === (f.pageId ?? firstId)))) {
    return res.status(400).json({ error: 'Move the frames to another page before deleting this page.' })
  }
  const clean = pages.map((p) => ({ id: p.id, name: p.name.trim() }))
  const actor = userActor(req)
  res.json(actions.setCanvasPages(canvas.id, clean, actor))
})

/* a page's own canvas colour (`#rrggbb`); null puts the theme paper back */
app.put('/api/canvases/:id/pages/:pageId/background', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const color: unknown = req.body?.color
  const background = color === null ? null : normalizePageBackground(color)
  if (color !== null && !background)
    return res.status(400).json({ error: 'color must be a hex colour such as #f5f5f5, or null' })
  if (!canvasPages(canvas).some((p) => p.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  const actor = userActor(req)
  res.json(actions.setPageBackground(canvas.id, req.params.pageId, background, actor))
})

/* the frame a page's prototype flow starts on; null clears it */
app.put('/api/canvases/:id/pages/:pageId/flow-start', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const frameId: unknown = req.body?.frameId
  if (frameId !== null && typeof frameId !== 'string')
    return res.status(400).json({ error: 'frameId must be a string or null' })
  if (!canvasPages(canvas).some((p) => p.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  if (frameId !== null) {
    const frame = canvas.frames.find((f) => f.id === frameId)
    if (!frame) return res.status(400).json({ error: `no frame ${frameId} on this canvas` })
    if (framePageId(canvas, frame) !== req.params.pageId)
      return res.status(400).json({ error: 'the start frame must be on the same page' })
  }
  const actor = userActor(req)
  res.json(actions.setFlowStart(canvas.id, req.params.pageId, frameId, actor))
})

/* Ruler guides, one per request so two people dragging different guides
   never overwrite each other. The id is the client's, which lets undo put
   a removed guide back as itself. */
app.put('/api/canvases/:id/guides/:guideId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const guide = parseGuide(
    req.params.guideId,
    req.body,
    canvasPages(canvas).map((page) => page.id),
  )
  if (typeof guide === 'string') return res.status(400).json({ error: guide })
  const actor = userActor(req)
  try {
    res.json(actions.setGuide(canvas.id, guide, actor))
  } catch (e) {
    if (e instanceof GuideLimitError) return res.status(400).json({ error: e.message })
    throw e
  }
})

app.delete('/api/canvases/:id/guides/:guideId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const actor = userActor(req)
  /* idempotent: a guide a collaborator already removed is just as gone */
  actions.deleteGuide(canvas.id, req.params.guideId, actor)
  res.json({ ok: true })
})

app.post('/api/canvases/:id/pages/:pageId/duplicate', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  if (!canvasPages(canvas).some((page) => page.id === req.params.pageId))
    return res.status(404).json({ error: 'page not found' })
  const actor = userActor(req)
  try {
    const copy = await actions.duplicatePage(canvas.id, req.params.pageId, actor)
    if (!copy) return res.status(404).json({ error: 'page not found' })
    res.json({ page: copy.page, pages: copy.pages, frames: copy.frames })
  } catch (e) {
    if (e instanceof PageLimitError || e instanceof GuideLimitError) return res.status(400).json({ error: e.message })
    console.error('[pages] duplicate failed', e)
    res.status(500).json({ error: 'Could not duplicate the page. Please try again.' })
  }
})

/* ------------------------------------------------------------------ */
registerSpeechRoutes(app)
registerBlenderRoutes(app)

/* Motion Studio: a page's timeline (shared/motion.ts, docs/motion-api)  */
/* ------------------------------------------------------------------ */

/* a page's composition: view reads it, edit writes it whole (PUT), as ops
   (PATCH) or removes it (DELETE). expectedRevision guards concurrent
   writers: 409 when the timeline moved under them. */
app.get('/api/canvases/:id/pages/:pageId/composition', (req, res) => {
  const canvas = requireCanvasOrRenderGrant(req, res, req.params.id)
  if (!canvas) return
  /* the token is page-bound as well: it only reads its own page */
  if (req.renderGrant && req.renderGrant.pageId !== req.params.pageId)
    return res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
  res.json({ composition: store.getComposition(canvas.id, req.params.pageId) ?? null })
})

app.put('/api/canvases/:id/pages/:pageId/composition', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pageId = req.params.pageId
  if (!canvasPages(canvas).some((p) => p.id === pageId)) return res.status(404).json({ error: 'page not found' })
  const parsed = parseCompositionBody(req.body)
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })
  const existing = store.getComposition(canvas.id, pageId)
  const expected = req.body?.expectedRevision
  if (expected !== undefined) {
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
      return res.status(400).json({ error: 'expectedRevision must be an integer' })
    }
    if ((existing?.revision ?? 0) !== expected) {
      return res.status(409).json({ error: 'the composition changed since you read it', composition: existing ?? null })
    }
  }
  res.json({ composition: actions.setComposition(canvas.id, parsed.value, pageId, userActor(req)) })
})

app.patch('/api/canvases/:id/pages/:pageId/composition', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pageId = req.params.pageId
  const existing = store.getComposition(canvas.id, pageId)
  if (!existing) return res.status(404).json({ error: 'the page has no composition — PUT one first' })
  const expected = req.body?.expectedRevision
  if (expected !== undefined) {
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
      return res.status(400).json({ error: 'expectedRevision must be an integer' })
    }
    if (existing.revision !== expected) {
      return res.status(409).json({ error: 'the composition changed since you read it', composition: existing })
    }
  }
  const ops = parseOps(req.body?.ops, existing.duration)
  if (!ops.ok) return res.status(400).json({ error: ops.error })
  const applied = actions.patchComposition(canvas.id, pageId, ops.value, userActor(req))
  if (!applied.ok) return res.status(400).json({ error: applied.error })
  res.json({ composition: applied.composition })
})

/* interchange (phase 5): import a Lottie or HyperFrames document as this
   page's composition — restricted to the shared vector subset; the export
   side rides the ?format switch on the code-export route below */
app.post('/api/canvases/:id/pages/:pageId/composition/import', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pageId = req.params.pageId
  if (!canvasPages(canvas).some((p) => p.id === pageId)) return res.status(404).json({ error: 'page not found' })
  const format = String(req.body?.format ?? '')
  const converted =
    format === 'lottie'
      ? lottieToTracks(req.body?.data, Number(req.body?.fps) || 30)
      : format === 'hyperframes'
        ? hyperframesToTracks(req.body?.data)
        : { ok: false as const, error: 'format must be lottie or hyperframes' }
  if (!converted.ok) return res.status(400).json({ error: converted.error })
  /* the imported tracks ride through the same validator a PUT takes */
  const parsed = parseCompositionBody({
    duration: req.body?.duration ?? 5,
    fps: req.body?.fps ?? 30,
    width: req.body?.width ?? 1920,
    height: req.body?.height ?? 1080,
    tracks: converted.tracks,
  })
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })
  res.json({ composition: actions.setComposition(canvas.id, parsed.value, pageId, userActor(req)) })
})

app.delete('/api/canvases/:id/pages/:pageId/composition', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  actions.deleteComposition(canvas.id, req.params.pageId, userActor(req))
  res.json({ ok: true })
})

/* render jobs: records a browser tab or the desktop shell claims, reports
   on and uploads into an /a/ asset */
app.get('/api/canvases/:id/pages/:pageId/composition/renders', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  res.json({ jobs: listRenderJobs(canvas.id).filter((j) => j.pageId === req.params.pageId) })
})

app.post('/api/canvases/:id/pages/:pageId/composition/renders', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pageId = req.params.pageId
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return res.status(404).json({ error: 'the page has no composition — make the timeline first' })
  if (req.body?.target === 'server' && env.SERVER_RENDER_DISABLED) {
    return res.status(503).json({ error: 'server renders are off on this instance' })
  }
  const created = createRenderJob({
    composition: comp,
    format: req.body?.format,
    target: req.body?.target,
    engine: req.body?.engine,
    width: req.body?.width,
    height: req.body?.height,
    fps: req.body?.fps,
    range: req.body?.range,
    by: { id: req.user!.id, name: req.user!.name },
  })
  if (!created.ok) return res.status(created.status).json({ error: created.error })
  /* a server-target job renders on the instance itself, in the background */
  if (created.job.target === 'server') queueServerRender(created.job)
  res.status(201).json({ job: created.job })
})

/* the undo history: every write files the replaced state; restoring one
   re-saves it as the live composition (which files the state it replaced —
   so a restore is itself undoable) */
app.get('/api/canvases/:id/pages/:pageId/composition/versions', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const comp = store.getComposition(canvas.id, req.params.pageId)
  if (!comp) return res.status(404).json({ error: 'the page has no composition' })
  const versions = (await persist.listCompositionVersions(canvas.id, comp.id)).map((v) => ({
    id: v.id,
    savedAt: v.savedAt,
    savedBy: v.savedBy,
    savedByKind: v.savedByKind,
    duration: v.state.duration,
    trackCount: v.state.tracks.length,
    revision: v.state.revision,
  }))
  res.json({ versions })
})

app.post('/api/canvases/:id/pages/:pageId/composition/versions/:versionId/restore', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const pageId = req.params.pageId
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return res.status(404).json({ error: 'the page has no composition' })
  const version = await persist.getCompositionVersion(canvas.id, req.params.versionId)
  if (!version || version.compositionId !== comp.id) {
    return res.status(404).json({ error: 'no such version on this composition' })
  }
  const parsed = parseCompositionBody(version.state)
  if (!parsed.ok) return res.status(409).json({ error: `the stored version no longer validates: ${parsed.error}` })
  res.json({ composition: actions.setComposition(canvas.id, parsed.value, pageId, userActor(req)) })
})

/* "copy as code": the composition compiled to CSS + WAAPI with motion
   token names kept (docs/motion-api.md § code export). ?format=lottie or
   hyperframes instead ships the interchange document (phase 5). */
app.get('/api/canvases/:id/pages/:pageId/composition/export', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const format = typeof req.query.format === 'string' ? req.query.format : ''
  if (format === 'lottie' || format === 'hyperframes') {
    const comp = store.getComposition(canvas.id, req.params.pageId)
    if (!comp) return res.status(404).json({ error: 'the page has no composition' })
    return res.json(format === 'lottie' ? compositionToLottie(comp) : compositionToHyperframes(comp))
  }
  if (format && format !== 'code') {
    return res.status(400).json({ error: 'format must be code, lottie or hyperframes' })
  }
  const out = await exportComposition(canvas, req.params.pageId)
  if (!out.ok) return res.status(404).json({ error: out.error })
  res.json(out.data)
})

/* ---- scene_media (phase 3): per-page state of a media asset — trim, cuts,
   beats, transcript, generation recipe (shared/motionMedia.ts) ---- */

app.get('/api/canvases/:id/pages/:pageId/media', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  res.json({ media: await persist.listSceneMedia(canvas.id, req.params.pageId) })
})

app.put('/api/canvases/:id/pages/:pageId/media/:assetId', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const body = parseMediaBody(req.body)
  if (!body) return res.status(400).json({ error: 'not a valid scene_media body' })
  const pageId = req.params.pageId
  const assetId = req.params.assetId
  const now = Date.now()
  const prev = await persist.findSceneMediaByAsset(canvas.id, pageId, assetId)
  const media = {
    id: prev?.id ?? nanoid(10),
    canvasId: canvas.id,
    pageId,
    assetId,
    ...body,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  persist.saveSceneMedia(media)
  res.json({ media })
})

app.delete('/api/canvases/:id/pages/:pageId/media/:mediaId', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const media = await persist.getSceneMedia(canvas.id, req.params.mediaId)
  if (!media || media.pageId !== req.params.pageId) return res.status(404).json({ error: 'no such media row' })
  persist.deleteSceneMedia(canvas.id, media.id)
  res.json({ ok: true })
})

app.get('/api/renders/:id', (req, res) => {
  const job = getRenderJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'no such render job' })
  if (!requireCanvas(req, res, job.canvasId, 'view')) return
  res.json({ job })
})

app.patch('/api/renders/:id', (req, res) => {
  const job = getRenderJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'no such render job' })
  if (!requireCanvas(req, res, job.canvasId, 'edit')) return
  const body = req.body ?? {}
  const claimedBy = typeof body.claimedBy === 'string' && body.claimedBy.length <= 100 ? body.claimedBy : undefined
  const patched = patchRenderJob(
    job,
    {
      status: body.status,
      progress: body.progress,
      error: body.error,
      claimedBy,
    },
    claimedBy ?? `user:${req.user!.id}`,
  )
  if (!patched.ok) return res.status(patched.status).json({ error: patched.error })
  res.json({ job: patched.job })
})

/* the finished file: raw video bytes sniffed against the job's format,
   stored as an /a/ asset; marks the job done */
app.put(
  '/api/renders/:id/upload',
  express.raw({ type: () => true, limit: MOTION_LIMITS.RENDER_MAX_BYTES }),
  async (req, res) => {
    const job = getRenderJob(req.params.id)
    if (!job) return res.status(404).json({ error: 'no such render job' })
    if (!requireCanvas(req, res, job.canvasId, 'edit')) return
    if (job.status === 'done') return res.status(409).json({ error: 'the job already has its file' })
    if (job.status === 'failed' || job.status === 'canceled') {
      return res.status(409).json({ error: `the job is ${job.status}` })
    }
    const buf = req.body as Buffer
    if (!Buffer.isBuffer(buf) || buf.length === 0)
      return res.status(400).json({ error: 'send the video file as the body' })
    if (buf.length > MOTION_LIMITS.RENDER_MAX_BYTES) {
      return res.status(413).json({ error: `over ${Math.round(MOTION_LIMITS.RENDER_MAX_BYTES / 1024 / 1024)} MB` })
    }
    const isMp4 = buf.length > 11 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
    const isWebm = buf.length > 3 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
    /* GIF89a/GIF87a magic, or a PK zip for a pngseq */
    const isGif = buf.length > 5 && buf.subarray(0, 4).toString('latin1') === 'GIF8'
    const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
    const sniffed = isMp4
      ? { format: 'mp4', mime: 'video/mp4', ext: 'mp4' }
      : isWebm
        ? { format: 'webm', mime: 'video/webm', ext: 'webm' }
        : isGif
          ? { format: 'gif', mime: 'image/gif', ext: 'gif' }
          : isZip
            ? { format: 'pngseq', mime: 'application/zip', ext: 'zip' }
            : null
    if (!sniffed) return res.status(400).json({ error: 'not an mp4, webm, gif or zip file' })
    if (job.format !== sniffed.format) {
      return res.status(400).json({ error: `the job wants ${job.format}, the file is ${sniffed.format}` })
    }
    const { mime, ext } = sniffed
    const asset = await storeAsset(
      buf,
      { mime, ext },
      { canvasId: job.canvasId, ownerId: req.user!.id, uploadedBy: req.user!.name },
    )
    res.json({ job: finishRenderJob(job, asset.id), asset: { id: asset.id, url: `/a/${asset.id}.${ext}` } })
  },
)

app.delete('/api/renders/:id', (req, res) => {
  const job = getRenderJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'no such render job' })
  if (!requireCanvas(req, res, job.canvasId, 'edit')) return
  res.json({ job: cancelRenderJob(job) })
})

app.post('/api/canvases/:id/frames', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const { name, pageId, x, y, width, height, html, hidden, locked, z, rotation } = req.body ?? {}
  if (pageId !== undefined && !store.getCanvas(req.params.id)?.pages?.some((p) => p.id === pageId))
    return res.status(400).json({ error: 'page not found' })
  const actor = userActor(req)
  /* `hidden`, `locked` and `z` let undo bring a deleted frame back as it was */
  const frame = actions.createFrame(
    req.params.id,
    {
      name: String(name || 'Frame'),
      pageId,
      x,
      y,
      width,
      height,
      html,
      hidden: hidden === true,
      locked: locked === true,
      z: Number.isFinite(z) ? z : undefined,
      rotation: normalizeRotation(rotation),
    },
    actor,
  )
  if (!frame) return res.status(404).json({ error: 'canvas not found' })
  res.json(frame)
})

/* the Layers panel's stacking order for several frames at once: all of
   them or none */
app.put('/api/canvases/:id/stack', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const writes: unknown = req.body?.frames
  if (
    !Array.isArray(writes) ||
    writes.length === 0 ||
    writes.length > MAX_STACK_WRITES ||
    !writes.every((w) => typeof w?.id === 'string' && Number.isFinite(w?.z))
  )
    return res.status(400).json({ error: 'frames must be a list of { id, z }' })
  const frames = actions.restackFrames(
    req.params.id,
    writes.map((w: StackWrite) => ({ id: w.id, z: w.z })),
    userActor(req),
  )
  if (!frames) return res.status(404).json({ error: 'frame not found' })
  res.json(frames)
})

app.get('/api/frames/:id', (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'view')
  if (frame) res.json(frame)
})

app.patch('/api/frames/:id', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)
  if (!current) return
  const { actor: _ignored, expectedUpdatedAt: _version, ...patch } = req.body ?? {}
  const actor = userActor(req)
  if (
    patch.pageId !== undefined &&
    !store.getCanvas(store.getFrame(req.params.id)!.canvasId)?.pages?.some((p) => p.id === patch.pageId)
  )
    return res.status(400).json({ error: 'page not found' })
  const allowed = ['name', 'pageId', 'x', 'y', 'width', 'height', 'html'] as const
  const clean: Record<string, unknown> = {}
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k]
  /* the eye in the Layers panel: anything but a literal true shows the frame */
  if (patch.hidden !== undefined) clean.hidden = patch.hidden === true
  if (patch.locked !== undefined) clean.locked = !!patch.locked
  /* the stacking order the Layers panel sets */
  if (patch.z !== undefined) {
    if (!Number.isFinite(patch.z)) return res.status(400).json({ error: 'z must be a finite number' })
    clean.z = patch.z
  }
  /* a turn about the centre, stored in (-180, 180]; null or 0 straightens */
  if (patch.rotation !== undefined) {
    if (patch.rotation !== null && !Number.isFinite(patch.rotation))
      return res.status(400).json({ error: 'rotation must be a finite number of degrees' })
    clean.rotation = normalizeRotation(patch.rotation)
  }
  const frame = actions.updateFrame(req.params.id, clean, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json(frame)
})

/* Components. Reads are for anyone who can see the canvas; everything else edits it. */
function componentContext(req: express.Request, canvas: Canvas) {
  return { canvas, actor: userActor(req) }
}

/* The REST bodies, typed like the MCP tools' input (the same zod pieces), so a
   malformed field is a 400 and never reaches the engine; `head` is a library
   pull's alone and is not accepted here. */
const componentCreateBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  props: z.array(propSchema).optional(),
  code: codeSchema.optional(),
  frameId: z.string().optional(),
  element: z.string().optional(),
  autoProps: z.boolean().optional(),
  replaceMatching: z.boolean().optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})
const componentPatchBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  props: z.array(propSchema).optional(),
  code: codeSchema.nullable().optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
  expectedRev: z.number().optional(),
  dryRun: z.boolean().optional(),
})

function componentBody<T>(res: express.Response, schema: z.ZodType<T>, body: unknown): T | undefined {
  const parsed = schema.safeParse(body ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` })
  return undefined
}

function componentRoute(res: express.Response, run: () => unknown) {
  try {
    res.json(run())
  } catch (error) {
    if (error instanceof ComponentError) return res.status(400).json({ error: error.message })
    throw error
  }
}

app.get('/api/canvases/:id/components', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  res.json((canvas.components ?? []).map((def) => componentDetail(canvas, def)))
})

/* other canvases this person can read that hold components: the import picker.
   Importing takes edit, and this walks every canvas the person can read, so a
   viewer gets no such scan */
app.get('/api/canvases/:id/component-libraries', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  res.json(
    workspaces.canvasesFor(req.user!.id).flatMap((meta) => {
      const other = store.getCanvas(meta.id)
      if (!other || other.id === canvas.id || !other.components?.length) return []
      return [{ id: other.id, name: other.name, components: other.components.map((def) => catalogEntry(other, def)) }]
    }),
  )
})

/* parses every frame on the canvas: for the editors who can act on it */
app.get('/api/canvases/:id/component-candidates', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  res.json(findComponentCandidates(canvas))
})

app.post('/api/canvases/:id/components', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const { actor } = componentContext(req, canvas)
  const body = componentBody(res, componentCreateBody, req.body)
  if (!body) return
  componentRoute(res, () => {
    if (typeof body.html === 'string') {
      return {
        component: createComponentFromHtml(
          canvas.id,
          { ...body, html: body.html, props: body.props as never, name: String(body.name ?? '') },
          actor,
        ),
        converted: [],
      }
    }
    const created = createComponentFromElement(
      canvas.id,
      {
        name: String(body.name ?? ''),
        description: body.description,
        props: body.props as never,
        code: body.code,
        frameId: String(body.frameId ?? ''),
        element: String(body.element ?? ''),
        autoProps: body.autoProps,
        replaceMatching: body.replaceMatching === true,
      },
      actor,
    )
    /* what the editor needs to undo this as one step */
    const changed = new Set([String(body.frameId), ...created.converted.map((entry) => entry.frameId)])
    return { ...created, frames: [...changed].flatMap((id) => store.getFrame(id) ?? []) }
  })
})

app.post('/api/canvases/:id/components/import', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const source = String(req.body?.sourceCanvasId ?? '')
  const origin = store.getCanvas(source)
  if (!origin || !roleAllows(canvasRole(req.user!.id, origin), 'view'))
    return res.status(403).json({ error: 'this account cannot read that canvas' })
  componentRoute(res, () => importComponent(canvas.id, source, String(req.body?.component ?? ''), userActor(req)))
})

app.patch('/api/canvases/:id/components/:componentId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  const body = componentBody(res, componentPatchBody, req.body)
  if (!body) return
  componentRoute(res, () =>
    updateComponent(canvas.id, req.params.componentId, { ...body, props: body.props as never }, userActor(req)),
  )
})

app.delete('/api/canvases/:id/components/:componentId', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () => deleteComponent(canvas.id, req.params.componentId, userActor(req)))
})

app.post('/api/canvases/:id/components/:componentId/restore', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () =>
    restoreComponentVersion(canvas.id, req.params.componentId, Number(req.body?.rev), userActor(req)),
  )
})

app.post('/api/canvases/:id/components/:componentId/sync', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  componentRoute(res, () =>
    syncComponent(canvas.id, req.params.componentId, userActor(req), (id) => {
      const other = store.getCanvas(id)
      return !!other && roleAllows(canvasRole(req.user!.id, other), 'view')
    }),
  )
})

app.get('/api/canvases/:id/components/:componentId/preview', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const def = findComponent(canvas.id, req.params.componentId)
  if (!def) return res.status(404).json({ error: 'component not found' })
  res.json(previewDocument(canvas.id, def))
})

app.post('/api/frames/:id/instances', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit')
  if (!current) return
  const body = req.body ?? {}
  componentRoute(res, () =>
    insertInstance(
      current.canvasId,
      {
        frameId: current.id,
        component: String(body.component ?? ''),
        props: body.props,
        target: body.target,
        position: body.position,
      },
      userActor(req),
    ),
  )
})

app.patch('/api/frames/:id/instances', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit')
  if (!current) return
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : []
  componentRoute(res, () => changeInstances(current.canvasId, current.id, changes, userActor(req)))
})

app.put('/api/frames/:id/approval', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)
  if (!current) return
  const { status, expectedUpdatedAt } = req.body ?? {}
  if (expectedUpdatedAt === undefined)
    return res.status(400).json({ error: 'expectedUpdatedAt is required to approve the reviewed version' })
  if (status !== 'ready_for_dev' && status !== 'draft')
    return res.status(400).json({ error: 'status must be ready_for_dev or draft' })
  if (status === 'ready_for_dev' && actions.isFrameStreaming(current.id))
    return res.status(409).json({ error: 'Wait for the design to finish before approving it.' })
  res.json(actions.setFrameApproval(current.id, status === 'ready_for_dev', req.user!))
})

/* the lint a client computed inside the frame's iframe, stored and relayed
   to the room as frame:lint (the design itself is untouched) */
const lintIssueBody = z.object({
  ruleId: z.string().max(40),
  severity: z.enum(['error', 'warning']),
  message: z.string().max(400),
  elementId: z.string().max(120).optional(),
  selector: z.string().max(400).optional(),
  detail: z.string().max(300).optional(),
})
const lintBody = z.object({
  score: z.number().min(0).max(100),
  errors: z.number().int().min(0).max(500),
  warnings: z.number().int().min(0).max(500),
  issues: z.array(lintIssueBody).max(60),
  checkedAt: z.number().int().min(0).optional(),
  version: z.number().int().min(0).max(100).optional(),
  engine: z.enum(['dom', 'static']).optional(),
  truncated: z.boolean().optional(),
  doc: z.string().max(80).optional(),
})

app.put('/api/frames/:id/lint', (req, res) => {
  const current = requireFrame(req, res, req.params.id, 'edit')
  if (!current) return
  const parsed = lintBody.safeParse(req.body?.lint)
  if (!parsed.success) return res.status(400).json({ error: 'bad lint payload' })
  /* a verdict scores one document (lintDocKey): one that lands after the
     frame moved on would read as current for a design it never saw */
  if (parsed.data.doc !== undefined && parsed.data.doc !== lintDocKey(current))
    return res.status(409).json({ error: 'the frame changed since this verdict was scored' })
  /* a client clock running ahead must not make a verdict look newer than
     the document's next change (the client skips a current verdict) */
  const now = Date.now()
  const lint = { ...parsed.data, checkedAt: Math.min(parsed.data.checkedAt ?? now, now) }
  const frame = actions.setFrameLint(req.params.id, lint as Frame['lint'], userActor(req))
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true })
})

/* run the frame checks (375 / 768 / 1440 + keyboard walk) in the server's
   renderer; an unchanged document answers from the stored result unless
   `force` is set. Clients call this once a frame's document settles. */
app.post('/api/frames/:id/checks', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const force = req.body?.force === true
  const outcome = await checkAndStore(req.params.id, userActor(req), {
    force,
    priority: force ? 'interactive' : 'background',
  })
  if (outcome.ok) return res.json({ ok: true, checks: outcome.checks, reused: outcome.reused })
  if (outcome.reason === 'not_found') return res.status(404).json({ error: 'frame not found' })
  if (outcome.reason === 'no_renderer')
    return res.status(503).json({ error: 'no renderer configured for frame checks' })
  res.status(502).json({ error: 'frame checks failed', detail: outcome.error })
})

app.post('/api/frames/:id/append', (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const { html_chunk, start, done } = req.body ?? {}
  const actor = userActor(req)
  const frame = actions.appendFrameHtml(req.params.id, String(html_chunk ?? ''), actor, {
    start: !!start,
    done: !!done,
  })
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true, htmlBytes: frame.html.length })
})

app.delete('/api/frames/:id', (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit', req.body?.expectedUpdatedAt)) return
  const actor = userActor(req)
  const frame = actions.deleteFrame(req.params.id, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true })
})

/* design history: the states a frame had before later edits replaced them,
   newest first and without HTML; one version in full; restore (same
   permission model as editing — anyone with access to the canvas) */
app.get('/api/frames/:id/versions', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'view')) return
  res.json(await persist.listFrameVersions(req.params.id))
})

app.get('/api/frames/:id/versions/:versionId', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'view')) return
  const version = await persist.getFrameVersion(req.params.id, req.params.versionId)
  if (!version) return res.status(404).json({ error: 'version not found' })
  res.json(version)
})

app.post('/api/frames/:id/versions/:versionId/restore', async (req, res) => {
  if (!requireFrame(req, res, req.params.id, 'edit')) return
  const actor = userActor(req)
  const restored = await actions.restoreFrameVersion(req.params.id, req.params.versionId, actor)
  if (restored === null) return res.status(404).json({ error: 'version not found' })
  if (!restored) return res.status(404).json({ error: 'frame not found' })
  res.json(restored)
})

app.post('/api/frames/:id/comments', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'comment')
  if (!frame) return
  const { selector, elementId, snippet, text, x, y, elementOrigin } = req.body ?? {}
  if (refuseAgentMention(req, res, frame.canvasId, String(text ?? ''))) return
  /* a comment that @mentions a resident agent is a new command to the team,
     so it's metered like a card; plain comments and replies stay free */
  if (mentionedRole(String(text ?? ''))) {
    const gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const comment = await actions.addElementComment(
    req.params.id,
    { selector, elementId, snippet, text: String(text ?? ''), x, y, elementOrigin },
    req.user!.name,
    req.user!.id,
  )
  if (!comment) return res.status(404).json({ error: 'frame not found or empty text' })
  res.json(comment)
})

/* the stable id of an element inside a frame — stamped as data-doop-id into
   the frame HTML if it has none yet — for a link that outlives edits around
   it. Anyone who may comment may stamp: the write is an annotation, not a
   design change, so it leaves sign-off alone. */
app.post('/api/frames/:id/element-id', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'comment')
  if (!frame) return
  const selector = typeof req.body?.selector === 'string' ? req.body.selector.trim() : ''
  if (!selector || selector.length > actions.MAX_ELEMENT_SELECTOR_CHARS) {
    return res.status(400).json({ error: 'selector required' })
  }
  const snippet = typeof req.body?.snippet === 'string' ? req.body.snippet.slice(0, 400) : undefined
  const stamped = await actions.ensureElementId(frame.id, selector, req.user!.name, snippet || undefined)
  if (!stamped) return res.status(409).json({ error: 'the element could not be found in the frame right now' })
  res.json({ elementId: stamped.id, frameUpdatedAt: stamped.frame.updatedAt })
})

/* ------------------------------------------------------------------ */
/* Drift review (server/drift.ts): compare the designed frame with the  */
/* shipped page at a URL — capture, "Shipped" frame beside it, pixel    */
/* score. Analyze queues the card whose run posts the gaps as           */
/* severity-tagged comments.                                            */
/* ------------------------------------------------------------------ */

app.post('/api/frames/:id/drift', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'edit')
  if (!frame) return
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url || url.length > 2048) return res.status(400).json({ error: 'url required' })
  try {
    const { comparison, shipped } = await compareFrameWithUrl({
      frame,
      url,
      actor: actions.resolveActor({ name: req.user!.name, kind: 'user' }),
      userId: req.user!.id,
      source: 'ui',
    })
    res.status(201).json({ comparison, shippedFrame: shipped })
  } catch (error) {
    const { status, message } = driftErrorMessage(error)
    res.status(status).json({ error: message })
  }
})

app.get('/api/frames/:id/drift', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'view')
  if (!frame) return
  res.json(await listComparisons(frame.id))
})

/* "Analyze the gaps": the comparison's card, claimed by the resident —
   metered like any card ask since it spends a model run */
app.post('/api/frames/:id/drift/:driftId/analyze', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'edit')
  if (!frame) return
  const comparison = await getComparison(String(req.params.driftId))
  if (!comparison || comparison.frameId !== frame.id) return res.status(404).json({ error: 'comparison not found' })
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const card = actions.queueDriftCard(
    frame.canvasId,
    {
      frameName: frame.name,
      frameId: frame.id,
      ...(comparison.shippedFrameId ? { shippedFrameId: comparison.shippedFrameId } : {}),
      url: comparison.finalUrl ?? comparison.url,
      ...(comparison.score !== undefined ? { score: comparison.score } : {}),
      driftId: comparison.id,
    },
    req.user!.name,
    req.user!.id,
  )
  res.status(201).json(card)
})

/* a comment pinned to a point on the canvas (world coordinates on one of its
   pages) rather than to an element — metered exactly like an element comment */
app.post('/api/canvases/:id/comments', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'comment')
  if (!canvas) return
  const { pageId, x, y, text, timeStart, timeEnd } = req.body ?? {}
  if (typeof pageId !== 'string' || !canvasPages(canvas).some((page) => page.id === pageId)) {
    return res.status(400).json({ error: 'page not found' })
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
  if (
    (timeStart !== undefined || timeEnd !== undefined) &&
    (!Number.isFinite(timeStart) || !Number.isFinite(timeEnd))
  ) {
    return res.status(400).json({ error: 'timeStart/timeEnd must both be seconds on the page composition' })
  }
  const body = String(text ?? '')
  if (!body.trim()) return res.status(400).json({ error: 'empty text' })
  if (refuseAgentMention(req, res, canvas.id, body)) return
  let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
  if (mentionedRole(body)) {
    gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const comment = actions.addCanvasComment(
    canvas.id,
    {
      pageId,
      x: Number(x),
      y: Number(y),
      text: body,
      ...(Number.isFinite(timeStart) ? { timeStart: Number(timeStart) } : {}),
      ...(Number.isFinite(timeEnd) ? { timeEnd: Number(timeEnd) } : {}),
    },
    req.user!.name,
    req.user!.id,
  )
  if (!comment) {
    /* the page went away while the meter was being written: give the task
       back — a failed refund is logged, never turned into a 500 */
    if (gate) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[comments] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
    return res.status(409).json({ error: 'page removed meanwhile' })
  }
  res.json(comment)
})

app.post('/api/comments/:id/replies', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  const text = String(req.body?.text ?? '')
  if (!text.trim() || !actions.openThread(req.params.id)) {
    return res.status(404).json({ error: 'thread resolved or empty text' })
  }
  if (refuseAgentMention(req, res, found.canvasId, text)) return
  /* same rule as a fresh comment: only an @mention costs a resident task */
  let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
  if (mentionedRole(text)) {
    gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  const reply = actions.replyToComment(req.params.id, text, req.user!.name, req.user!.id)
  if (!reply) {
    /* the thread closed while the meter was being written: give the task
       back — a failed refund is logged, never turned into a 500 */
    if (gate) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[comments] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
    return res.status(409).json({ error: 'thread resolved meanwhile' })
  }
  res.json(reply)
})

/* ------------------------------------------------------------------ */
/* Canvas chat: the thread where a human talks the next design over    */
/* with the resident agent before anything touches the canvas. A       */
/* design ask comes back as a plan card; only an editor's Go design    */
/* turns it into board cards, one per screen.                          */
/* ------------------------------------------------------------------ */

/* ⌘F everywhere: every canvas the user can open — find a library component
   from any project. A library answers from its index (its items, as name
   hits); every other canvas's frame HTML is loaded on demand. */
app.get('/api/find', async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 200)
  const matchCase = req.query.case === '1'
  const out: CanvasFindResult = { hits: [], total: 0, frames: 0 }
  for (const meta of workspaces.canvasesFor(req.user!.id)) {
    const listed = store.getCanvas(meta.id)
    if (!listed || !canvasRole(req.user!.id, listed)) continue
    const fromIndex = await findInLibrary(listed, q, { matchCase })
    const canvas = fromIndex ? listed : await store.load(meta.id)
    if (!canvas) continue
    const r = fromIndex ?? findInCanvas(canvas, q, { matchCase })
    out.total += r.total
    out.frames += r.frames
    for (const h of r.hits) {
      if (out.hits.length >= 1500) break
      out.hits.push({ ...h, canvasId: canvas.id, canvasName: canvas.name })
    }
  }
  res.json(out)
})

/* ⌘F across every page: the client only holds the open page's HTML */
app.get('/api/canvases/:id/find', (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const q = String(req.query.q ?? '').slice(0, 200)
  res.json(findInCanvas(canvas, q, { matchCase: req.query.case === '1' }))
})

/* the usage meter (server/agentRuns.ts) plus the per-call ledger
   (server/toolCalls.ts): every resident run's tokens, time and cost, and
   every tool call's sizes — what editors spend, so editors read it */
app.get('/api/canvases/:id/usage', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const [report, calls] = await Promise.all([usageReport(req.params.id), toolCallReport(req.params.id)])
  res.json({ ...report, toolCalls: calls, scriptRuns: await scriptRunDeps.list(req.params.id) })
})

/* run replay (server/runReplay.ts): one resident run's activity and the
   before/after of every frame it touched */
/* roll a whole run back: 409 with the frames edited since, unless the body
   says { force: true } */
app.post('/api/canvases/:id/runs/:runId/rollback', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const result = await rollbackRun(req.params.id, req.params.runId, userActor(req), {
      force: req.body?.force === true,
    })
    if (!result) return res.status(404).json({ error: 'No such run on this canvas' })
    res.json(result)
  } catch (err) {
    if (!(err instanceof RollbackConflictError)) {
      console.error('[replay] rollback failed', err)
      return res.status(500).json({ error: 'The rollback failed' })
    }
    res.status(409).json({
      error: 'Some frames were edited since this run',
      conflicts: err.frames.map((f) => ({ frameId: f.frameId, name: f.name })),
    })
  }
})

app.get('/api/canvases/:id/runs/:runId', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const timeline = await runTimeline(req.params.id, req.params.runId)
  if (!timeline) return res.status(404).json({ error: 'No such run on this canvas' })
  res.json(timeline)
})

app.get('/api/canvases/:id/chat', (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'view')) return
  res.json(actions.getChat(req.params.id))
})

app.post('/api/canvases/:id/chat', async (req, res) => {
  const chatCanvas = requireCanvas(req, res, req.params.id, 'comment')
  if (!chatCanvas) return
  /* the Chat tab is a conversation with Doop: an editor's line asks the
     agent even without an @mention (viewers and commenters still talk to
     the room, and an explicit @mention picks another agent) */
  const chatRole = canvasRole(req.user!.id, chatCanvas)
  const askAgent = !!chatRole && roleAllows(chatRole, 'edit')
  const text = String(req.body?.text ?? '')
  if (!text.trim()) return res.status(400).json({ error: 'empty text' })
  const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId : undefined
  if (threadId) {
    const root = actions.findChatMessage(threadId)
    if (!root || root.canvasId !== req.params.id) return res.status(404).json({ error: 'thread not found' })
  }
  if (refuseAgentMention(req, res, req.params.id, text)) return
  /* an @mention asks the resident agent for work — metered like a comment's */
  let gate: Awaited<ReturnType<typeof allowance.consumeResidentTask>> | undefined
  if (mentionedRole(text) || askAgent) {
    gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
  }
  /* the composer's model picker, like a prompt-bar card's */
  const runner = parseRunnerPick(req.body?.runner)
  const message = actions.postChatMessage(req.params.id, {
    from: req.user!.name,
    fromUserId: req.user!.id,
    text,
    threadId,
    ...(runner ? { runner } : {}),
    ...(askAgent ? { askAgent: true } : {}),
  })
  if (!message) {
    if (gate) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[chat] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
    return res.status(409).json({ error: 'canvas gone meanwhile' })
  }
  res.json(message)
})

/** The plan card a chat route acts on, or the reply sent. */
function requireChatPlan(req: express.Request, res: express.Response): ChatMessage | undefined {
  const message = actions.findChatMessage(String(req.params.messageId))
  if (!message?.plan) {
    res.status(404).json({ error: 'plan not found' })
    return undefined
  }
  return message
}

/* Bryan's call: ANY editor of the canvas may press Go design — the plan card
   records who did. One resident task per card the launch queues, all or
   nothing so a low allowance never launches half a plan. */
app.post('/api/chat/:messageId/launch', async (req, res) => {
  const message = requireChatPlan(req, res)
  if (!message) return
  if (!requireCanvas(req, res, message.canvasId, 'edit')) return
  const plan = message.plan!
  if (!isOpenPlan(plan)) return res.status(409).json({ error: `plan is ${plan.status}` })
  const spent: Awaited<ReturnType<typeof allowance.consumeResidentTask>>[] = []
  const refund = async () => {
    for (const gate of spent) {
      await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
        console.error(`[chat] could not refund a resident task for ${req.user!.id}:`, err)
      })
    }
  }
  for (let i = 0; i < plan.screens.length; i++) {
    const gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) {
      await refund()
      return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
    }
    spent.push(gate)
  }
  const cards = actions.launchChatPlan(message, { name: req.user!.name, userId: req.user!.id })
  if (!cards) {
    /* a cancel or another launch landed while the meter was being written */
    await refund()
    return res.status(409).json({ error: 'plan is no longer open' })
  }
  /* the chat reports what Go design queued, in the plan's own thread, from
     the same agent that proposed it */
  actions.postChatMessage(message.canvasId, {
    from: message.from,
    agent: true,
    threadId: message.id,
    text:
      `Go design — queued ${cards.length} card${cards.length === 1 ? '' : 's'} on the board: ` +
      plan.screens.map((s) => `“${s.name}”`).join(', ') +
      '. Watch them in the Agents tab.',
  })
  res.json({ message, cards })
})

/* Edit plan: the human's version replaces the proposed one and is marked
   approved — the plan stayed open, just shaped by a person. */
app.patch('/api/chat/:messageId/plan', (req, res) => {
  const message = requireChatPlan(req, res)
  if (!message) return
  if (!requireCanvas(req, res, message.canvasId, 'edit')) return
  const plan = cleanChatPlan(req.body?.plan)
  if (!plan) return res.status(400).json({ error: 'not a plan' })
  const updated = actions.editChatPlan(message.id, plan)
  if (!updated) return res.status(409).json({ error: `plan is ${message.plan!.status}` })
  res.json(updated)
})

/* Remove one library reference from one screen of an open plan — the
   button on a plan-card thumbnail. Counts as a human edit: the plan turns
   approved, and Go design never hands the dropped frame to a card. */
app.delete('/api/chat/:messageId/plan/references', (req, res) => {
  const message = requireChatPlan(req, res)
  if (!message) return
  if (!requireCanvas(req, res, message.canvasId, 'edit')) return
  const screen = Number(req.body?.screen)
  const libraryId = typeof req.body?.libraryId === 'string' ? req.body.libraryId : ''
  if (!Number.isInteger(screen) || screen < 0 || !libraryId) {
    return res.status(400).json({ error: 'screen index and libraryId required' })
  }
  const updated = actions.removeChatPlanReference(message.id, screen, libraryId)
  if (!updated) return res.status(404).json({ error: 'reference not found or plan is closed' })
  res.json(updated)
})

app.post('/api/chat/:messageId/cancel', (req, res) => {
  const message = requireChatPlan(req, res)
  if (!message) return
  if (!requireCanvas(req, res, message.canvasId, 'edit')) return
  const updated = actions.cancelChatPlan(message.id)
  if (!updated) return res.status(409).json({ error: `plan is ${message.plan!.status}` })
  res.json(updated)
})

/* A failed ask the human wants another shot at — metered like a retry
   everywhere else. */
app.post('/api/chat/:messageId/retry', async (req, res) => {
  const message = actions.findChatMessage(String(req.params.messageId))
  if (!message?.forAgent) return res.status(404).json({ error: 'ask not found' })
  if (!requireCanvas(req, res, message.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const retried = actions.retryChatAsk(message.id)
  if (!retried) {
    await allowance.refundResidentTask(gate, req.user!.id).catch((err) => {
      console.error(`[chat] could not refund a resident task for ${req.user!.id}:`, err)
    })
    return res.status(409).json({ error: 'ask is not waiting for a retry' })
  }
  res.json(retried)
})

app.post('/api/comments/:id/resolve', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  res.json(actions.resolveComment(req.params.id, req.user!.name))
})

/* drag a thread's pin somewhere else: onto an element, a frame as a whole
   or the canvas. The whole thread moves, and anyone who may comment may move */
app.patch('/api/comments/:id/anchor', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'comment')) return
  const { frameId, selector, elementId, snippet, pageId, x, y, elementOrigin } = req.body ?? {}
  let anchor: CommentAnchorInput
  if (typeof frameId === 'string') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
    anchor = {
      frameId,
      ...(typeof selector === 'string' ? { selector } : {}),
      ...(typeof elementId === 'string' ? { elementId } : {}),
      elementOrigin,
      snippet: String(snippet ?? ''),
      x: Number(x),
      y: Number(y),
    }
  } else if (typeof pageId === 'string') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x and y must be numbers' })
    anchor = { pageId, x: Number(x), y: Number(y) }
  } else return res.status(400).json({ error: 'frameId or pageId required' })
  const moved = await actions.moveComment(req.params.id, anchor, req.user!.name)
  if (!moved) return res.status(404).json({ error: 'frame or page not found' })
  res.json(moved)
})

app.post('/api/comments/:id/retry', async (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  res.json(actions.retryComment(req.params.id, req.user!.name))
})

/* Import one page immediately, or discover + import a user-reviewed set of
   same-site pages. Discovery and capture are separate requests on purpose:
   nothing gets added to the canvas until the user confirms the page list. */
const importHits = new Map<string, number[]>()
function takeImportSlot(userId: string): boolean {
  const now = Date.now()
  const hits = (importHits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= 5) return false
  hits.push(now)
  importHits.set(userId, hits)
  return true
}

app.post('/api/canvases/:id/import/discover', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const { discoverSitePages, assertPublicHttpUrl } = await import('./importer.ts')
    const url = String(req.body?.url ?? '')
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    res.json(await discoverSitePages(url))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'page discovery failed' })
  }
})

app.post('/api/canvases/:id/import', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'edit')
  if (!canvas) return
  try {
    const { importPage, importSitePages, assertPublicHttpUrl, isSameSiteUrl, MAX_SITE_PAGES } =
      await import('./importer.ts')
    const requested: string[] | null = Array.isArray(req.body?.urls)
      ? (req.body.urls as unknown[]).map((value) => String(value))
      : null

    if (requested) {
      if (!requested.length) return res.status(400).json({ error: 'select at least one page' })
      if (requested.length > MAX_SITE_PAGES) {
        return res.status(400).json({ error: `a website import is limited to ${MAX_SITE_PAGES} pages` })
      }
      /* Validate the whole batch before consuming a slot or opening Chromium. */
      const validated = requested.map((url) => assertPublicHttpUrl(url))
      const [first, ...rest] = validated
      if (first && rest.some((url) => !isSameSiteUrl(url, first))) {
        return res.status(400).json({ error: 'all selected pages must belong to the same website' })
      }
      const urls = [...new Set(validated.map((url) => url.href))]
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })

      const captures = await importSitePages(urls)
      const actor = userActor(req)
      const frames = []
      const failures: { url: string; error: string }[] = []
      const rightmost = canvas.frames.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
      const startX = canvas.frames.length ? rightmost + 80 : 120
      const columns = 3
      let column = 0
      let y = 120
      let rowHeight = 0

      for (const capture of captures) {
        if (!capture.page) {
          failures.push({ url: capture.url, error: capture.error ?? 'import failed' })
          continue
        }
        const imported = capture.page
        const frame = actions.createFrame(
          canvas.id,
          {
            name: imported.title.slice(0, 80),
            x: startX + column * (imported.width + 80),
            y,
            width: imported.width,
            height: imported.height,
            html: imported.html,
          },
          actor,
        )
        if (!frame) {
          failures.push({ url: capture.url, error: 'canvas not found' })
          continue
        }
        frames.push(frame)
        rowHeight = Math.max(rowHeight, imported.height)
        column++
        if (column === columns) {
          column = 0
          y += rowHeight + 80
          rowHeight = 0
        }
      }
      return res.json({ frames, failures })
    }

    const url = String(req.body?.url ?? '')
    /* Validate before consuming a rate-limit slot — typos shouldn't burn quota. */
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    const imported = await importPage(url)
    const actor = userActor(req)
    const frame = actions.createFrame(
      canvas.id,
      { name: imported.title.slice(0, 80), width: imported.width, height: imported.height, html: imported.html },
      actor,
    )
    if (!frame) return res.status(404).json({ error: 'canvas not found' })
    res.json(frame)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

/* model duels (server/duels.ts): one brief to 2-3 model picks, each into its
   own sibling frame; metered one resident task per entry */
app.post('/api/canvases/:id/duels', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const picks: unknown[] = Array.isArray(req.body?.picks) ? req.body.picks : []
  const brief = String(req.body?.brief ?? '')
  const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined
  for (let i = 0; i < Math.min(picks.length, 3); i++) {
    const gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  try {
    const duel = await startDuel({
      modes: Array.isArray(req.body.modes)
        ? req.body.modes.map((m: unknown) => (m === 'script' ? 'script' : 'tools'))
        : undefined,
      canvasId: req.params.id,
      ...(pageId ? { pageId } : {}),
      brief,
      picks,
      actor: userActor(req),
      userId: req.user!.id,
    })
    res.json(duel)
  } catch (err) {
    if (err instanceof DuelInputError) return res.status(400).json({ error: err.message })
    console.error('[duel] could not start', err)
    res.status(500).json({ error: 'The duel could not start' })
  }
})

/* keep one entry: a canvas decision, the others archived */
app.post('/api/canvases/:id/duels/:duelId/pick', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  try {
    const duel = await pickDuel(req.params.id, req.params.duelId, String(req.body?.frameId ?? ''), userActor(req))
    if (!duel) return res.status(404).json({ error: 'No such duel on this canvas' })
    res.json(duel)
  } catch (err) {
    if (err instanceof DuelInputError) return res.status(400).json({ error: err.message })
    console.error('[duel] could not keep the pick', err)
    res.status(500).json({ error: 'The pick could not be saved' })
  }
})

app.get('/api/canvases/:id/duels', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  res.json(await listDuels(req.params.id))
})

/* motion duels: one storyboard page, one copy per pick, each pick animates
   its own copy and queues a render for comparison */
app.post('/api/canvases/:id/motion-duels', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const picks: unknown[] = Array.isArray(req.body?.picks) ? req.body.picks : []
  const brief = String(req.body?.brief ?? '')
  const pageId = String(req.body?.pageId ?? '')
  for (let i = 0; i < Math.min(picks.length, 3); i++) {
    const gate = await allowance.consumeResidentTask(req.user!.id)
    if (!gate.ok) return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  try {
    const duel = await startMotionDuel({
      canvasId: req.params.id,
      pageId,
      brief,
      picks,
      actor: userActor(req),
      userId: req.user!.id,
    })
    res.json(duel)
  } catch (err) {
    if (err instanceof DuelInputError) return res.status(400).json({ error: err.message })
    console.error('[duel] could not start the motion duel', err)
    res.status(500).json({ error: 'The motion duel could not start' })
  }
})

app.post('/api/canvases/:id/cards', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id, 'edit')) return
  const title = String(req.body?.title ?? '').trim()
  if (!title) return res.status(400).json({ error: 'empty title' })
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const card = actions.addQueuedCard(
    req.params.id,
    title,
    req.user!.name,
    req.body?.agents,
    req.body?.attachments,
    req.user!.id,
    req.body?.scope,
    req.body?.runner,
  )
  if (!card) return res.status(404).json({ error: 'canvas not found or empty title' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/done', (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const card = actions.completeCard(req.params.canvasId, req.params.id)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/retry', async (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const card = actions.retryCard(req.params.canvasId, req.params.id, req.user!.name)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/canvases/:canvasId/cards/:id/stop', (req, res) => {
  if (!requireCanvas(req, res, req.params.canvasId, 'edit')) return
  const card = actions.stopCard(req.params.canvasId, req.params.id, req.user!.name)
  if (!card) return res.status(404).json({ error: 'card not found' })
  res.json(card)
})

app.post('/api/tasks/:id/feedback', async (req, res) => {
  const canvasId = actions.taskCanvasId(req.params.id)
  if (!canvasId) return res.status(404).json({ error: 'task not found' })
  if (!requireCanvas(req, res, canvasId, 'edit')) return
  const text = String(req.body?.text ?? '').trim()
  if (!text) return res.status(400).json({ error: 'empty text' })
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  const fb = actions.addTaskFeedback(req.params.id, req.user!.name, text, req.user!.id)
  if (!fb) return res.status(404).json({ error: 'task not found or empty text' })
  res.json(fb)
})

app.post('/api/feedback/:id/retry', async (req, res) => {
  const found = actions.findFeedback(req.params.id)
  if (!found) return res.status(404).json({ error: 'feedback not found' })
  if (!requireCanvas(req, res, found.canvasId, 'edit')) return
  const gate = await allowance.consumeResidentTask(req.user!.id)
  if (!gate.ok) {
    return res.status(403).json({ error: 'resident_limit', used: gate.used, limit: gate.limit })
  }
  res.json(actions.retryTaskFeedback(req.params.id, req.user!.name))
})

app.get('/api/frames/:id/screenshot.png', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id, 'view')
  if (!frame) return
  try {
    const { renderFrame } = await import('./screenshot.ts')
    const png = await renderFrame(frame, fitExportScale(frame, parseExportScale(req.query.scale) ?? 1))
    res.type('png').send(png)
  } catch (e) {
    sendRenderFailure(res, e)
  }
})

/* Vector PDF of frames on a canvas, a page per frame: ?frames=<id>,<id>
   picks frames, pages in the order listed, else ?page=<pageId> (default the
   first page) takes every visible frame there, in reading order. A GET so a read-only
   impersonation session can export too. */
app.get('/api/canvases/:id/export.pdf', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id, 'view')
  if (!canvas) return
  const pdf = await import('./pdfExport.ts')
  const frameIds = typeof req.query.frames === 'string' ? req.query.frames.split(',').filter(Boolean) : undefined
  const pageId = typeof req.query.page === 'string' && req.query.page ? req.query.page : undefined
  const selection = pdf.selectPdfFrames(canvas, { frameIds, pageId })
  if (!selection.ok) return res.status(selection.status).json({ error: selection.error })
  if (!pdf.pdfRendererAvailable()) {
    return res.status(503).json({ error: pdf.PDF_UNAVAILABLE_MESSAGE })
  }
  if (!pdf.takePdfExportSlot(req.user!.id)) {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'PDF export rate limit — wait a minute' })
  }
  try {
    const buf = await pdf.renderFramesPdf(selection.frames)
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename="${pdf.pdfFileName(canvas, selection.frames)}"`)
    res.set('Cache-Control', 'no-store')
    return res.send(buf)
  } catch (e) {
    if (e instanceof pdf.PdfRendererUnavailableError) return res.status(503).json({ error: e.message })
    return sendRenderFailure(res, e, 'PDF export failed')
  }
})

/* MCP endpoint — point any MCP-capable AI at http://localhost:PORT/mcp.
   Protected by OAuth: unauthenticated calls get 401 + discovery pointers. */
app.all('/mcp', handleMcpRequest)

/* OAuth discovery metadata at the root, where MCP clients look for it
   (better-auth serves these under /api/auth; we bridge the web-standard
   handlers into Express) */
function bridge(handler: (req: globalThis.Request) => Promise<globalThis.Response>) {
  return async (req: express.Request, res: express.Response) => {
    const out = await handler(new globalThis.Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`))
    res.status(out.status)
    out.headers.forEach((v, k) => res.setHeader(k, v))
    res.send(await out.text())
  }
}
app.get('/.well-known/oauth-authorization-server', (req, res) => bridge(oAuthDiscoveryMetadata(auth))(req, res))
/* The same document under the OpenID Connect name: ChatGPT accepts either,
   but its Enterprise workspace-domain restriction reads only this one (it
   needs the userinfo_endpoint better-auth already lists there). */
app.get('/.well-known/openid-configuration', (req, res) => bridge(oAuthDiscoveryMetadata(auth))(req, res))

/* Protected-resource metadata must name the exact endpoint the CLIENT
   connected to (RFC 9728 §3.3 — strict clients such as Muse reject a `resource`
   that differs from the URL they called, so it is `<origin>/mcp`, never the bare
   origin), while the authorization server stays on the canonical origin. In dev
   the app may be reached via :4300, :4301 (vite port bump) or :4400 — all must
   validate, so the origin is echoed from the request. Both well-known paths
   serve the same document, the shape Linear ships. */
function protectedResourceMetadata(req: express.Request, res: express.Response) {
  res.json({
    resource: `${req.protocol}://${req.get('host')}/mcp`,
    authorization_servers: [env.BETTER_AUTH_URL],
    jwks_uri: `${env.BETTER_AUTH_URL}/api/auth/mcp/jwks`,
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256'],
  })
}
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
/* path-aware variant some clients probe for a resource at /mcp */
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata)

/* robots + minimal sitemap for every deployment */
app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /c/\n\nSitemap: ${env.BETTER_AUTH_URL}/sitemap.xml\n`)
})
app.get('/sitemap.xml', (_req, res) => {
  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${env.BETTER_AUTH_URL}/</loc></url>\n</urlset>\n`,
    )
})

/* production: serve the built client */
if (env.isProduction) {
  const dist = path.join(process.cwd(), 'dist')
  app.use(express.static(dist))
  /* a missing bundle or source map is a 404, not the app shell: HTML served
     as a .js or .map breaks module loads and source map resolution */
  app.get('/assets/*', (_req, res) => res.sendStatus(404))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

/* ------------------------------------------------- websocket */

const server = http.createServer(app)
/* Room messages that carry a document are text a deflate shrinks several-fold;
   the cursors, viewports and presence that make up the rest are under a
   hundred bytes, where the framing costs more than it saves — hence the
   threshold. No context takeover either way: a context is a few hundred KB
   per socket for the life of the connection, and the messages worth
   compressing are big enough to fill a window on their own. */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: {
    threshold: 1024,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    zlibDeflateOptions: { level: 3 },
  },
})

/* A signed-out visitor on a link-shared canvas watches it as a guest
   (guestCanvasRole): view only, silent like a view-as session (no presence,
   no cursor, nothing it sends is relayed) and without the team's
   conversation (GUEST_HIDDEN). Anything else — a private canvas, a missing
   one — is the same 4401, so the sign-in screen does not reveal which. */
function joinAsGuest(ws: WebSocket, canvasId: string, clientId: string, canvas: Canvas | undefined) {
  const role = canvas && guestCanvasRole(canvas)
  if (!canvas || !role) {
    ws.close(4401, 'unauthorized')
    return
  }
  const presence: Presence = { clientId, name: '', color: colorFor(clientId), kind: 'user', activeFrameId: null }
  conns.set(ws, { ws, canvasId, presence, silent: true })
  const { guidelines: _guidelines, skills: _skills, references: _references, memberIds: _memberIds, ...shown } = canvas
  send(ws, {
    type: 'init',
    canvas: { ...shown, role },
    presences: [
      ...room(canvasId)
        .filter((c) => c.ws !== ws && !c.silent)
        .map((c) => guestPresence(c.presence)),
      ...[...(agentPresences.get(canvasId)?.values() ?? [])].map(guestPresence),
    ],
    activity: [],
    tasks: [],
    feedback: [],
    comments: [],
    chat: [],
    decisions: [],
    proposals: [],
    selfColor: presence.color,
    serverBuild: BUILD_ID,
  })
}

/** Answer a `frames:load`: the HTML of every frame on the page it names and of
 *  the frames it lists, in batches so the client can paint as they land. A
 *  frame deleted meanwhile is simply not answered; its `frame:deleted` says so. */
function sendFrameHtml(conn: Conn, msg: Extract<ClientMessage, { type: 'frames:load' }>) {
  const canvas = store.getCanvas(conn.canvasId)
  if (!canvas || !canvasRole(conn.userId, canvas)) {
    conn.ws.close(4403, 'no access')
    return
  }
  const ids = new Set(
    (Array.isArray(msg.frameIds) ? msg.frameIds : [])
      .filter((id) => typeof id === 'string')
      .slice(0, MAX_LOAD_FRAME_IDS),
  )
  const onPage = typeof msg.pageId === 'string' ? new Set(pageFrames(canvas, msg.pageId).map((f) => f.id)) : undefined
  const frames = canvas.frames.filter((f) => ids.has(f.id) || onPage?.has(f.id))
  for (const batch of frameHtmlBatches(frames)) send(conn.ws, { type: 'frames:html', frames: batch })
}

wss.on('connection', (ws, upgradeReq) => {
  ws.on('error', () => {})
  /* the session cookie rides the upgrade request; resolve it once */
  const sessionPromise = auth.api.getSession({ headers: fromNodeHeaders(upgradeReq.headers) }).catch(() => null)

  ws.on('message', async (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'join') {
      const session = await sessionPromise
      let canvas = store.getCanvas(msg.canvasId)
      if (!session) {
        /* only a canvas the guest may open is loaded for them */
        if (canvas && guestCanvasRole(canvas)) canvas = await store.load(msg.canvasId)
        if (ws.readyState !== WebSocket.OPEN) return
        joinAsGuest(ws, msg.canvasId, msg.clientId, canvas)
        return
      }
      if (!canvas) {
        /* a typo'd id or a canvas someone just deleted: say so and close,
           instead of leaving the socket open with nothing ever coming back.
           The client used to sit on a blank, unusable canvas UI forever
           waiting for an 'init' that would never arrive. */
        ws.close(4404, 'not found')
        return
      }
      /* checked before loading, so a denied join never loads the canvas */
      if (!canvasRole(session.user.id, canvas)) {
        ws.close(4403, 'no access')
        return
      }
      await store.load(msg.canvasId)
      /* a socket that closed while it waited must not join: its close
         already ran, so it would sit in the room and pin the canvas */
      if (ws.readyState !== WebSocket.OPEN) return
      canvas = store.getCanvas(msg.canvasId)
      if (!canvas) {
        ws.close(4404, 'not found')
        return
      }
      /* and again after: access removed while the canvas loaded must not
         still receive its designs and conversation */
      const role = canvasRole(session.user.id, canvas)
      if (!role) {
        ws.close(4403, 'no access')
        return
      }
      const presence: Presence = {
        clientId: msg.clientId,
        userId: session.user.id,
        name: session.user.name, // session identity, not whatever the client claims
        image: avatarUrl(session.user.image),
        color: colorFor(msg.clientId),
        kind: 'user',
        activeFrameId: null,
      }
      const silent = !!(session.session as { impersonatedBy?: string | null }).impersonatedBy
      const prevConn = conns.get(ws)
      if (
        prevConn &&
        !prevConn.silent &&
        (prevConn.canvasId !== msg.canvasId || prevConn.presence.clientId !== msg.clientId)
      ) {
        broadcast(prevConn.canvasId, { type: 'presence:leave', clientId: prevConn.presence.clientId })
      }
      conns.set(ws, { ws, canvasId: msg.canvasId, userId: session.user.id, presence, silent })
      const others = room(msg.canvasId)
        .filter((c) => c.ws !== ws && !c.silent)
        .map((c) => c.presence)
      const agents = [...(agentPresences.get(msg.canvasId)?.values() ?? [])]
      const pageId = msg.deferHtml === true ? openingPageId(canvas, msg) : undefined
      send(ws, {
        type: 'init',
        ...(pageId === undefined ? {} : { pageId }),
        canvas: { ...(pageId === undefined ? canvas : canvasOpenedOn(canvas, pageId)), role },
        presences: [...others, ...agents],
        activity: actions.getActivity(msg.canvasId),
        tasks: actions.getTasks(msg.canvasId),
        feedback: actions.getFeedback(msg.canvasId),
        comments: actions.getComments(msg.canvasId),
        chat: actions.getChat(msg.canvasId),
        decisions: actions.getDecisions(msg.canvasId),
        proposals: actions.getProposals(msg.canvasId),
        selfColor: presence.color,
        serverBuild: BUILD_ID,
      })
      /* An admin looking at a canvas must not act on it. Announcing presence
         would impersonate the owner in the room; maybePlay would have the
         demo agent perform on an untouched signup canvas; the card kick would
         start the resident agent working. All three are things the owner's
         own visit is supposed to trigger, not a support session. */
      if (silent) return
      broadcast(msg.canvasId, { type: 'presence:join', presence }, presence.clientId)
      /* the demo and the card kick are the owner's team at work — a share
         link visitor without edit rights is only looking */
      if (role !== 'edit') return
      demo.maybePlay(msg.canvasId) // first visit to a fresh signup canvas: the demo agent performs
      /* Start never-attempted cards. Failed/interrupted cards are excluded. */
      if (actions.getTasks(msg.canvasId).some((t) => t.queuedBy && !t.agentName && !t.endedAt)) {
        import('./resident.ts').then((r) => r.onFeedback(msg.canvasId)).catch(() => {})
      }
      return
    }

    const conn = conns.get(ws)
    if (!conn) return
    /* reading is not editing: a view-as connection may load HTML too */
    if (msg.type === 'frames:load') {
      sendFrameHtml(conn, msg)
      return
    }
    if (conn.silent) return // view-as connections receive updates but never emit
    const { canvasId, presence } = conn
    /* view and comment visitors share cursors and viewports; claiming a
       frame for editing or broadcasting a frame drag is editor-only */
    const role = connRole(conn)
    if (!role) {
      ws.close(4403, 'no access')
      return
    }
    if (!roleAllows(role, roomMessageNeeds(msg))) return

    switch (msg.type) {
      case 'cursor':
        presence.cursor = { x: msg.x, y: msg.y }
        broadcast(canvasId, { type: 'cursor', clientId: presence.clientId, x: msg.x, y: msg.y }, presence.clientId)
        break
      case 'viewport':
        if (!isPeerViewport(msg.viewport)) break
        presence.viewport = msg.viewport
        broadcast(
          canvasId,
          { type: 'viewport', clientId: presence.clientId, viewport: msg.viewport },
          presence.clientId,
        )
        break
      case 'editing':
        presence.activeFrameId = msg.frameId
        broadcast(canvasId, { type: 'editing', clientId: presence.clientId, frameId: msg.frameId }, presence.clientId)
        break
      case 'composition:playhead': {
        /* presence, like cursor: a collaborator's playhead on a timeline.
           Validate bounds before echoing to the room. */
        const t = typeof msg.t === 'number' && Number.isFinite(msg.t) ? msg.t : null
        const pageId = typeof msg.pageId === 'string' && msg.pageId.length <= 100 ? msg.pageId : null
        if (t === null || pageId === null || t < 0 || t > 86400) break
        broadcast(
          canvasId,
          { type: 'composition:playhead', clientId: presence.clientId, pageId, t, playing: msg.playing === true },
          presence.clientId,
        )
        break
      }
      case 'frame:drag':
        broadcast(
          canvasId,
          {
            type: 'frame:drag',
            clientId: presence.clientId,
            frameId: msg.frameId,
            x: msg.x,
            y: msg.y,
            width: msg.width,
            height: msg.height,
            ...(msg.rotation !== undefined ? { rotation: msg.rotation } : {}),
          },
          presence.clientId,
        )
        break
    }
  })

  ws.on('close', () => {
    const conn = conns.get(ws)
    if (!conn) return
    conns.delete(ws)
    if (conn.silent) return // never announced a join, so nothing to leave
    broadcast(conn.canvasId, { type: 'presence:leave', clientId: conn.presence.clientId })
  })
})

server.listen(PORT, () => {
  console.log(`⟡ diazo server    http://localhost:${PORT}`)
  /* frame HTML is loaded per canvas; a canvas nobody has used for
     CANVAS_IDLE_MS gives it back, unless a room, agent or stream is on it.
     Started here, once the room state it asks about exists. */
  store.setInUse(
    (canvasId) =>
      room(canvasId).length > 0 || (agentPresences.get(canvasId)?.size ?? 0) > 0 || actions.isCanvasStreaming(canvasId),
  )
  setInterval(
    () => {
      const dropped = store.evictIdle(env.CANVAS_IDLE_MS)
      if (dropped) console.log(`[store] dropped the frame HTML of ${dropped} idle canvas(es)`)
    },
    Math.min(60_000, Math.max(1_000, env.CANVAS_IDLE_MS / 2)),
  ).unref()
  /* audit retention: script_runs rows past their keep window are pruned
     hourly so the table cannot grow without bound */
  setInterval(
    () => {
      void pruneScriptRuns()
        .then((dropped) => {
          if (dropped) console.log(`[script_runs] pruned ${dropped} old audit row(s)`)
        })
        .catch((error) => console.warn('[script_runs] prune failed', error))
    },
    60 * 60 * 1000,
  ).unref()
  /* comments anchored before element ids: stamped now, while serving, so a
     slow or failing row can never keep the server from coming up */
  if (data.legacyCommentSelectors.size > 0) {
    actions
      .backfillElementIds(data.legacyCommentSelectors)
      .then(({ stamped, lost, failed }) =>
        console.log(
          `[comments] element ids: ${stamped} comment(s) re-anchored, ${lost} lost their element, ${failed} left for the next boot`,
        ),
      )
      .catch((err) => console.error('[comments] element id backfill failed:', err))
  }
  /* credentials stored before encryption (or under a rotated-out key) are
     sealed now; reads open either form, so serving need not wait for it */
  if (encryptionConfigured()) {
    resealSecrets(db)
      .then(({ resealed, failed }) => {
        if (resealed || failed)
          console.log(`[secrets] ${resealed} credential(s) sealed, ${failed} left for the next boot`)
      })
      .catch((err) => console.error('[secrets] reseal failed:', err))
  } else {
    console.warn('⟡ secrets           SECRETS_ENCRYPTION_KEYS unset — user credentials are stored unencrypted')
  }
  console.log(`⟡ mcp endpoint      http://localhost:${PORT}/mcp`)
  console.log(`⟡ websocket         ws://localhost:${PORT}/ws`)
  /* The Doop Agent failing silently is the one "why is nothing happening?"
     a self-hoster cannot debug from the UI — board cards and @mentions just
     sit there. Say so at boot, not only when the first card is queued. */
  const tier = serverTierInfo()
  console.log(
    tier.ready
      ? `⟡ diazo agent       on — free tier on this server’s ${tier.provider === 'azure' ? 'Azure OpenAI deployment' : 'Anthropic key'}, then each user’s own model account`
      : `⟡ diazo agent       no server ${tier.provider === 'azure' ? 'Azure config' : 'key'} — runs only for users who connect their own ChatGPT subscription or OpenAI key (${tier.provider === 'azure' ? 'set the AZURE_OPENAI_* vars' : 'set ANTHROPIC_API_KEY'} for a free tier; agents connected over MCP work regardless)`,
  )
  console.log(
    serverImageGenEnabled()
      ? '⟡ image generation  on — each user’s connected ChatGPT/OpenAI account, else this server’s OPENAI_API_KEY'
      : '⟡ image generation  on for users with a connected ChatGPT/OpenAI account only (set OPENAI_API_KEY to cover everyone else)',
  )
  /* automations fire from here: one tick a minute over the due rows */
  startScheduler()
  startMcpTokenPrune()
  for (const extension of extensions) extension.startWorker?.()
})
