/**
 * server/motionTools.ts — the Motion Studio tool logic, shared by the MCP
 * tools (server/mcp.ts) and the resident agent (server/resident.ts). Every
 * function takes the canvas the caller already gated and returns
 * `{ ok: true, data }` or `{ ok: false, error }`; the caller shapes that
 * into its transport.
 */

import { nanoid } from 'nanoid'
import * as actions from './actions.ts'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import { createRenderJob } from './motionJobs.ts'
import { elementHtml, lintComposition, lintMotionHtml, motionLintSummary } from '../shared/motionLint.ts'
import { resetCritiques } from './motionSnapshot.ts'
import { exportCompositionCode, type CompositionCodeExport } from '../shared/motionExport.ts'
import { itemMeta, libraryItems, saveMeta } from './libraryIndex.ts'
import { getLibrary } from './libraries.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import {
  analyzeShotHtml,
  inspectShotHtml,
  pendingNotedShots,
  storyboardCoverage,
  STORYBOARD_MAX_PASSES,
  type ShotInfo,
  type ShotNote,
  type ShotTarget,
  type StoryboardCoverage,
} from './storyboard.ts'
import {
  buildStoryboard,
  MOTION_BLOCK_ATTR,
  parseCompositionBody,
  parseMotionBlock,
  parseOps,
  type Composition,
  type Direction,
  type FrameMotionBlock,
  type MotionLintIssue,
} from '../shared/motion.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'
import { captionsFromTranscript, duckingKeyframes, findFillers, parseMediaBody } from '../shared/motionMedia.ts'
import { generateVideo, VideoGenError, videoCost } from './videoGen.ts'
import { storeAsset } from './assets.ts'
import { videoModel, VIDEO_MODELS, VIDEO_PRICE_DATE, type VideoAspect } from '../shared/videoModels.ts'

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }
const ok = <T>(data: T) => ({ ok: true as const, data })
const fail = <T = unknown>(error: string): { ok: false; error: string; data?: T } => ({ ok: false, error })

function pageOn(canvas: Canvas, pageId: string): boolean {
  return canvasPages(canvas).some((p) => p.id === pageId)
}

/* the notes check's memory for one page's film: which composition it
   describes, the frames its shots use when animate_storyboard built them,
   and the pending set it last reported. A pass is a check round that saw
   no progress, not a write — the state dies with its composition, so a
   later run or another agent on the page starts clean. */
interface FixPassState {
  compositionId: string
  shots?: ReadonlySet<string>
  /** the pending frame ids of the last reported round, sorted */
  pendingKey?: string
  /** consecutive rounds that reported the same pending set */
  passes: number
}
const fixPasses = new Map<string, FixPassState>()
const passKey = (canvasId: string, pageId: string) => `${canvasId}/${pageId}`

/* re-parsing every frame of a page on every set_composition is the check's
   hot path — a frame's read is valid until its html changes */
const SHOT_INFO_CACHE_MAX = 400
const shotInfoCache = new Map<string, { updatedAt: number; info: ShotInfo }>()
function shotInfoOf(frame: Frame): ShotInfo {
  const hit = shotInfoCache.get(frame.id)
  if (hit && hit.updatedAt === frame.updatedAt) return hit.info
  const info = inspectShotHtml(frame.html)
  if (shotInfoCache.size >= SHOT_INFO_CACHE_MAX) shotInfoCache.delete(shotInfoCache.keys().next().value!)
  shotInfoCache.set(frame.id, { updatedAt: frame.updatedAt, info })
  return info
}

/** The shots a frame list's notes live on: frame id → notes and ids. */
function notedFrames(frames: Frame[]): Map<string, ShotInfo> {
  const noted = new Map<string, ShotInfo>()
  for (const frame of frames) {
    const info = shotInfoOf(frame)
    if (info.notes.length > 0) noted.set(frame.id, info)
  }
  return noted
}

/** Run the notes check against a composition and advance the pass counter:
 *  a pass is a round that reports the same pending set as the round before
 *  (no progress); fixing a shot or changing which are missing starts it
 *  over. Undefined when the film has no noted shot to animate. */
function coverageFor(
  canvas: Canvas,
  pageId: string,
  composition: Composition,
  noted: Map<string, ShotInfo>,
): StoryboardCoverage | undefined {
  const key = passKey(canvas.id, pageId)
  let state = fixPasses.get(key)
  if (state?.compositionId !== composition.id) state = undefined
  /* only the shots of this run can go pending: the ones animate_storyboard
     recorded (the storyboard, or frame_ids), else every noted frame of the
     page. The scope never comes from the frames the tracks name — a camera
     track names none and this map is in memory, so after a whole-body
     write or a restart one element track on one shot would otherwise
     shrink the film to itself and answer "animated" over the rest */
  const inFilm = state?.shots
  const scoped = inFilm ? new Map([...noted].filter(([frameId]) => inFilm.has(frameId))) : noted
  if (scoped.size === 0) return undefined
  const pending = pendingNotedShots(composition.tracks, scoped)
  const pendingKey = pending
    .map((p) => p.frameId)
    .sort()
    .join(',')
  const passes = pending.length === 0 ? 0 : state?.pendingKey === pendingKey ? state.passes + 1 : 0
  const coverage = storyboardCoverage(composition.tracks, scoped, passes, STORYBOARD_MAX_PASSES)
  fixPasses.set(key, {
    compositionId: composition.id,
    shots: state?.shots,
    pendingKey: pending.length > 0 ? pendingKey : undefined,
    passes,
  })
  return coverage
}

/** The write's report plus the notes check, when the page's frames carry
 *  notes — the agent reads which noted shot still has no element track. */
async function withCoverage(
  canvas: Canvas,
  pageId: string,
  composition: Composition,
): Promise<{ composition: Composition; storyboard?: StoryboardCoverage }> {
  const loaded = (await store.load(canvas.id)) ?? canvas
  const coverage = coverageFor(loaded, pageId, composition, notedFrames(pageFrames(loaded, pageId)))
  return { composition, ...(coverage ? { storyboard: coverage } : {}) }
}

export function getCompositionData(canvas: Canvas, pageId: string): Outcome {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — create one with set_composition or animate_storyboard`)
  return ok(comp)
}

/** Whole-body replace, or an ops batch when `ops` is sent instead. The
 *  report carries the notes check when the page's frames carry notes. */
export async function setCompositionData(
  canvas: Canvas,
  pageId: string,
  input: { composition?: unknown; ops?: unknown; expected_revision?: unknown },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const existing = store.getComposition(canvas.id, pageId)
  const expected = input.expected_revision
  if (expected !== undefined) {
    if (typeof expected !== 'number' || !Number.isInteger(expected)) return fail('expected_revision must be an integer')
    if ((existing?.revision ?? 0) !== expected) {
      return fail(`the composition is at revision ${existing?.revision ?? 0}, not ${expected} — get_composition again`)
    }
  }
  if (input.ops !== undefined) {
    if (!existing) return fail(`page ${pageId} has no composition — send composition to create one`)
    const ops = parseOps(input.ops, existing.duration)
    if (!ops.ok) return fail(ops.error)
    const applied = actions.patchComposition(canvas.id, pageId, ops.value, actor)
    if (!applied.ok) return fail(applied.error ?? 'ops rejected')
    return ok(await withCoverage(canvas, pageId, applied.composition))
  }
  if (input.composition === undefined) return fail('send composition (a full timeline) or ops (a patch)')
  const body = parseCompositionBody(input.composition)
  if (!body.ok) return fail(body.error)
  /* a rewritten timeline is a new film: the pass count and the remembered
     shots die with the body it replaces, even though the id is kept */
  fixPasses.delete(passKey(canvas.id, pageId))
  return ok(await withCoverage(canvas, pageId, actions.setComposition(canvas.id, body.value, pageId, actor)))
}

/**
 * Build the timeline a page of frames implies — one shot per frame in
 * reading order, a camera track cutting between them — and save it. The
 * result also describes every shot: the frame's notes (the elements labelled
 * mouvement / transition / son / voix off / notes, or their English names,
 * plus the notes bar they may share) and its animatable elements (headlines,
 * text blocks, images, key UI — each with the `data-doop-id` an element
 * track can target, stamped the way the comments anchor does). The notes
 * are intent, not a script: the agent directs the film with set_composition
 * ops, and the notes check on each write reports the noted shots still
 * without an element track.
 */
export async function animateStoryboard(
  canvas: Canvas,
  pageId: string,
  input: {
    shot_seconds?: number
    margin?: number
    fps?: number
    width?: number
    height?: number
    frame_ids?: string[]
    /** the director's treatment — beats set per-shot seconds and the
     *  handover between shots; it persists on the composition */
    direction?: Direction
  },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  /* frame html is deferred until the canvas is loaded — reading .html on
     an unloaded frame throws */
  const loaded = (await store.load(canvas.id)) ?? canvas
  const wanted = input.frame_ids ? new Set(input.frame_ids) : null
  const frames = pageFrames(loaded, pageId).filter((f) => !wanted || wanted.has(f.id))
  if (frames.length === 0) {
    return fail(
      wanted ? 'none of frame_ids is on this page' : `page ${pageId} has no frames — lay the storyboard out first`,
    )
  }
  const shotSeconds = input.shot_seconds ?? 3
  if (!(shotSeconds > 0) || shotSeconds > 60) return fail('shot_seconds must be in (0, 60]')
  const width = input.width ?? 1920
  const height = input.height ?? 1080
  const fps = input.fps ?? 30
  const { body, shots } = buildStoryboard({
    frames: frames.map((f) => ({ id: f.id, x: f.x, y: f.y, width: f.width, height: f.height })),
    width,
    height,
    fps,
    shotSeconds,
    margin: input.margin,
    direction: input.direction,
  })
  const composition = actions.setComposition(canvas.id, body, pageId, actor)
  /* a rebuilt film starts a new run: clear the old state and record the
     shots this film uses, so noted frames outside frame_ids never pend —
     and the critique pass budget restarts with it */
  resetCritiques(canvas.id, pageId)
  fixPasses.set(passKey(canvas.id, pageId), {
    compositionId: composition.id,
    shots: new Set(frames.map((f) => f.id)),
    passes: 0,
  })

  const byId = new Map(frames.map((f) => [f.id, f]))
  const noted = new Map<string, ShotInfo>()
  const described: Record<string, unknown>[] = []
  for (const shot of shots) {
    const frame = byId.get(shot.frameId)
    let notes: ShotNote[] = []
    let targets: ShotTarget[] = []
    let panelId: string | undefined
    let noteIds = new Set<string>()
    let elementIds = new Set<string>()
    if (frame && frame.html.trim() !== '') {
      const analysis = analyzeShotHtml(frame.html)
      notes = analysis.notes
      targets = analysis.targets
      panelId = analysis.panelId
      noteIds = new Set(analysis.noteIds)
      elementIds = new Set(analysis.elementIds)
      if (analysis.stampedIds.length > 0) {
        /* an id is handed out only once the frame carrying it is on disk:
           mid-stream or a failed write, report what is already addressable */
        const landed =
          !actions.isFrameStreaming(frame.id) &&
          !!(await actions.commitElementStamps(frame, analysis.html, analysis.stampedIds, actor.name, actor.kind))
        if (!landed) {
          const fresh = new Set(analysis.stampedIds)
          targets = targets.filter((t) => !fresh.has(t.id))
          notes = notes.map((n) => (n.id && fresh.has(n.id) ? { text: n.text } : n))
          for (const id of fresh) {
            noteIds.delete(id)
            elementIds.delete(id)
          }
          if (panelId && fresh.has(panelId)) panelId = undefined
        }
      }
    }
    if (notes.length > 0) {
      noted.set(shot.frameId, { notes: notes.map((n) => n.text), noteIds, elementIds })
    }
    described.push({ ...shot, notes, targets, ...(panelId ? { panelId } : {}) })
  }
  /* the first report only names the work — the passes count on writes */
  const coverage = noted.size ? storyboardCoverage(composition.tracks, noted, 0, STORYBOARD_MAX_PASSES) : undefined
  return ok({
    composition,
    shots: described,
    ...(coverage ? { storyboard: coverage } : {}),
    note:
      `${shots.length} shot(s), hard cuts — every shot lists its notes (the intent and the minimum, not ` +
      `a script) and its animatable elements (data-doop-id targets). Direct the film with ` +
      `set_composition ops: element tracks and keyframes on the targets, camera moves, transitions ` +
      `across the cuts, a caption track + caption clips for voice-over, a muted caption lane for ` +
      `music/SFX you cannot source, notes blocks hidden from the render (ids in shots[].notes / ` +
      `panelId). Then lint_motion before render_composition — and say where you went beyond the notes.`,
  })
}

/**
 * Seek-safety over a page: the composition's structure plus every frame's
 * HTML (wall clocks, free-running loops, unseeded random, CSS animations,
 * GSAP, network at seek time, media autoplay, malformed motion blocks).
 */
export async function lintMotion(canvas: Canvas, input: { page_id?: string; frame_id?: string }): Promise<Outcome> {
  const pageId = input.page_id ?? store.getFrame(input.frame_id ?? '')?.pageId
  if (!pageId || !pageOn(canvas, pageId)) return fail('name a page_id (or a frame_id) on this canvas')
  /* frame html is deferred until the canvas is loaded — load it, or
     reading .html throws */
  const loaded = (await store.load(canvas.id)) ?? canvas
  const issues: MotionLintIssue[] = []
  const comp = store.getComposition(canvas.id, pageId)
  const frames = pageFrames(loaded, pageId)
  const frameIds = new Set(frames.map((f) => f.id))
  if (comp) issues.push(...lintComposition(comp, { frameIds, frameHtml: new Map(frames.map((f) => [f.id, f.html])) }))
  for (const frame of frames) {
    issues.push(...lintMotionHtml(frame.html, frame.id))
  }
  return ok({
    page_id: pageId,
    composition_id: comp?.id ?? null,
    ...motionLintSummary(issues),
    issues: issues.map((i) => ({
      rule: i.rule,
      severity: i.severity,
      message: i.message,
      ...(i.frameId ? { frame_id: i.frameId } : {}),
      ...(i.snippet ? { snippet: i.snippet } : {}),
    })),
  })
}

/** Queue a render job; a browser tab or the desktop shell claims it. */
export function renderComposition(
  canvas: Canvas,
  pageId: string,
  input: {
    format?: string
    target?: string
    width?: number
    height?: number
    fps?: number
    range?: { start?: number; end?: number }
  },
  by: { id: string; name: string },
): Outcome {
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to render`)
  const created = createRenderJob({
    composition: comp,
    format: input.format ?? 'mp4',
    target: input.target ?? 'browser',
    width: input.width,
    height: input.height,
    fps: input.fps,
    range: input.range,
    by,
  })
  if (!created.ok) return fail(created.rule ? `${created.rule}: ${created.error}` : created.error)
  return ok({
    job: created.job,
    note: 'The job is queued: a browser tab or the desktop app (target "desktop") claims it, renders and uploads the file. Watch render:progress in the room, or GET /api/renders/{id}.',
  })
}

/* ---- phase 2: code export, library clips ---- */

const MOTION_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/** A frame's parsed `data-doop-motion` block, or undefined when absent. */
function frameBlockOf(html: string): FrameMotionBlock | undefined {
  for (const m of html.matchAll(MOTION_SCRIPT_RE)) {
    if ((m[1] ?? '').includes(MOTION_BLOCK_ATTR)) {
      const block = parseMotionBlock(m[2] ?? '')
      if (block) return block
    }
  }
  return undefined
}

/** The visible text of an element, for expanding text animators server-side. */
function textOf(html: string, elementId: string): string | undefined {
  const subtree = elementHtml(html, elementId)
  if (!subtree) return undefined
  const text = subtree
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

/**
 * The "copy as code" contract (proposal 14.2): CSS + WAAPI for the page's
 * composition — layer keyframes, camera, transitions and expanded text
 * animators, token names kept. Read-only; needs the canvas loaded for the
 * frame-authored blocks.
 */
export async function exportComposition(
  canvas: Canvas,
  pageId: string,
): Promise<{ ok: true; data: CompositionCodeExport } | { ok: false; error: string }> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to export`)
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frameBlocks = new Map<string, FrameMotionBlock>()
  const frameTexts = new Map<string, Map<string, string>>()
  for (const frame of pageFrames(loaded, pageId)) {
    const block = frameBlockOf(frame.html)
    if (block) {
      frameBlocks.set(frame.id, block)
      const texts = new Map<string, string>()
      for (const animator of block.animators ?? []) {
        const text = textOf(frame.html, animator.el)
        if (text !== undefined) texts.set(animator.el, text)
      }
      if (texts.size) frameTexts.set(frame.id, texts)
    }
  }
  return ok(exportCompositionCode(comp, { frameBlocks, frameTexts }))
}

/** The library canvas a clip source names; the caller's role is checked by
 *  the tool layer (any canvas the caller may view may donate a clip). */
async function findLibraryItem(
  libraryCanvasId: string,
  itemId: string,
): Promise<{ item: LibraryItem; meta: LibraryItemMeta | undefined } | { error: string }> {
  if (!getLibrary(libraryCanvasId)) return { error: `canvas ${libraryCanvasId} is not a library` }
  const item = (await libraryItems(libraryCanvasId)).find((i) => i.itemId === itemId)
  if (!item) return { error: `no item ${itemId} in library ${libraryCanvasId}` }
  return { item, meta: await itemMeta(libraryCanvasId, itemId) }
}

/** The HTML a library item's seek-safety check runs on: its locator's
 *  element subtree when it has one, the whole frame otherwise. */
async function itemHtml(item: LibraryItem): Promise<string | { error: string }> {
  const canvas = await store.load(item.canvasId)
  if (!canvas) return { error: `library canvas ${item.canvasId} could not be loaded` }
  const frame = store.getFrame(item.frameId)
  if (!frame) return { error: `the item's frame ${item.frameId} is gone — reindex the library` }
  if ('elementId' in item.locator) {
    const subtree = elementHtml(frame.html, item.locator.elementId)
    return subtree ?? { error: `locator element ${item.locator.elementId} is gone — reindex the library` }
  }
  return frame.html
}

/**
 * The per-item seek-safety check (proposal 14.6): lint the item's HTML and
 * store the verdict on its curation row so insert_clip can trust it without
 * relinting. `safe` = no issues at all — warnings block a clip too, since a
 * warning means "renders differently on seek".
 */
export async function checkLibraryItemMotion(
  libraryCanvasId: string,
  itemId: string,
): Promise<
  | { ok: true; data: { seekSafe: 'safe' | 'issues'; findings: { rule: string; message: string }[] } }
  | { ok: false; error: string }
> {
  const found = await findLibraryItem(libraryCanvasId, itemId)
  if ('error' in found) return fail(found.error)
  const html = await itemHtml(found.item)
  if (typeof html !== 'string') return fail(html.error)
  const findings = lintMotionHtml(html, found.item.frameId).map((i) => ({ rule: i.rule, message: i.message }))
  const seekSafe = findings.length === 0 ? ('safe' as const) : ('issues' as const)
  const now = Date.now()
  const prev = found.meta
  await saveMeta({
    canvasId: libraryCanvasId,
    itemId,
    label: prev?.label ?? null,
    description: prev?.description ?? null,
    category: prev?.category ?? null,
    tags: prev?.tags ?? null,
    status: prev?.status ?? null,
    useCount: prev?.useCount ?? 0,
    lastUsedAt: prev?.lastUsedAt ?? null,
    suggested: prev?.suggested ?? null,
    seekSafe,
    seekSafeFindings: findings,
    seekSafeAt: now,
    updatedAt: prev?.updatedAt ?? now,
    updatedBy: prev?.updatedBy ?? null,
  })
  return ok({ seekSafe, findings })
}

/**
 * Insert a library Motion item as a clip on the page's clip track. Refuses
 * a non-seek-safe item (the stored or freshly-computed verdict plus its
 * lint reasons); the fix path is the rewrite helpers lint_motion names.
 */
export async function insertClip(
  canvas: Canvas,
  pageId: string,
  input: { library_id: string; item_id: string; variant_id?: string; start: number; duration?: number },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — make the timeline first`)
  const found = await findLibraryItem(input.library_id, input.item_id)
  if ('error' in found) return fail(found.error)
  const { item } = found

  let verdict = found.meta?.seekSafe
  let findings = found.meta?.seekSafeFindings ?? []
  if (!verdict) {
    const check = await checkLibraryItemMotion(input.library_id, input.item_id)
    if (!check.ok) return fail(check.error)
    verdict = check.data.seekSafe
    findings = check.data.findings
  }
  if (verdict !== 'safe') {
    return fail(
      `item ${item.itemId} is not seek-safe — fix it first (${findings
        .slice(0, 3)
        .map((f) => `${f.rule}: ${f.message}`)
        .join('; ')}${findings.length > 3 ? `, +${findings.length - 3} more` : ''}). ` +
        'Rewrite helpers: bind animation to --t keyframes or WAAPI, seed randomness, remove wall clocks and free-running timers.',
    )
  }
  const start = input.start
  /* default length: the item's own motion block's last keyframe, else 3 s */
  let duration = input.duration ?? 0
  if (!duration) {
    const html = await itemHtml(item)
    if (typeof html === 'string') {
      const block = frameBlockOf(html)
      const last = Math.max(
        0,
        ...(block?.keyframes ?? []).map((k) => k.t),
        ...(block?.animators ?? []).map((a) => a.start + a.duration),
      )
      duration = last > 0 ? Math.min(last + 0.5, 60) : 3
    } else duration = 3
  }
  if (!Number.isFinite(start) || start < 0) return fail('start must be a number ≥ 0')
  if (!Number.isFinite(duration) || !(duration > 0)) return fail('duration must be a positive number of seconds')

  /* the clip track to take it: the page's first, else a new one */
  const clipTrack = comp.tracks.find((t) => t.kind === 'clip' && !t.muted)
  const clip = {
    id: `clip-${item.itemId.replace(/[^a-zA-Z0-9_-]/g, '')}-${Math.round(start * 100)}`,
    start,
    duration,
    name: item.label,
    source: {
      type: 'library' as const,
      itemId: item.itemId,
      ...(input.variant_id ? { variantId: input.variant_id } : {}),
    },
  }
  const ops = clipTrack
    ? [{ op: 'add_clip' as const, trackId: clipTrack.id, clip }]
    : [
        {
          op: 'add_track' as const,
          track: {
            id: 'library-clips',
            kind: 'clip' as const,
            name: 'Library clips',
            clips: [clip],
          },
        },
      ]
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'insert rejected')
  return ok({
    composition: applied.composition,
    clip: { ...clip, trackId: clipTrack?.id ?? 'library-clips' },
    seekSafe: verdict,
  })
}

/* ---- scene_media tools (phase 3) ---- */

export async function listMedia(canvas: Canvas, pageId: string): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  return ok(await persist.listSceneMedia(canvas.id, pageId))
}

/** create or update the media row for an asset (keyed on pageId+assetId) */
export async function setMedia(
  canvas: Canvas,
  pageId: string,
  input: { asset_id: string } & Record<string, unknown>,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const body = parseMediaBody(input)
  if (!body) return fail('not a valid scene_media body — see shared/motionMedia.ts')
  const now = Date.now()
  const prev = await persist.findSceneMediaByAsset(canvas.id, pageId, input.asset_id)
  const media = {
    id: prev?.id ?? nanoid(10),
    canvasId: canvas.id,
    pageId,
    assetId: input.asset_id,
    ...body,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  persist.saveSceneMedia(media)
  return ok(media)
}

/**
 * Fold a media row's transcript into caption clips and land them on the
 * page's caption track (proposal 14.9). Words inside cut ranges are dropped,
 * times shift from source-media time onto the clip's window on the clock.
 */
export async function buildCaptions(
  canvas: Canvas,
  pageId: string,
  input: { media_id: string; style?: string; at?: number },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition`)
  const media = await persist.getSceneMedia(canvas.id, input.media_id)
  if (!media || media.pageId !== pageId) return fail(`no media row ${input.media_id} on this page`)
  if (!media.transcript?.words.length) return fail('the media has no transcript — run transcribe_clip first')
  const clips = captionsFromTranscript(
    {
      ...media.transcript,
      words: media.transcript.words.filter((w) => !media.cuts.some((c) => w.start < c.end && w.end > c.start)),
    },
    { style: input.style },
  )
  /* captions sit where the media's clip does: its start − trimIn maps words
     from source time onto the clock; `at` overrides when the caller places
     them by hand */
  const clip = comp.tracks
    .flatMap((t) => t.clips ?? [])
    .find((c) => c.source.type === 'asset' && c.source.assetId === media.assetId)
  const offset = input.at !== undefined ? input.at - media.trimIn : clip ? clip.start - media.trimIn : 0
  for (const c of clips) c.start += offset
  const captionTrack = comp.tracks.find((t) => t.kind === 'caption' && !t.muted)
  const ops = captionTrack
    ? clips.map((c) => ({ op: 'add_clip' as const, trackId: captionTrack.id, clip: c }))
    : [{ op: 'add_track' as const, track: { id: 'captions', kind: 'caption' as const, name: 'Captions', clips } }]
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'captions rejected')
  return ok({ composition: applied.composition, captions: clips.length })
}

/**
 * Voice ranges duck the music: gain keyframes land on the page's first
 * audio track (or a named one) and stay editable (proposal 14.8). Ranges are
 * source words/ranges on the clock — pass `ranges`, or a `media_id` whose
 * transcript's words are taken as speech. */
export async function duckAudio(
  canvas: Canvas,
  pageId: string,
  input: {
    media_id?: string
    ranges?: { start: number; end: number }[]
    track_id?: string
    depth?: number
    attack?: number
    release?: number
    gain?: number
  },
  actor: Actor,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition`)
  let ranges = input.ranges
  if (!ranges) {
    if (!input.media_id) return fail('send ranges, or a media_id whose transcript marks the speech')
    const media = await persist.getSceneMedia(canvas.id, input.media_id)
    if (!media?.transcript?.words.length) return fail('the media has no transcript')
    ranges = speechRanges(media.transcript.words)
    /* words are source-time; shift by the clip's window like build_captions */
    const clip = comp.tracks
      .flatMap((t) => t.clips ?? [])
      .find((c) => c.source.type === 'asset' && c.source.assetId === media.assetId)
    const offset = (clip?.start ?? 0) - media.trimIn
    ranges = ranges.map((r) => ({ start: r.start + offset, end: r.end + offset }))
  }
  const track = input.track_id
    ? comp.tracks.find((t) => t.id === input.track_id && t.kind === 'audio')
    : comp.tracks.find((t) => t.kind === 'audio' && !t.muted)
  if (!track) return fail('no audio track to duck — add the music first')
  const keyframes = duckingKeyframes(ranges, {
    gain: input.gain,
    depth: input.depth,
    attack: input.attack,
    release: input.release,
  })
  const applied = actions.patchComposition(
    canvas.id,
    pageId,
    keyframes.map((keyframe) => ({ op: 'add_keyframe' as const, trackId: track.id, keyframe })),
    actor,
  )
  if (!applied.ok) return fail(applied.error ?? 'ducking rejected')
  return ok({ composition: applied.composition, keyframes: keyframes.length, trackId: track.id })
}

/** contiguous speech from a word list: a gap over 0.6 s starts a new range */
function speechRanges(words: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const w of words) {
    const last = out[out.length - 1]
    if (last && w.start - last.end <= 0.6) last.end = w.end
    else out.push({ start: w.start, end: w.end })
  }
  return out
}

/** suggested transcript edits: filler words and long silences (14.10) */
export async function suggestCuts(canvas: Canvas, input: { media_id: string; min_silence?: number }): Promise<Outcome> {
  const media = await persist.getSceneMedia(canvas.id, input.media_id)
  if (!media || media.canvasId !== canvas.id) return fail(`no media row ${input.media_id}`)
  if (!media.transcript?.words.length) return fail('the media has no transcript')
  return ok(findFillers(media.transcript.words, input.min_silence))
}

/* ---- generate_video (14.11) ---- */

/** the model menu + the estimate the panel shows before a run */
export function videoModels(input: { model?: string; seconds?: number }) {
  const m = input.model !== undefined ? videoModel(input.model) : undefined
  return {
    models: VIDEO_MODELS,
    priceDate: VIDEO_PRICE_DATE,
    estimate: m ? { model: m.id, cost: videoCost(m, input.seconds) } : undefined,
  }
}

/**
 * Generate a video clip on the person's own OpenRouter or Gemini account,
 * store it as an /a/ asset, write its scene_media row with the recipe
 * ({provider, model, prompt, seed, cost}) and land it as a clip at `at`
 * seconds. Long-running: the provider job is polled, so this call can take
 * minutes.
 */
export async function generateVideoClip(
  canvas: Canvas,
  pageId: string,
  input: {
    prompt: string
    model?: string
    seconds?: number
    aspect?: VideoAspect
    seed?: number
    first_frame?: string
    last_frame?: string
    refs?: string[]
    at?: number
  },
  actor: Actor,
  /** the user whose connected key pays — undefined only bills nobody */
  payerId: string | undefined,
): Promise<Outcome> {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  if (!input.prompt?.trim()) return fail('a prompt is required')
  /* frame and reference images are bounded — a megabyte-scale prompt
     argument is a corrupt call, not a photo */
  const IMAGE_MAX = 8_000_000
  if ((input.first_frame?.length ?? 0) > IMAGE_MAX || (input.last_frame?.length ?? 0) > IMAGE_MAX)
    return fail('a frame image is too large')
  if (input.refs && (input.refs.length > 5 || input.refs.some((r) => typeof r !== 'string' || r.length > IMAGE_MAX)))
    return fail('too many or too large reference images')
  if (!payerId) return fail('connect a Diazo account to run video generation on your own key')
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — make the timeline first`)
  let video
  try {
    video = await generateVideo(payerId, {
      prompt: input.prompt,
      model: input.model,
      seconds: input.seconds,
      aspect: input.aspect,
      seed: input.seed,
      firstFrame: input.first_frame,
      lastFrame: input.last_frame,
      refs: input.refs,
    })
  } catch (e) {
    if (e instanceof VideoGenError) return fail(e.message)
    throw e
  }
  const asset = await storeAsset(
    video.buf,
    { mime: video.mime, ext: video.ext },
    { canvasId: canvas.id, ownerId: payerId, uploadedBy: actor.name },
  )
  const now = Date.now()
  const prev = await persist.findSceneMediaByAsset(canvas.id, pageId, asset.id)
  const media = {
    id: prev?.id ?? nanoid(10),
    canvasId: canvas.id,
    pageId,
    assetId: asset.id,
    kind: 'video' as const,
    trimIn: 0,
    trimOut: null,
    cuts: [],
    generation: {
      ...video.recipe,
      ...(input.refs?.length ? { refs: input.refs } : {}),
      ...(input.first_frame ? { first_frame: input.first_frame } : {}),
    },
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  persist.saveSceneMedia(media)
  const at = input.at ?? 0
  const clip = {
    id: `gen-${asset.id}`,
    start: at,
    duration: video.seconds,
    source: { type: 'asset' as const, assetId: asset.id },
    name: input.prompt.slice(0, 60),
  }
  const clipTrack = comp.tracks.find((t) => t.kind === 'clip' && !t.muted)
  const ops = clipTrack
    ? [{ op: 'add_clip' as const, trackId: clipTrack.id, clip }]
    : [
        {
          op: 'add_track' as const,
          track: { id: 'generated', kind: 'clip' as const, name: 'Generated', clips: [clip] },
        },
      ]
  const applied = actions.patchComposition(canvas.id, pageId, ops, actor)
  if (!applied.ok) return fail(applied.error ?? 'clip insert rejected')
  return ok({ asset, media, clip, composition: applied.composition, cost: video.recipe.cost })
}

export type { Composition }
