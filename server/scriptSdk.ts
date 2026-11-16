/**
 * server/scriptSdk.ts — the host side of the `diazo` SDK. The sandbox worker
 * calls in with `ns.fn` paths; this module resolves each to the same action
 * functions and role gates the MCP tools use, inside one run's context.
 *
 * Errors cross the bridge as DiazoError: a `code` for the client and a
 * message that names the fix. Writes are counted against the run's
 * frame_writes budget; under `dryRun` every write computes its outcome
 * without touching the canvas.
 */
import { env } from './env.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import { updateFrameMeta } from './pageTools.ts'
import { canvasRole, canAccessCanvas } from './access.ts'
import { roleAllows, type CanvasRole } from '../shared/canvasRole.ts'
import { canvasesFor } from './workspaces.ts'
import { canvasPages } from '../shared/pages.ts'
import { fontsForCanvas } from './fonts.ts'
import { webFontFamilies } from '../shared/webFonts.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import type { ComponentDef, ComponentProp } from '../shared/components.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import type { Composition, MotionTrack } from '../shared/motion.ts'
import { lintFrame } from './lint.ts'
import { checkFrame } from './frameChecks.ts'
import { textContrast } from '../shared/frameChecks.ts'
import { cssColorToRgba } from '../shared/slopRules.ts'
import { loadFramePage, renderFrame, rendererAvailable } from './screenshot.ts'
import { pixelScore } from './driftDiff.ts'
import * as imageSearch from './imageSearch.ts'
import { itemDetail, libraryFor, readableLibraries, searchLibraries } from './libraryQueries.ts'
import { libraryItems } from './libraryIndex.ts'
import { runComponentTool } from './componentTools.ts'
import { findComponent, componentDetail } from './componentActions.ts'
import * as motion from './motionTools.ts'
import * as dom from './scriptDom.ts'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

export type SdkErrorCode =
  'permission' | 'not_found' | 'invalid' | 'conflict' | 'unavailable' | 'refused' | 'limit' | 'failed'

export class SdkError extends Error {
  code: SdkErrorCode
  limit?: string
  constructor(code: SdkErrorCode, message: string, limit?: string) {
    super(message)
    this.name = 'DiazoError'
    this.code = code
    this.limit = limit
  }
}

const invalid = (message: string) => new SdkError('invalid', message)
const notFound = (message: string) => new SdkError('not_found', message)
const denied = (message: string) => new SdkError('permission', message)

/* ------------------------------------------------------------------ */
/* the run context the dispatcher works inside                         */
/* ------------------------------------------------------------------ */

export interface ScriptRunContext {
  /** the canvas every call is scoped to — cross-canvas ids fail */
  canvasId: string
  active?: boolean
  draft?: Canvas
  /** the caller's canvas role; the caller's user id for library reads */
  userId?: string
  /** stamped on every write (its `runId` tags the script_runs row) */
  actor: Actor
  /** false for query_script: write paths refuse */
  write: boolean
  dryRun: boolean
  runId: string
  /** per-run budgets, decremented here */
  budgets: { frameWrites: number }
  /** checks.snapshot renders kept until the run ends (checks.diff reads them) */
  snapshots: Map<string, { frameId: string; png: Buffer; width: number; height: number }>
  /** audit: the writes this run made (path + frame target) */
  writes: { path: string; frameId?: string }[]
}

function roleOf(ctx: ScriptRunContext): CanvasRole | null {
  const canvas = store.getCanvas(ctx.canvasId)
  return canvas ? canvasRole(ctx.userId, canvas) : null
}

function canvasOf(ctx: ScriptRunContext): Canvas {
  const canvas = ctx.draft ?? store.getCanvas(ctx.canvasId)
  if (!canvas) throw notFound('the canvas is gone')
  return canvas
}

function frameOf(ctx: ScriptRunContext, frameId: string): Frame {
  const frame = ctx.draft ? ctx.draft.frames.find((f) => f.id === frameId) : store.getFrame(frameId)
  if (!frame) throw notFound(`no frame ${frameId}`)
  if (frame.canvasId !== ctx.canvasId) throw denied(`frame ${frameId} is not on this canvas`)
  return frame
}

interface FrameRef {
  id: string
  pageId?: string
  name: string
  box: { x: number; y: number; width: number; height: number }
  hidden?: boolean
  locked?: boolean
  approval?: string
  htmlChars: number
}

function refOf(frame: Frame): FrameRef {
  return {
    id: frame.id,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
    name: frame.name,
    box: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    ...(frame.hidden ? { hidden: true } : {}),
    ...(frame.locked ? { locked: true } : {}),
    ...(frame.approval ? { approval: frame.approval.status } : {}),
    htmlChars: frame.html.length,
  }
}

/* ------------------------------------------------------------------ */
/* review — the aggregate every write returns                          */
/* ------------------------------------------------------------------ */

interface Finding {
  rule: string
  severity: string
  message: string
  elementId?: string
  selector?: string
}

async function reviewOf(frame: Frame, actor: Actor, opts: { render?: boolean } = {}): Promise<Record<string, unknown>> {
  void actor
  const lint = await lintFrame(frame)
  const tokens = store.getTokens(frame.canvasId)
  const inventory = dom.styleInventory(frame.html, tokens)
  const components = store.getComponents(frame.canvasId)
  const redrawn = redrawnComponents(frame.html, components)
  const errors: Finding[] = lint.issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ rule: i.ruleId, severity: i.severity, message: i.message }))
  let responsive: unknown = null
  let measure: unknown = null
  if (opts.render) {
    const checks = await checkFrame(frame)
    responsive = checks ? responsiveResult(checks) : null
    if (checks)
      errors.push(
        ...checks.issues
          .filter((i) => i.severity === 'error')
          .map((i) => ({ rule: i.ruleId, severity: i.severity, message: i.message })),
      )
    measure = rendererAvailable() ? await measureOf(frame).catch(() => null) : null
  }
  return {
    ok: true,
    lint: {
      score: lint.score,
      errors: lint.errors,
      warnings: lint.warnings,
      issues: lint.issues.map((i) => ({ rule: i.ruleId, severity: i.severity, message: i.message })),
    },
    responsive,
    measure,
    tokenCoverage: inventory.tokenCoverage,
    redrawnComponents: redrawn,
    errors,
  }
}

/** Elements that redraw a component's markup instead of <doop-use>. */
function redrawnComponents(html: string, components: ComponentDef[]): { component: string; elementId?: string }[] {
  const out: { component: string; elementId?: string }[] = []
  for (const def of components) {
    if (!def.template) continue
    /* a template's first tag copied without the use marker reads as a redraw */
    const tag = /^<([a-z0-9-]+)/i.exec(def.template.trim())?.[1]
    if (!tag || html.includes('<doop-use')) continue
    const hits = dom.findInHtml(html, `css:${tag}[data-component="${def.id}"]`)
    for (const hit of hits.slice(0, 3))
      out.push({ component: def.name, ...(hit.elementId ? { elementId: hit.elementId } : {}) })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* checks helpers                                                      */
/* ------------------------------------------------------------------ */

function responsiveResult(c: import('../shared/frameChecks.ts').FrameChecks): Record<string, unknown> {
  return {
    score: c.score,
    errors: c.errors,
    warnings: c.warnings,
    issues: c.issues.map((i) => ({
      rule: i.ruleId,
      severity: i.severity,
      message: i.message,
      ...(i.elementId ? { elementId: i.elementId } : {}),
      ...(i.selector ? { selector: i.selector } : {}),
    })),
    viewports: c.viewports.map((v) => ({ width: v.width, overflowPx: v.overflowPx, clippedText: 0, tapTargets: 0 })),
    focus: c.focus,
  }
}

/** The layout numbers a screenshot would only show a person. */
async function measureOf(frame: Frame): Promise<Record<string, unknown>> {
  const loaded = await loadFramePage(frame, { priority: 'interactive' })
  try {
    const consoleErrors: string[] = []
    loaded.page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
    })
    const measured = (await loaded.page.evaluate(`
      (() => {
        const W = ${frame.width}, H = ${frame.height}
        const doc = document.documentElement
        const sections = [...document.body.children].filter(el => el.offsetParent !== null || el.tagName === 'MAIN').slice(0, 40)
        const outside = []
        const overlaps = []
        const seen = new Set()
        let overflowPx = 0
        let clippedText = 0
        const all = document.querySelectorAll('body *')
        for (const el of all) {
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          const over = Math.max(0, r.right - W)
          if (over > overflowPx) overflowPx = over
          if ((r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1) && outside.length < 20) {
            const id = el.getAttribute('data-doop-id')
            const key = id || el.tagName + '.' + (el.className && String(el.className).split(' ')[0] || '')
            if (!seen.has(key)) { seen.add(key); outside.push({ elementId: id || undefined, selector: el.tagName.toLowerCase(), px: Math.round(Math.max(r.right - W, r.bottom - H, -r.left, -r.top)) }) }
          }
          if (el.children.length === 0 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) clippedText++
        }
        const sibs = [...document.body.children].flatMap(p => [...p.children])
        for (let i = 0; i < Math.min(sibs.length, 60); i++) {
          const a = sibs[i].getBoundingClientRect()
          for (let j = i + 1; j < Math.min(sibs.length, 60); j++) {
            const b = sibs[j].getBoundingClientRect()
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            if (ox > 4 && oy > 4 && overlaps.length < 20) overlaps.push({ a: sibs[i].tagName.toLowerCase(), b: sibs[j].tagName.toLowerCase(), px: Math.round(Math.min(ox, oy)) })
          }
        }
        const brokenImages = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => ({ src: String(i.src).slice(0, 200) })).slice(0, 20)
        const asked = new Set()
        for (const el of all) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); if (f) asked.add(f) }
        const fallbackFonts = [...asked].filter(f => !document.fonts.check('12px "' + f + '"')).slice(0, 20)
        const sectionsOut = sections.map(el => { const r = el.getBoundingClientRect(); return { selector: el.tagName.toLowerCase(), elementId: el.getAttribute('data-doop-id') || undefined, box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } } })
        return { heightDeltaPx: Math.round(doc.scrollHeight - H), overflowPx: Math.round(overflowPx), outside, clippedText, overlaps, brokenImages, fallbackFonts, sections: sectionsOut }
      })()
    `)) as Record<string, unknown>
    return { ok: true, width: frame.width, height: frame.height, ...measured, consoleErrors }
  } finally {
    await loaded.close()
  }
}

/** The regions two renders disagree on, at ~24px cells merged into boxes. */
async function diffRegions(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const CELL = 24
  const [ra, rb] = await Promise.all([
    sharp(a).flatten({ background: '#fff' }).removeAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer(),
    sharp(b).flatten({ background: '#fff' }).removeAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer(),
  ])
  const cols = Math.ceil(width / CELL)
  const rows = Math.ceil(height / CELL)
  const hot = new Set<number>()
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let diff = false
      for (let y = cy * CELL; y < Math.min((cy + 1) * CELL, height) && !diff; y += 4) {
        for (let x = cx * CELL; x < Math.min((cx + 1) * CELL, width); x += 4) {
          const i = (y * width + x) * 3
          if (
            Math.abs(ra[i]! - rb[i]!) > 24 ||
            Math.abs(ra[i + 1]! - rb[i + 1]!) > 24 ||
            Math.abs(ra[i + 2]! - rb[i + 2]!) > 24
          ) {
            diff = true
            break
          }
        }
      }
      if (diff) hot.add(cy * cols + cx)
    }
  }
  /* merge hot cells into rectangles (greedy, per row runs then columns) */
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  const seen = new Set<number>()
  for (const cell of hot) {
    if (seen.has(cell)) continue
    const cy = Math.floor(cell / cols)
    const cx = cell % cols
    let w = 0
    let h = 0
    while (hot.has(cy * cols + cx + w) && !seen.has(cy * cols + cx + w)) w++
    while (
      [...Array(w).keys()].every((dx) => hot.has((cy + h) * cols + cx + dx) && !seen.has((cy + h) * cols + cx + dx))
    )
      h++
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) seen.add((cy + dy) * cols + cx + dx)
    boxes.push({ x: cx * CELL, y: cy * CELL, width: w * CELL, height: h * CELL })
  }
  return boxes.slice(0, 32)
}

/* ------------------------------------------------------------------ */
/* compositions.stateAt — a computed sample, not a render              */
/* ------------------------------------------------------------------ */

function propAt(
  keys: { t: number; value: number | string; easing: { type: string } }[],
  t: number,
): number | string | undefined {
  if (!keys.length) return undefined
  const sorted = [...keys].sort((a, b) => a.t - b.t)
  if (t <= sorted[0]!.t) return sorted[0]!.value
  if (t >= sorted[sorted.length - 1]!.t) return sorted[sorted.length - 1]!.value
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (t < a.t || t >= b.t) continue
    if (a.easing.type === 'hold') return a.value
    if (typeof a.value === 'number' && typeof b.value === 'number') {
      /* every easing is read as linear here — the numbers are for layout
         checks, and a wrong arc never lies about a collision */
      const f = (t - a.t) / (b.t - a.t)
      return a.value + (b.value - a.value) * f
    }
    return t - a.t < (b.t - a.t) / 2 ? a.value : b.value
  }
  return undefined
}

function stateAt(comp: Composition, canvas: Canvas, t: number): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  const camera: Record<string, unknown> = {}
  const activeClips: { trackId: string; kind: string }[] = []
  for (const track of comp.tracks as MotionTrack[]) {
    if (track.kind === 'camera') {
      for (const prop of ['x', 'y', 'zoom', 'rotation']) {
        const keys = (track.keyframes ?? []).filter((k) => k.property === prop)
        const v = propAt(keys, t)
        if (v !== undefined) camera[prop] = v
      }
      continue
    }
    if (track.kind === 'element' && track.frameId && track.elementId) {
      if (track.muted) continue
      const state: Record<string, unknown> = { key: `${track.frameId}/${track.elementId}` }
      const byProp = new Map<string, { t: number; value: number | string; easing: { type: string } }[]>()
      for (const k of track.keyframes ?? []) {
        const list = byProp.get(k.property) ?? []
        list.push(k)
        byProp.set(k.property, list)
      }
      for (const [prop, keys] of byProp) {
        const v = propAt(keys, t)
        if (v !== undefined) state[prop] = v
      }
      elements.push(state)
      continue
    }
    if ((track.kind === 'clip' || track.kind === 'audio' || track.kind === 'caption') && !track.muted) {
      for (const clip of track.clips ?? []) {
        if (t >= clip.start && t < clip.start + clip.duration) activeClips.push({ trackId: track.id, kind: track.kind })
      }
    }
  }
  /* title-safe: element boxes crossing 10% of the output frame */
  const mx = comp.width * 0.1
  const my = comp.height * 0.1
  const boxes = elements
    .filter(
      (e) =>
        typeof e.x === 'number' &&
        typeof e.y === 'number' &&
        typeof e.width === 'number' &&
        typeof e.height === 'number',
    )
    .map((e) => ({
      key: String(e.key),
      x: e.x as number,
      y: e.y as number,
      w: e.width as number,
      h: e.height as number,
    }))
  const titleUnsafe = boxes
    .filter((b) => b.x < mx || b.y < my || b.x + b.w > comp.width - mx || b.y + b.h > comp.height - my)
    .map((b) => ({ key: b.key, box: { x: b.x, y: b.y, width: b.w, height: b.h } }))
  const overlaps: { a: string; b: string }[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i]!, boxes[j]!]
      if (
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
      ) {
        overlaps.push({ a: a.key, b: b.key })
      }
    }
  }
  void canvas
  return {
    t,
    camera: Object.keys(camera).length ? camera : null,
    elements,
    activeClips,
    titleUnsafe,
    overlaps: overlaps.slice(0, 20),
  }
}

/* ------------------------------------------------------------------ */
/* the handler table                                                   */
/* ------------------------------------------------------------------ */

type Args = unknown[]
type Handler = (ctx: ScriptRunContext, args: Args) => Promise<unknown>

interface Entry {
  /** needs `edit` on the canvas and a run_script (not query_script) */
  write?: boolean
  /** consumes the frame_writes budget */
  frameWrite?: boolean
  fn: Handler
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw invalid(`${name} must be a non-empty string`)
  return v
}
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${name} must be an object`)
  return v as Record<string, unknown>
}
const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${name} must be a number`)
  return v
}

const HANDLERS: Record<string, Entry> = {
  /* ---- diazo.canvas ---- */
  'canvas.summary': {
    fn: async (ctx, args) => {
      const opts = args[0] === undefined ? {} : obj(args[0], 'opts')
      const canvas = canvasOf(ctx)
      const frames = canvas.frames.filter((f) => !f.demo).map(refOf)
      const tokens = store.getTokens(canvas.id).map(tokenSummary)
      const components = (canvas.components ?? []).map(componentSummary)
      const brief = typeof opts.brief === 'string' ? opts.brief : undefined
      return {
        name: canvas.name,
        pages: canvasPages(canvas).map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.startFrameId ? { startFrameId: p.startFrameId } : {}),
        })),
        frames,
        tokens,
        tokenThemes: canvas.tokenThemes ?? [],
        components,
        fonts: [...fontsForCanvas(canvas).map((f) => f.family), ...webFontFamilies()],
        libraryMatches: brief ? await libraryMatches(ctx, brief) : [],
        guides: store.getGuidelines(canvas.id).map((g) => ({ name: g.name, ...(g.title ? { title: g.title } : {}) })),
      }
    },
  },
  'canvas.status': {
    write: true,
    fn: async (ctx, args) => {
      if (!ctx.dryRun) actions.setAgentStatus(ctx.canvasId, ctx.actor, str(args[0], 'text'))
      return { ok: true }
    },
  },

  /* ---- diazo.frames ---- */
  'frames.list': {
    fn: async (ctx, args) => {
      const opts = args[0] === undefined ? {} : obj(args[0], 'opts')
      const canvas = canvasOf(ctx)
      return canvas.frames.filter((f) => !f.demo && (opts.pageId === undefined || f.pageId === opts.pageId)).map(refOf)
    },
  },
  'frames.outline': { fn: async (ctx, args) => dom.outline(frameOf(ctx, str(args[0], 'frameId')).html) },
  'frames.html': {
    fn: async (ctx, args) => {
      const html = frameOf(ctx, str(args[0], 'frameId')).html
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      const limit = typeof opts.limit === 'number' ? Math.max(1, Math.min(opts.limit, 40000)) : 40000
      let offset = typeof opts.offset === 'number' ? Math.max(0, opts.offset) : 0
      if (typeof opts.query === 'string' && opts.query) {
        const at = html.indexOf(opts.query)
        if (at >= 0) offset = Math.max(0, at - Math.floor(limit / 4))
      }
      return html.slice(offset, offset + limit)
    },
  },
  'frames.styles': {
    fn: async (ctx, args) => dom.styleInventory(frameOf(ctx, str(args[0], 'frameId')).html, canvasOf(ctx).tokens ?? []),
  },
  'frames.find': {
    fn: async (ctx, args) => dom.findInHtml(frameOf(ctx, str(args[0], 'frameId')).html, str(args[1], 'query')),
  },
  'frames.create': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const input = obj(args[0], 'input')
      if (ctx.dryRun) {
        const draft = { ...input, id: randomUUID(), canvasId: ctx.canvasId, x: input.x ?? 0, y: input.y ?? 0 } as Frame
        canvasOf(ctx).frames.push(draft)
        return {
          ok: true,
          id: draft.id,
          name: str(input.name, 'name'),
          box: {
            x: input.x ?? 0,
            y: input.y ?? 0,
            width: num(input.width, 'width'),
            height: num(input.height, 'height'),
          },
          htmlChars: String(input.html ?? '').length,
        }
      }
      const frame = actions.createFrame(
        ctx.canvasId,
        {
          name: str(input.name, 'name'),
          html: str(input.html, 'html'),
          width: num(input.width, 'width'),
          height: num(input.height, 'height'),
          ...(input.x !== undefined ? { x: num(input.x, 'x') } : {}),
          ...(input.y !== undefined ? { y: num(input.y, 'y') } : {}),
          ...(input.pageId !== undefined ? { pageId: str(input.pageId, 'pageId') } : {}),
        },
        ctx.actor,
      )
      if (!frame) throw new SdkError('failed', 'the frame could not be created')
      return refOf(frame)
    },
  },
  'frames.stream': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const html = str(args[1], 'html')
      const chunks = dom.streamSections(html)
      if (ctx.dryRun) {
        frame.html = html
        return { ok: true, sections: chunks.length, review: await reviewOf(frame, ctx.actor, {}) }
      }
      for (let i = 0; i < chunks.length; i++) {
        const out = actions.appendFrameHtml(frame.id, chunks[i]!, ctx.actor, {
          start: i === 0,
          done: i === chunks.length - 1,
        })
        if (!out) throw notFound(`no frame ${frame.id}`)
      }
      const written = store.getFrame(frame.id)!
      return { ok: true, sections: chunks.length, review: await reviewOf(written, ctx.actor, {}) }
    },
  },
  'frames.edit': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const ops = args[1]
      if (!Array.isArray(ops) || !ops.length) throw invalid('ops must be a non-empty array')
      const result = dom.applyEditOps(frame.html, ops as dom.EditOp[])
      if (ctx.dryRun) {
        frame.html = result.html
        return {
          ok: true,
          applied: result.applied,
          failed: result.failed,
          htmlChars: result.html.length,
          review: await reviewOf({ ...frame, html: result.html }, ctx.actor, {}),
        }
      }
      if (!result.applied)
        return {
          ok: true,
          applied: 0,
          failed: result.failed,
          htmlChars: frame.html.length,
          review: await reviewOf(frame, ctx.actor, {}),
        }
      const written = actions.updateFrame(frame.id, { html: result.html }, ctx.actor)
      if (!written) throw new SdkError('failed', 'the frame write did not apply')
      return {
        ok: true,
        applied: result.applied,
        failed: result.failed,
        htmlChars: written.html.length,
        review: await reviewOf(written, ctx.actor, {}),
      }
    },
  },
  'frames.replaceValues': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const input = obj(args[1], 'input')
      const kinds = input.kinds
      if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string'))
        throw invalid('kinds must be a string array')
      const result = dom.replaceValues(frame.html, canvasOf(ctx).tokens ?? [], {
        kinds: kinds as string[],
        match: input.match === 'nearest' ? 'nearest' : 'exact',
        ...(Array.isArray(input.to) ? { to: input.to.map(String) } : {}),
      })
      if (ctx.dryRun || !result.count) {
        if (ctx.dryRun) frame.html = result.html
        return {
          count: result.count,
          unmapped: result.unmapped,
          htmlChars: result.html.length,
          review: await reviewOf({ ...frame, html: result.html }, ctx.actor, {}),
        }
      }
      const written = actions.updateFrame(frame.id, { html: result.html }, ctx.actor)!
      return {
        count: result.count,
        unmapped: result.unmapped,
        htmlChars: written.html.length,
        review: await reviewOf(written, ctx.actor, {}),
      }
    },
  },
  'frames.update': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const patch = obj(args[1], 'patch')
      if (ctx.dryRun) {
        for (const key of ['name', 'hidden', 'locked', 'pageId', 'x', 'y', 'width', 'height']) {
          if (key in patch) Object.assign(frame, { [key]: patch[key] })
        }
        return refOf(frame)
      }
      const meta: Record<string, unknown> = {}
      for (const key of ['name', 'hidden', 'locked', 'pageId']) if (key in patch) meta[key] = patch[key]
      if (Object.keys(meta).length) updateFrameMeta(canvasOf(ctx), frame.id, meta as never, ctx.actor)
      const box: Record<string, number> = {}
      for (const key of ['x', 'y', 'width', 'height']) if (key in patch) box[key] = num(patch[key], key)
      if (Object.keys(box).length) actions.updateFrame(frame.id, box, ctx.actor)
      return refOf(store.getFrame(frame.id)!)
    },
  },

  /* ---- diazo.tokens ---- */
  'tokens.get': {
    fn: async (ctx, args) => {
      const opts = args[0] === undefined ? {} : obj(args[0], 'opts')
      let tokens = canvasOf(ctx).tokens ?? []
      if (Array.isArray(opts.types)) tokens = tokens.filter((t) => (opts.types as string[]).includes(t.type))
      if (typeof opts.namePattern === 'string') {
        const re = new RegExp(opts.namePattern, 'i')
        tokens = tokens.filter((t) => re.test(t.name))
      }
      return tokens.map(tokenSummary)
    },
  },
  'tokens.create': {
    write: true,
    fn: async (ctx, args) => {
      const inputs = args[0]
      if (!Array.isArray(inputs) || !inputs.length) throw invalid('tokens must be a non-empty array')
      if (ctx.dryRun) {
        const tokens = (canvasOf(ctx).tokens ??= [])
        const created: string[] = []
        for (const input of inputs) {
          const token = obj(input, 'token')
          const name = str(token.name, 'name')
          if (tokens.some((t) => t.name === name)) throw invalid(`token ${name} exists`)
          tokens.push({
            ...token,
            name,
            order: tokens.length,
            updatedAt: Date.now(),
            updatedBy: ctx.actor.name,
          } as DesignToken)
          created.push(name)
        }
        return { ok: true, created, failed: [] }
      }
      const results = actions.createTokens(ctx.canvasId, inputs, ctx.actor)
      if (!results) throw notFound('the canvas is gone')
      return {
        ok: true,
        created: results.filter((r) => r.result === 'created').map((r) => r.name),
        failed: results
          .filter((r) => r.result !== 'created')
          .map((r) => ({ name: r.name, reason: r.result === 'error' ? r.message : 'rejected' })),
      }
    },
  },
  'tokens.set': {
    write: true,
    fn: async (ctx, args) => {
      const name = str(args[0], 'name')
      const value = str(args[1], 'value')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      if (ctx.dryRun) {
        const token = canvasOf(ctx).tokens?.find((t) => t.name === name)
        if (!token) throw notFound(`no token ${name}`)
        if (typeof opts.theme === 'string') (token.themes ??= {})[opts.theme] = value
        else token.value = value
        return { ok: true }
      }
      const edit = { name, value, ...(opts.theme !== undefined ? { theme: opts.theme } : {}) }
      const results = actions.setTokens(ctx.canvasId, [edit as never], ctx.actor)
      if (!results) throw notFound('the canvas is gone')
      const first = results[0]!
      if (first.result === 'error') throw invalid(`${first.name}: ${first.message}`)
      return { ok: true }
    },
  },
  'tokens.themes': {
    write: true,
    fn: async (ctx, args) => {
      const themes = args[0]
      if (!Array.isArray(themes)) throw invalid('themes must be an array')
      if (ctx.dryRun) {
        canvasOf(ctx).tokenThemes = themes
        return { ok: true, themes }
      }
      const out = actions.setTokenThemes(ctx.canvasId, themes, ctx.actor)
      if (!out) throw notFound('the canvas is gone')
      return { ok: true, themes: out }
    },
  },

  /* ---- diazo.components ---- */
  'components.list': {
    fn: async (ctx) => (canvasOf(ctx).components ?? []).map(componentSummary),
  },
  'components.get': {
    fn: async (ctx, args) => {
      const def = findComponent(ctx.canvasId, str(args[0], 'componentId'))
      if (!def) throw notFound(`no component ${String(args[0])}`)
      return componentDetail(canvasOf(ctx), def)
    },
  },
  'components.create': {
    write: true,
    fn: async (ctx, args) => {
      const input = obj(args[0], 'input')
      if (ctx.dryRun) return { ok: true, id: 'dry-run', name: input.name, usage: '' }
      const out = await componentTool(ctx, 'create_component', {
        name: input.name,
        description: input.description ?? '',
        template: input.template,
        css: input.css,
        props: input.props,
        slots: input.slots,
      })
      return out.data
    },
  },
  'components.update': {
    write: true,
    fn: async (ctx, args) => {
      const component = str(args[0], 'componentId')
      const patch = obj(args[1], 'patch')
      if (ctx.dryRun) return { ok: true }
      const out = await componentTool(ctx, 'update_component', {
        ...Object.fromEntries(
          Object.entries(patch).filter(([k]) =>
            ['name', 'description', 'template', 'css', 'props', 'slots'].includes(k),
          ),
        ),
        component,
      })
      return out.data
    },
  },
  'components.insert': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const componentId = str(args[1], 'componentId')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      const out = await componentTool(ctx, 'insert_instance', {
        frame_id: frame.id,
        component: componentId,
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        ...(opts.props !== undefined ? { props: opts.props } : {}),
        dry_run: ctx.dryRun ? true : undefined,
      })
      return out.data
    },
  },

  /* ---- diazo.libraries ---- */
  'libraries.search': {
    fn: async (ctx, args) => {
      const query = str(args[0], 'query')
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      const libs = await readableLibraries(ctx.userId ?? '')
      const canvases = libs.map((l) => store.getCanvas(l.id)).filter((c): c is Canvas => !!c)
      const result = await searchLibraries(canvases, { query, limit: typeof opts.limit === 'number' ? opts.limit : 12 })
      return result.hits.map((h) => ({
        itemId: h.item.id,
        libraryId: h.libraryId,
        label: h.item.label,
        category: h.item.category,
        tags: h.item.tags,
      }))
    },
  },
  'libraries.item': {
    fn: async (ctx, args) => {
      const itemId = str(args[0], 'itemId')
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      const lib = typeof opts.libraryId === 'string' ? opts.libraryId : null
      const libs = lib ? [lib] : (await readableLibraries(ctx.userId ?? '')).map((l) => l.id)
      for (const libraryId of libs) {
        const access = libraryFor(ctx.userId ?? '', libraryId, 'read')
        if (!access) continue
        const detail = await itemDetail(access.canvas, itemId, access.role)
        if (detail) {
          const item = detail.item
          return {
            itemId: item.itemId,
            libraryId,
            label: item.label,
            description: item.description,
            category: item.category,
            tags: item.tags,
            html: libraryItemHtml(item) ?? '',
          }
        }
      }
      throw notFound(`no library item ${itemId}`)
    },
  },
  'libraries.check': {
    fn: async (ctx, args) => {
      const opts = args[0] === undefined ? {} : obj(args[0], 'opts')
      const libs =
        typeof opts.libraryId === 'string'
          ? [opts.libraryId]
          : (await readableLibraries(ctx.userId ?? '')).map((l) => l.id)
      const out: Record<string, unknown>[] = []
      for (const libraryId of libs) {
        if (!libraryFor(ctx.userId ?? '', libraryId, 'read')) throw denied('library read access required')
        const items = await libraryItems(libraryId)
        for (const item of items) {
          for (const f of item.findings ?? []) {
            out.push({ itemId: item.itemId, rule: f.kind, severity: 'warning', message: f.message })
          }
        }
      }
      return out.slice(0, 100)
    },
  },
  'libraries.insert': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const itemId = str(args[1], 'itemId')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      const lib = typeof opts.libraryId === 'string' ? opts.libraryId : null
      const libs = lib ? [lib] : (await readableLibraries(ctx.userId ?? '')).map((l) => l.id)
      for (const libraryId of libs) {
        const access = libraryFor(ctx.userId ?? '', libraryId, 'read')
        if (!access) continue
        const detail = await itemDetail(access.canvas, itemId, access.role)
        if (!detail) continue
        const html = libraryItemHtml(detail.item)
        if (!html) throw new SdkError('failed', `item ${itemId} holds no markup`)
        if (ctx.active === false) throw new SdkError('limit', 'wall limit reached', 'wall')
        const markup = `<div data-doop-library="${libraryId}/${itemId}">\n${html}\n</div>`
        const result = dom.applyEditOps(frame.html, [
          {
            op: 'insert',
            /* empty element = append at the end of <body> */
            element: '',
            html: markup,
            ...(opts.before !== undefined ? { before: String(opts.before) } : {}),
          },
        ])
        if (ctx.dryRun)
          return {
            ok: true,
            applied: result.applied,
            failed: result.failed,
            htmlChars: result.html.length,
            review: await reviewOf({ ...frame, html: result.html }, ctx.actor, {}),
          }
        if (!result.applied)
          throw new SdkError(
            'failed',
            `the item could not be inserted: ${result.failed[0]?.reason ?? 'no insertion point'}`,
          )
        const written = actions.updateFrame(frame.id, { html: result.html }, ctx.actor)!
        return {
          ok: true,
          applied: result.applied,
          failed: result.failed,
          htmlChars: written.html.length,
          review: await reviewOf(written, ctx.actor, {}),
        }
      }
      throw notFound(`no library item ${itemId}`)
    },
  },

  /* ---- diazo.compositions ---- */
  'compositions.get': {
    fn: async (ctx, args) => {
      const out = motion.getCompositionData(canvasOf(ctx), str(args[0], 'pageId'))
      if (!out.ok) return null
      return out.data
    },
  },
  'compositions.stateAt': {
    fn: async (ctx, args) => {
      const out = motion.getCompositionData(canvasOf(ctx), str(args[0], 'pageId'))
      if (!out.ok) throw notFound('the page has no composition')
      const times = args[1]
      if (!Array.isArray(times) || !times.every((t) => typeof t === 'number'))
        throw invalid('times must be a number array')
      const comp = out.data as Composition
      return (times as number[])
        .slice(0, 32)
        .map((t) => stateAt(comp, canvasOf(ctx), Math.max(0, Math.min(t, comp.duration))))
    },
  },
  'compositions.lint': {
    fn: async (ctx, args) => {
      const out = await motion.lintMotion(canvasOf(ctx), { page_id: str(args[0], 'pageId') })
      if (!out.ok) throw invalid(String(out.error))
      const v = out.data as {
        issues?: { rule: string; severity: string; message: string }[]
        errors?: number
        warnings?: number
      }
      return {
        ok: true,
        errors: v.errors ?? 0,
        warnings: v.warnings ?? 0,
        issues: (v.issues ?? []).map((i) => ({ rule: i.rule, severity: i.severity, message: i.message })),
      }
    },
  },
  'compositions.storyboard': {
    write: true,
    fn: async (ctx, args) => {
      const pageId = str(args[0], 'pageId')
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      if (ctx.dryRun) return { ok: true, revision: 0, shots: 0 }
      const out = motion.animateStoryboard(
        canvasOf(ctx),
        pageId,
        {
          shot_seconds: typeof opts.shotSeconds === 'number' ? opts.shotSeconds : undefined,
          margin: typeof opts.margin === 'number' ? opts.margin : undefined,
          fps: typeof opts.fps === 'number' ? opts.fps : undefined,
          width: typeof opts.width === 'number' ? opts.width : undefined,
          height: typeof opts.height === 'number' ? opts.height : undefined,
          frame_ids: Array.isArray(opts.frameIds) ? (opts.frameIds as string[]) : undefined,
        } as never,
        ctx.actor,
      )
      if (!out.ok) throw invalid(String(out.error))
      const v = out.data as { revision?: number; shots?: number }
      return { ok: true, revision: v.revision ?? 0, shots: v.shots ?? 0 }
    },
  },
  'compositions.patch': {
    write: true,
    fn: async (ctx, args) => {
      const pageId = str(args[0], 'pageId')
      const ops = args[1]
      if (!Array.isArray(ops)) throw invalid('ops must be an array')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      if (ctx.dryRun) return { ok: true, revision: 0 }
      const out = motion.setCompositionData(
        canvasOf(ctx),
        pageId,
        { ops, ...(opts.expectedRevision !== undefined ? { expected_revision: opts.expectedRevision } : {}) },
        ctx.actor,
      )
      if (!out.ok) throw invalid(String(out.error))
      return { ok: true, revision: (out.data as { revision: number }).revision }
    },
  },
  'compositions.render': {
    write: true,
    fn: async (ctx, args) => {
      const pageId = str(args[0], 'pageId')
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      if (ctx.dryRun) return { ok: true, jobId: 'dry-run' }
      const out = motion.renderComposition(canvasOf(ctx), pageId, opts as never, {
        id: ctx.runId,
        name: ctx.actor.name,
      })
      if (!out.ok) throw invalid(String(out.error))
      return { ok: true, jobId: (out.data as { job?: { id?: string } }).job?.id ?? '' }
    },
  },

  /* ---- diazo.checks ---- */
  'checks.lint': {
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const lint = await lintFrame(frame)
      return {
        score: lint.score,
        errors: lint.errors,
        warnings: lint.warnings,
        issues: lint.issues.map((i) => ({ rule: i.ruleId, severity: i.severity, message: i.message })),
      }
    },
  },
  'checks.responsive': {
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const out = await checkFrame(frame)
      if (!out) throw new SdkError('unavailable', 'responsive checks need the server renderer', 'renderer')
      return responsiveResult(out)
    },
  },
  'checks.measure': {
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      if (!rendererAvailable()) throw new SdkError('unavailable', 'measure needs the server renderer', 'renderer')
      return measureOf(frame)
    },
  },
  'checks.snapshot': {
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      if (!rendererAvailable()) throw new SdkError('unavailable', 'snapshot needs the server renderer', 'renderer')
      const png = await renderFrame(frame)
      const meta = await sharp(png).metadata()
      const id = `snap-${++snapshotSeq}-${randomUUID().slice(0, 8)}`
      ctx.snapshots.set(id, {
        frameId: frame.id,
        png,
        width: meta.width ?? frame.width,
        height: meta.height ?? frame.height,
      })
      return { id, frameId: frame.id, width: meta.width ?? frame.width, height: meta.height ?? frame.height }
    },
  },
  'checks.diff': {
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const snap = obj(args[1], 'snapshot')
      const kept = ctx.snapshots.get(String(snap.id ?? ''))
      if (!kept) throw invalid('unknown snapshot — call checks.snapshot first')
      if (kept.frameId !== frame.id) throw invalid('the snapshot was taken of another frame')
      if (!rendererAvailable()) throw new SdkError('unavailable', 'diff needs the server renderer', 'renderer')
      const png = await renderFrame(frame)
      const score = await pixelScore(kept.png, png)
      const meta = await sharp(png).metadata()
      const resized = (meta.width ?? 0) !== kept.width || (meta.height ?? 0) !== kept.height
      const regions = score.diffPixels
        ? await diffRegions(
            kept.png,
            png,
            Math.max(kept.width, meta.width ?? 1),
            Math.max(kept.height, meta.height ?? 1),
          )
        : []
      return { ratio: score.score / 100, regions, resized }
    },
  },
  'checks.review': {
    fn: async (ctx, args) =>
      reviewOf(frameOf(ctx, str(args[0], 'frameId')), ctx.actor, { render: rendererAvailable() }),
  },
  'checks.autofix': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const kinds = args[1] === undefined ? undefined : args[1]
      if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string')))
        throw invalid('kinds must be a string array')
      const wanted = new Set((kinds as string[] | undefined) ?? ['contrast', 'tapTarget', 'tokenLiteral'])
      const tokens = canvasOf(ctx).tokens ?? []
      const changes: string[] = []
      let html = frame.html
      /* tokenLiteral: swap literals that equal a token for var(--name) */
      if (wanted.has('tokenLiteral')) {
        const out = dom.replaceValues(html, tokens, {
          kinds: ['color', 'radius', 'spacing', 'font', 'fontSize'],
          match: 'exact',
        })
        if (out.count) {
          html = out.html
          changes.push(`swapped ${out.count} literal(s) for token references`)
        }
      }
      /* tapTarget: grow undersized interactive elements to 44px */
      if (wanted.has('tapTarget')) {
        const out = await checkFrame(frame).catch(() => null)
        const tapIssues = out ? out.issues.filter((i) => i.ruleId === 'FC-TAP' && i.elementId) : []
        const ops = tapIssues.map((i) => ({
          op: 'style' as const,
          element: i.elementId!,
          property: 'min-width,min-height',
          value: '44px',
        }))
        /* min-width/min-height as one op each — style takes a single property */
        const flat = tapIssues.flatMap((i) => [
          { op: 'style' as const, element: i.elementId!, property: 'min-width', value: '44px' },
          { op: 'style' as const, element: i.elementId!, property: 'min-height', value: '44px' },
        ])
        void ops
        const edit = dom.applyEditOps(html, flat)
        if (edit.applied) {
          html = edit.html
          changes.push(`grew ${edit.applied / 2} tap target(s) to 44px`)
        }
      }
      /* contrast: move failing text to the nearest token that passes on the same bg */
      if (wanted.has('contrast')) {
        const out = await checkFrame(frame).catch(() => null)
        const issues = out ? out.issues.filter((i) => i.ruleId === 'FC-CONTRAST' && i.elementId && i.detail) : []
        for (const issue of issues.slice(0, 10)) {
          const m = /^(.*) on (.*)$/.exec(issue.detail!)
          if (!m) continue
          const fix = nearestPassingToken(m[1]!, m[2]!, tokens)
          if (!fix) continue
          const edit = dom.applyEditOps(html, [
            { op: 'style', element: issue.elementId!, property: 'color', value: `var(--${fix.replace(/^--/, '')})` },
          ])
          if (edit.applied) {
            html = edit.html
            changes.push(`moved ${issue.selector ?? issue.elementId} text to --${fix} for contrast`)
          }
        }
      }
      if (ctx.dryRun || !changes.length) {
        return { ok: true, changes, review: await reviewOf({ ...frame, html }, ctx.actor, {}) }
      }
      const written = actions.updateFrame(frame.id, { html }, ctx.actor)!
      return { ok: true, changes, review: await reviewOf(written, ctx.actor, {}) }
    },
  },

  /* ---- diazo.search ---- */
  'search.images': {
    fn: async (_ctx, args) => {
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      try {
        const photos = await imageSearch.searchPhotos(str(args[0], 'query'), {
          count: typeof opts.limit === 'number' ? opts.limit : 5,
        })
        return photos.map((p) => ({
          url: p.image_url,
          width: p.width,
          height: p.height,
          alt: p.alt,
          color: p.avg_color,
          credit: p.photographer,
        }))
      } catch (error) {
        throw new SdkError('unavailable', error instanceof Error ? error.message : 'image search failed', 'search')
      }
    },
  },
  'search.icons': {
    fn: async (_ctx, args) => {
      const opts = args[1] === undefined ? {} : obj(args[1], 'opts')
      const icons = await imageSearch.searchIcons(str(args[0], 'query'), {
        limit: typeof opts.limit === 'number' ? opts.limit : 24,
      })
      return icons.map((i) => ({ name: i.id, url: i.svg_url, tags: i.id.split(':') }))
    },
  },
  'search.logos': {
    fn: async (_ctx, args) => {
      try {
        const logos = await imageSearch.searchLogos(str(args[0], 'brand'), 4)
        return logos.map((l) => ({ name: l.name, domain: l.domain, url: l.logo_url }))
      } catch (error) {
        throw new SdkError('unavailable', error instanceof Error ? error.message : 'logo search failed', 'search')
      }
    },
  },
}

let snapshotSeq = 0

function tokenSummary(t: DesignToken): Record<string, unknown> {
  return {
    name: t.name,
    type: t.type,
    value: t.value,
    ...(t.themes && Object.keys(t.themes).length ? { themes: t.themes } : {}),
  }
}

function componentSummary(def: ComponentDef): Record<string, unknown> {
  const props = (def.props ?? []) as ComponentProp[]
  const usage = `<doop-use component="${def.name}"${props.map((p) => ` ${p.name}=…`).join('')} />`
  return { id: def.id, name: def.name, description: def.description, usage }
}

function componentTool(
  ctx: ScriptRunContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ data: unknown }> {
  const canvas = canvasOf(ctx)
  const reader = ctx.userId
  return new Promise((resolve, reject) => {
    const out = runComponentTool(name, input, {
      canvas,
      actor: ctx.actor,
      canRead: (id) => {
        if (id === ctx.canvasId) return true
        const other = store.getCanvas(id)
        return !!reader && !!other && canAccessCanvas(reader, other)
      },
      readableCanvases: () =>
        reader ? canvasesFor(reader).flatMap((meta) => store.getCanvas(meta.id) ?? []) : [canvas],
    })
    if (!out.ok) return reject(invalid(out.error ?? 'the component tool refused'))
    resolve({ data: out.result.data })
  })
}

async function libraryMatches(ctx: ScriptRunContext, brief: string): Promise<unknown[]> {
  const libs = await readableLibraries(ctx.userId ?? '')
  const canvases = libs.map((l) => store.getCanvas(l.id)).filter((c): c is Canvas => !!c)
  const result = await searchLibraries(canvases, { query: brief, limit: 6 })
  return result.hits.map((h) => ({
    itemId: h.item.id,
    libraryId: h.libraryId,
    label: h.item.label,
    category: h.item.category,
  }))
}

/** An item's markup lives in its source frame, addressed by its locator. */
function libraryItemHtml(item: { frameId: string; locator: unknown }): string | null {
  const frame = store.getFrame(item.frameId)
  if (!frame) return null
  const loc = item.locator as { whole?: boolean; elementId?: string; anchor?: string } | undefined
  if (!loc || loc.whole) return frame.html
  if (loc.elementId) {
    const hit = dom.findInHtml(frame.html, `css:[data-doop-id="${loc.elementId}"]`)[0]
    return hit ? dom.outerHtmlAt(frame.html, hit.offset) : null
  }
  if (loc.anchor) {
    const at = frame.html.indexOf(loc.anchor)
    if (at >= 0) return dom.outerHtmlAt(frame.html, at)
  }
  return null
}

/** The token whose colour passes AA on `bg`, closest to `wanted`. */
function nearestPassingToken(wanted: string, bg: string, tokens: readonly DesignToken[]): string | null {
  const wantRgb = cssColorToRgba(wanted)
  let best: { name: string; d: number } | null = null
  for (const token of tokens) {
    const ratio = textContrast(token.value, bg)
    if (ratio === null || ratio < 4.5) continue
    const rgb = cssColorToRgba(token.value)
    const d = wantRgb && rgb ? (rgb.r - wantRgb.r) ** 2 + (rgb.g - wantRgb.g) ** 2 + (rgb.b - wantRgb.b) ** 2 : 0
    if (!best || d < best.d) best = { name: token.name, d }
  }
  return best?.name ?? null
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve one `ns.fn` call. The caller (scriptRunner) has already checked
 * DOOP_AGENT_SCRIPTS; everything else is gated here: role, mode, budgets.
 */
export async function dispatchScriptCall(ctx: ScriptRunContext, path: string, args: unknown[]): Promise<unknown> {
  if (!env.DOOP_AGENT_SCRIPTS) throw new SdkError('refused', 'agent scripts are disabled on this instance')
  if (ctx.active === false) throw new SdkError('limit', 'the run already ended', 'wall')
  if (ctx.dryRun && !ctx.draft) ctx.draft = structuredClone(store.getCanvas(ctx.canvasId))
  const entry = Object.hasOwn(HANDLERS, path) ? HANDLERS[path] : undefined
  if (!entry) throw invalid(`unknown diazo function ${path}`)
  const role = roleOf(ctx)
  if (entry.write) {
    if (!ctx.write) throw denied(`diazo.${path} writes — query_script is read-only`)
    if (!env.AGENT_LIBRARY_WRITES && canvasOf(ctx).library) throw denied('AGENT_LIBRARY_WRITES=false')
    if (!roleAllows(role, 'edit')) throw denied(`diazo.${path} needs edit access on this canvas`)
  } else if (!roleAllows(role, 'view')) {
    throw denied('view access on this canvas is required')
  }
  if (entry.frameWrite) {
    if (ctx.budgets.frameWrites <= 0) throw new SdkError('limit', 'frame_writes limit reached', 'frame_writes')
    ctx.budgets.frameWrites--
  }
  const out = await entry.fn(ctx, args)
  if (entry.write) {
    ctx.writes.push({
      path,
      ...(path === 'frames.create' && out && typeof out === 'object' && 'id' in out
        ? { frameId: String(out.id) }
        : typeof args[0] === 'string'
          ? { frameId: args[0] }
          : {}),
    })
  }
  return out
}

/** The catalogue `get_sdk_docs` serves: which paths exist and which write. */
export function sdkPaths(): { path: string; write: boolean }[] {
  return Object.entries(HANDLERS).map(([path, e]) => ({ path, write: !!e.write }))
}
