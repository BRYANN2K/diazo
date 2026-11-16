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
import { lintComposition, lintMotionHtml, motionLintSummary } from '../shared/motionLint.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import {
  buildStoryboard,
  parseCompositionBody,
  parseOps,
  type Composition,
  type MotionLintIssue,
} from '../shared/motion.ts'
import type { Actor, Canvas } from '../shared/types.ts'

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }
const ok = (data: unknown): Outcome => ({ ok: true, data })
const fail = (error: string): Outcome => ({ ok: false, error })

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

export type { Composition }
