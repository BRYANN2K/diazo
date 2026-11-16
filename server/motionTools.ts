/**
 * server/motionTools.ts — the Motion Studio tool logic, shared by the MCP
 * tools (server/mcp.ts) and the resident agent (server/resident.ts). Every
 * function takes the canvas the caller already gated and returns
 * `{ ok: true, data }` or `{ ok: false, error }`; the caller shapes that
 * into its transport.
 */

import * as actions from './actions.ts'
import { store } from './store.ts'
import { createRenderJob } from './motionJobs.ts'
import { elementHtml, lintComposition, lintMotionHtml, motionLintSummary } from '../shared/motionLint.ts'
import { exportCompositionCode, type CompositionCodeExport } from '../shared/motionExport.ts'
import { itemMeta, libraryItems, saveMeta } from './libraryIndex.ts'
import { getLibrary } from './libraries.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import {
  buildStoryboard,
  MOTION_BLOCK_ATTR,
  parseCompositionBody,
  parseMotionBlock,
  parseOps,
  type Composition,
  type FrameMotionBlock,
  type MotionLintIssue,
} from '../shared/motion.ts'
import type { Actor, Canvas } from '../shared/types.ts'
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }
const ok = <T>(data: T) => ({ ok: true as const, data })
const fail = <T = unknown>(error: string): { ok: false; error: string; data?: T } => ({ ok: false, error })

function pageOn(canvas: Canvas, pageId: string): boolean {
  return canvasPages(canvas).some((p) => p.id === pageId)
}

export function getCompositionData(canvas: Canvas, pageId: string): Outcome {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — create one with set_composition or animate_storyboard`)
  return ok(comp)
}

/** Whole-body replace, or an ops batch when `ops` is sent instead. */
export function setCompositionData(
  canvas: Canvas,
  pageId: string,
  input: { composition?: unknown; ops?: unknown; expected_revision?: unknown },
  actor: Actor,
): Outcome {
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
    return ok({ composition: applied.composition })
  }
  if (input.composition === undefined) return fail('send composition (a full timeline) or ops (a patch)')
  const body = parseCompositionBody(input.composition)
  if (!body.ok) return fail(body.error)
  return ok({ composition: actions.setComposition(canvas.id, body.value, pageId, actor) })
}

/**
 * Build the timeline a page of frames implies — one shot per frame in
 * reading order, a camera track cutting between them — and save it. The
 * agent plans the story from the brief, calls this once, then refines with
 * set_composition ops (moves instead of cuts, captions, clips).
 */
export function animateStoryboard(
  canvas: Canvas,
  pageId: string,
  input: {
    shot_seconds?: number
    margin?: number
    fps?: number
    width?: number
    height?: number
    frame_ids?: string[]
  },
  actor: Actor,
): Outcome {
  if (!pageOn(canvas, pageId)) return fail(`no page ${pageId} on this canvas`)
  const wanted = input.frame_ids ? new Set(input.frame_ids) : null
  const frames = pageFrames(canvas, pageId).filter((f) => !wanted || wanted.has(f.id))
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
  })
  const composition = actions.setComposition(canvas.id, body, pageId, actor)
  return ok({
    composition,
    shots,
    note: `${shots.length} shot(s), hard cuts — use set_composition ops to turn cuts into camera moves, add captions and clips, then lint_motion before rendering.`,
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
  if (comp) issues.push(...lintComposition(comp, { frameIds }))
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
  if (!created.ok) return fail(created.error)
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

export type { Composition }
