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
import { applyCompositionOps, parseOps, buildStoryboard, newComposition, type Composition } from '../shared/motion.ts'
import { frameStateAt } from '../shared/motionRuntime.ts'
import { lintFrame } from './lint.ts'
import { checkFrame } from './frameChecks.ts'
import { textContrast } from '../shared/frameChecks.ts'
import { cssColorToRgba } from '../shared/slopRules.ts'
import { loadFramePage, renderFrame, rendererAvailable } from './screenshot.ts'
import { pixelScore } from './driftDiff.ts'
import { itemDetail, libraryFor, readableLibraries, searchLibraries } from './libraryQueries.ts'
import { libraryItems } from './libraryIndex.ts'
import { runComponentTool } from './componentTools.ts'
import { findComponent, componentDetail } from './componentActions.ts'
import * as motion from './motionTools.ts'
import * as dom from './scriptDom.ts'
import { canonicalJson } from '../shared/canonicalJson.ts'
import { scriptUndoProjection } from './actions.ts'
import type { ScriptEntityUndo } from '../shared/scriptRuns.ts'
import { SCRIPT_LIMITS } from './scriptSandbox.ts'
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
  checks?: Record<string, unknown>
  /** per-entity undo payloads the run accumulates, keyed `kind:id` — only
   *  entities the run changed, never a canvas snapshot */
  undo?: Map<string, ScriptEntityUndo>
  /** frames whose html the run changed — they get one rendered review each
   *  after the run, outside its wall budget */
  changedFrames?: Set<string>
}

/** key -> projected undo copy of one entity */
type UndoSnapshot = Map<string, unknown>

const UNDO_KINDS: readonly { kind: ScriptEntityUndo['kind']; entries: (c: Canvas) => [string, unknown][] }[] = [
  { kind: 'frame', entries: (c) => c.frames.map((f) => [f.id, f]) },
  { kind: 'token', entries: (c) => (c.tokens ?? []).map((t) => [t.name, t]) },
  { kind: 'component', entries: (c) => (c.components ?? []).map((v) => [v.id, v]) },
  { kind: 'composition', entries: (c) => (c.compositions ?? []).map((v) => [v.pageId, v]) },
]

const undoKey = (kind: ScriptEntityUndo['kind'], id: string) => `${kind}:${id}`

/** A restorable copy of one entity. Scalars and strings — a frame's html is
 *  the common payload — stay shared references, which is free and safe
 *  (strings are immutable); only nested objects are cloned, since a mutator
 *  could reach into one without replacing the field. */
function undoCopy(kind: ScriptEntityUndo['kind'], entity: unknown): unknown {
  const projected = scriptUndoProjection(kind, entity)
  if (projected === null || typeof projected !== 'object') return projected
  /* an array copied through Object.entries comes back an object — it would
     never equal the live value under canonical JSON again */
  if (Array.isArray(projected)) return structuredClone(projected)
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(projected as Record<string, unknown>)) {
    copy[key] = value !== null && typeof value === 'object' ? structuredClone(value) : value
  }
  return copy
}

/** Two snapshots of the same entity, without serialising first. Fields
 *  compare by identity; only object fields (token themes, component props)
 *  fall back to canonical JSON. */
function sameEntity(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (Object.is(av, bv)) continue
    if (av !== null && bv !== null && typeof av === 'object' && typeof bv === 'object') {
      if (canonicalJson(av) === canonicalJson(bv)) continue
    }
    return false
  }
  return true
}

function undoSnapshot(canvas: Canvas): UndoSnapshot {
  const snap: UndoSnapshot = new Map()
  for (const { kind, entries } of UNDO_KINDS)
    for (const [id, entity] of entries(canvas)) {
      const copy = undoCopy(kind, entity)
      if (copy !== undefined) snap.set(undoKey(kind, id), copy)
    }
  const themes = undoCopy('tokenThemes', canvas.tokenThemes)
  if (themes !== undefined) snap.set('tokenThemes:', themes)
  return snap
}

/** Fold the entities this mutate changed into the run's undo map: `before`
 *  is captured the first time an entity moves, `after` always lands on the
 *  latest state, and an entity that returns to its original value stays
 *  recorded (the runner drops the no-op entries before persisting). */
function undoDiff(ctx: ScriptRunContext, snap: UndoSnapshot, canvas: Canvas): void {
  const cur = undoSnapshot(canvas)
  ctx.undo ??= new Map()
  for (const key of new Set([...snap.keys(), ...cur.keys()])) {
    const prev = snap.get(key)
    const next = cur.get(key)
    if (sameEntity(prev, next)) continue
    const cut = key.indexOf(':')
    const kind = key.slice(0, cut) as ScriptEntityUndo['kind']
    const id = key.slice(cut + 1)
    let entry = ctx.undo.get(key)
    if (!entry) {
      entry = { kind, id, ...(prev === undefined ? {} : { before: prev }) }
      ctx.undo.set(key, entry)
    }
    if (next === undefined) delete entry.after
    else entry.after = next
  }
}

/** Capture only synchronous mutations performed by this run. Awaiting a
 * renderer or library lookup never claims a collaborator's unrelated edits. */
function mutate<T>(ctx: ScriptRunContext, fn: () => T): T {
  if (ctx.active === false) throw new SdkError('limit', 'wall limit reached', 'wall')
  const snap = undoSnapshot(store.getCanvas(ctx.canvasId)!)
  const value = fn()
  undoDiff(ctx, snap, store.getCanvas(ctx.canvasId)!)
  return value
}

/** The entity of one undo kind currently on the canvas, or undefined. */
function entityOn(canvas: Canvas, kind: ScriptEntityUndo['kind'], id: string): unknown {
  switch (kind) {
    case 'frame':
      return canvas.frames.find((f) => f.id === id)
    case 'token':
      return (canvas.tokens ?? []).find((t) => t.name === id)
    case 'component':
      return (canvas.components ?? []).find((c) => c.id === id)
    case 'composition':
      return (canvas.compositions ?? []).find((c) => c.pageId === id)
  }
}

/** The motion write tools await inside the call — frame html loads lazily and
 *  element stamps land after — so a whole-canvas diff would claim whatever a
 *  collaborator changed during the wait. Instead the operation reports each
 *  entity it synchronously wrote through `journal`; before-images come from
 *  the snapshot taken up front, after-images are read at the write. */
async function mutateAsync<T>(
  ctx: ScriptRunContext,
  fn: (journal: (kind: 'frame' | 'composition', id: string) => void) => Promise<T>,
): Promise<T> {
  if (ctx.active === false) throw new SdkError('limit', 'wall limit reached', 'wall')
  await store.load(ctx.canvasId)
  const snap = undoSnapshot(store.getCanvas(ctx.canvasId)!)
  ctx.undo ??= new Map()
  const journal = (kind: 'frame' | 'composition', id: string) => {
    const canvas = store.getCanvas(ctx.canvasId)
    if (!canvas) return
    const key = undoKey(kind, id)
    const after = undoCopy(kind, entityOn(canvas, kind, id))
    let entry = ctx.undo!.get(key)
    if (!entry) {
      entry = { kind, id, ...(snap.has(key) ? { before: snap.get(key) } : {}) }
      ctx.undo!.set(key, entry)
    }
    if (after === undefined) delete entry.after
    else entry.after = after
  }
  return fn(journal)
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
    /* script runs are offline workloads: a check may serve the server's
       own assets but must never reach the network on a script's behalf */
    const checks = await checkFrame(frame, 'interactive', { offline: true })
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
    viewports: c.viewports.map((v) => ({
      width: v.width,
      overflowPx: v.overflowPx,
      clippedText: c.issues.filter((i) => i.ruleId === 'FC-CLIP' && i.widths.includes(v.width)).length,
      tapTargets: c.issues.filter((i) => i.ruleId === 'FC-TAP' && i.widths.includes(v.width)).length,
    })),
    focus: c.focus,
  }
}

/** The layout numbers a screenshot would only show a person. */
async function measureOf(frame: Frame): Promise<Record<string, unknown>> {
  const consoleErrors: string[] = []
  const loaded = await loadFramePage(frame, {
    priority: 'interactive',
    offline: true,
    onConsole: (type, text) => {
      if (type === 'error' && consoleErrors.length < 20) consoleErrors.push(text.slice(0, 200))
    },
  })
  try {
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
        const sibs = [...document.querySelectorAll('body *')].slice(0, 300)
        for (let i = 0; i < Math.min(sibs.length, 60); i++) {
          const a = sibs[i].getBoundingClientRect()
          for (let j = i + 1; j < Math.min(sibs.length, 60); j++) {
            if (sibs[i].parentElement !== sibs[j].parentElement) continue; const b = sibs[j].getBoundingClientRect()
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            if (ox > 4 && oy > 4 && overlaps.length < 20) overlaps.push({ a: sibs[i].tagName.toLowerCase(), b: sibs[j].tagName.toLowerCase(), px: Math.round(Math.min(ox, oy)) })
          }
        }
        const brokenImages = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => ({ src: String(i.src).slice(0, 200) })).slice(0, 20)
        const asked = new Set()
        for (const el of all) { const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim(); if (f) asked.add(f) }
        /* document.fonts only knows @font-face families — system fonts would
           all read as missing. Width-probe instead: a family that resolves
           renders its own glyphs, so '32px "F", serif' measures differently
           from '32px serif'; a missing family falls through and matches the
           baseline. Three baselines keep monospace-metric fonts honest. */
        const GENERIC = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','emoji','math','fangsong','inherit','initial','unset'])
        const fallbackFonts = []
        const probe = document.createElement('canvas').getContext('2d')
        if (probe) {
          const SAMPLE = 'mmmmmmmmmmlliWWW1234567890'
          const base = {}
          for (const g of ['monospace','serif','sans-serif']) { probe.font = '32px ' + g; base[g] = probe.measureText(SAMPLE).width }
          for (const f of asked) {
            if (fallbackFonts.length >= 20) break
            if (GENERIC.has(f.toLowerCase())) continue
            let resolved = false
            for (const g of ['monospace','serif','sans-serif']) {
              probe.font = '32px "' + f.replace(/"/g, '') + '", ' + g
              if (Math.abs(probe.measureText(SAMPLE).width - base[g]) > 0.5) { resolved = true; break }
            }
            if (!resolved) fallbackFonts.push(f)
          }
        }
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

function stateAt(comp: Composition, canvas: Canvas, t: number): Record<string, unknown> {
  const sampled = frameStateAt(comp, t)
  const elements = Object.entries(sampled.elements).map(([key, properties]) => ({ key, ...properties })) as Record<
    string,
    unknown
  >[]
  const camera = sampled.camera
  const activeClips = sampled.activeClips
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
    camera,
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
/** A guest-supplied result count, pinned to a sane page size. */
const clampLimit = (v: unknown, dflt: number, max: number): number =>
  typeof v === 'number' ? Math.max(1, Math.min(Math.floor(v), max)) : dflt

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
      const frame = mutate(ctx, () =>
        actions.createFrame(
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
        ),
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
        const out = mutate(ctx, () =>
          actions.appendFrameHtml(frame.id, chunks[i]!, ctx.actor, {
            start: i === 0,
            done: i === chunks.length - 1,
          }),
        )
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
      if (ops.length > SCRIPT_LIMITS.editOps)
        throw new SdkError('limit', `frames.edit takes at most ${SCRIPT_LIMITS.editOps} operations`, 'ops')
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
      const written = mutate(ctx, () => actions.updateFrame(frame.id, { html: result.html }, ctx.actor))
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
      const written = mutate(ctx, () => actions.updateFrame(frame.id, { html: result.html }, ctx.actor))!
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
      if (Object.keys(meta).length)
        mutate(ctx, () => updateFrameMeta(canvasOf(ctx), frame.id, meta as never, ctx.actor))
      const box: Record<string, number> = {}
      for (const key of ['x', 'y', 'width', 'height']) if (key in patch) box[key] = num(patch[key], key)
      if (Object.keys(box).length) mutate(ctx, () => actions.updateFrame(frame.id, box, ctx.actor))
      return refOf(store.getFrame(frame.id)!)
    },
  },

  /* ---- diazo.tokens ---- */
  'tokens.get': {
    fn: async (ctx, args) => {
      const opts = args[0] === undefined ? {} : obj(args[0], 'opts')
      let tokens = canvasOf(ctx).tokens ?? []
      if (Array.isArray(opts.types)) tokens = tokens.filter((t) => (opts.types as string[]).includes(t.type))
      if (typeof opts.namePattern === 'string' && opts.namePattern) {
        const match = nameMatcher(opts.namePattern)
        tokens = tokens.filter((t) => match(t.name))
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
      const results = mutate(ctx, () => actions.createTokens(ctx.canvasId, inputs, ctx.actor))
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
      const results = mutate(ctx, () => actions.setTokens(ctx.canvasId, [edit as never], ctx.actor))
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
      const out = mutate(ctx, () => actions.setTokenThemes(ctx.canvasId, themes, ctx.actor))
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
      const def = ctx.draft
        ? ctx.draft.components?.find((c) => c.id === args[0] || c.name === args[0])
        : findComponent(ctx.canvasId, str(args[0], 'componentId'))
      if (!def) throw notFound(`no component ${String(args[0])}`)
      return componentDetail(canvasOf(ctx), def)
    },
  },
  'components.create': {
    write: true,
    fn: async (ctx, args) => {
      const input = obj(args[0], 'input')
      if (ctx.dryRun) {
        const def = {
          ...input,
          id: randomUUID(),
          template: str(input.template, 'template'),
          name: str(input.name, 'name'),
          css: input.css ?? '',
          props: input.props ?? [],
          slots: input.slots ?? [],
          rev: 1,
        } as ComponentDef
        ;(canvasOf(ctx).components ??= []).push(def)
        return componentSummary(def)
      }
      const out = await componentTool(ctx, 'create_component', {
        name: input.name,
        description: input.description ?? '',
        html: input.template,
        css: input.css,
        props: input.props,
        slots: input.slots,
      })
      return (out.data as { component: unknown }).component
    },
  },
  'components.update': {
    write: true,
    fn: async (ctx, args) => {
      const component = str(args[0], 'componentId')
      const patch = obj(args[1], 'patch')
      if (ctx.dryRun) {
        const def = canvasOf(ctx).components?.find((c) => c.id === component || c.name === component)
        if (!def) throw notFound('no component')
        for (const key of ['name', 'description', 'template', 'css', 'props', 'slots'])
          if (key in patch) Object.assign(def, { [key]: patch[key] })
        return componentSummary(def)
      }
      const out = await componentTool(ctx, 'update_component', {
        ...Object.fromEntries(
          Object.entries(patch).filter(([k]) => ['name', 'description', 'css', 'props'].includes(k)),
        ),
        ...(typeof patch.template === 'string' ? { html: patch.template } : {}),
        component,
      })
      return (out.data as { component: unknown }).component
    },
  },
  'components.insert': {
    write: true,
    frameWrite: true,
    fn: async (ctx, args) => {
      const frame = frameOf(ctx, str(args[0], 'frameId'))
      const componentId = str(args[1], 'componentId')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      if (ctx.dryRun) {
        const def = canvasOf(ctx).components?.find((c) => c.id === componentId || c.name === componentId)
        if (!def) throw notFound('no component on this canvas')
        const edit = dom.applyEditOps(frame.html, [
          { op: 'insert', element: '', html: `<doop-use component="${def.id}"></doop-use>` },
        ])
        frame.html = edit.html
        return { ok: true, applied: edit.applied }
      }
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
      const result = await searchLibraries(canvases, {
        query,
        limit: clampLimit(opts.limit, 12, 60),
      })
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
          throw new SdkError(
            'failed',
            `the item could not be inserted: ${result.failed[0]?.reason ?? 'no insertion point'}`,
          )
        const written = mutate(ctx, () => actions.updateFrame(frame.id, { html: result.html }, ctx.actor))!
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
      const draft = ctx.draft?.compositions?.find((c) => c.pageId === args[0])
      const out = draft
        ? { ok: true as const, data: draft }
        : motion.getCompositionData(canvasOf(ctx), str(args[0], 'pageId'))
      if (!out.ok) return null
      return out.data
    },
  },
  'compositions.stateAt': {
    fn: async (ctx, args) => {
      const draft = ctx.draft?.compositions?.find((c) => c.pageId === args[0])
      const out = draft
        ? { ok: true as const, data: draft }
        : motion.getCompositionData(canvasOf(ctx), str(args[0], 'pageId'))
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
      if (ctx.dryRun) {
        if (!canvasPages(canvasOf(ctx)).some((p) => p.id === pageId)) throw notFound('page is not on this canvas')
        const { body, shots } = buildStoryboard({
          frames: canvasOf(ctx).frames.filter(
            (f) =>
              (!f.pageId || f.pageId === pageId) && (!Array.isArray(opts.frameIds) || opts.frameIds.includes(f.id)),
          ),
          shotSeconds: Number(opts.shotSeconds ?? 3),
          width: Number(opts.width ?? 1920),
          height: Number(opts.height ?? 1080),
          fps: Number(opts.fps ?? 30),
        })
        const comp = newComposition({
          body,
          canvasId: ctx.canvasId,
          pageId,
          updatedBy: ctx.actor.name,
          now: Date.now(),
        })
        const canvas = canvasOf(ctx)
        canvas.compositions = [...(canvas.compositions ?? []).filter((c) => c.pageId !== pageId), comp]
        return { ok: true, revision: comp.revision, shots: shots.length }
      }
      const out = await mutateAsync(ctx, (journal) =>
        motion.animateStoryboard(
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
          journal,
        ),
      )
      if (!out.ok) throw invalid(String(out.error))
      const v = out.data as { revision?: number; shots?: unknown[] }
      return { ok: true, revision: v.revision ?? 0, shots: v.shots?.length ?? 0 }
    },
  },
  'compositions.patch': {
    write: true,
    fn: async (ctx, args) => {
      const pageId = str(args[0], 'pageId')
      const ops = args[1]
      if (!Array.isArray(ops)) throw invalid('ops must be an array')
      const opts = args[2] === undefined ? {} : obj(args[2], 'opts')
      if (ctx.dryRun) {
        const comp = canvasOf(ctx).compositions?.find((c) => c.pageId === pageId)
        if (!comp) throw notFound('page has no composition')
        if (opts.expectedRevision !== undefined && opts.expectedRevision !== comp.revision)
          throw new SdkError('conflict', 'composition revision changed')
        const parsed = parseOps(ops, comp.duration)
        if (!parsed.ok) throw invalid(parsed.error)
        const applied = applyCompositionOps(comp, parsed.value)
        if (!applied.ok) throw invalid(applied.error)
        Object.assign(comp, applied.value, { revision: comp.revision + 1 })
        return { ok: true, revision: comp.revision }
      }
      const out = await mutateAsync(ctx, (journal) =>
        motion.setCompositionData(
          canvasOf(ctx),
          pageId,
          { ops, ...(opts.expectedRevision !== undefined ? { expected_revision: opts.expectedRevision } : {}) },
          ctx.actor,
          journal,
        ),
      )
      if (!out.ok) throw invalid(String(out.error))
      return { ok: true, revision: (out.data as { revision: number }).revision }
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
      const out = await checkFrame(frame, 'interactive', { offline: true })
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
      const png = await renderFrame(frame, 1, { offline: true })
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
      const png = await renderFrame(frame, 1, { offline: true })
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
        const out = await checkFrame(frame, 'interactive', { offline: true }).catch(() => null)
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
        const out = await checkFrame(frame, 'interactive', { offline: true }).catch(() => null)
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
        if (ctx.dryRun) frame.html = html
        return { ok: true, changes, review: await reviewOf({ ...frame, html }, ctx.actor, {}) }
      }
      if (ctx.active === false) throw new SdkError('limit', 'wall limit reached', 'wall')
      const written = mutate(ctx, () => actions.updateFrame(frame.id, { html }, ctx.actor))!
      return { ok: true, changes, review: await reviewOf(written, ctx.actor, {}) }
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
    const out = mutate(ctx, () =>
      runComponentTool(name, input, {
        canvas,
        actor: ctx.actor,
        canRead: (id) => {
          if (id === ctx.canvasId) return true
          const other = store.getCanvas(id)
          return !!reader && !!other && canAccessCanvas(reader, other)
        },
        readableCanvases: () =>
          reader ? canvasesFor(reader).flatMap((meta) => store.getCanvas(meta.id) ?? []) : [canvas],
      }),
    )
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
  /* host-side bound on what one call may carry — a guest with no size check
   *  could otherwise push unbounded payloads through the bridge */
  let argsBytes = 0
  for (const arg of args) {
    argsBytes += typeof arg === 'string' ? arg.length : (JSON.stringify(arg)?.length ?? 0)
    if (argsBytes > SCRIPT_LIMITS.argsBytes)
      throw new SdkError(
        'limit',
        `call arguments exceed ${Math.round(SCRIPT_LIMITS.argsBytes / 1024)} KB`,
        'args_bytes',
      )
  }
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
  const beforeHtml = entry.write ? new Map(canvasOf(ctx).frames.map((f) => [f.id, f.html])) : new Map<string, string>()
  const out = await entry.fn(ctx, args)
  if (entry.write) {
    for (const frame of canvasOf(ctx).frames) {
      if (beforeHtml.get(frame.id) === frame.html) continue
      /* rendered review is deferred to finishScriptReviews — one pass per
         changed frame, after the run, outside its wall budget */
      ;(ctx.changedFrames ??= new Set()).add(frame.id)
      if (!(ctx.checks ??= {})[frame.id]) {
        const review = await reviewOf(frame, ctx.actor, {})
        ctx.checks[frame.id] = review
        if (out && typeof out === 'object' && !('review' in out)) Object.assign(out, { review })
      }
    }
  }
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

/**
 * The one rendered pass per frame a run touched. The runner calls this after
 * the guest's wall clock stopped, so renders never eat script budget — and
 * a frame edited ten times is reviewed once, not ten times. Lint-level
 * reviews collected during the run survive for frames the renderer misses.
 */
export async function finishScriptReviews(ctx: ScriptRunContext): Promise<Record<string, unknown>> {
  const checks = ctx.checks ?? {}
  if (ctx.dryRun || !rendererAvailable()) return checks
  for (const id of ctx.changedFrames ?? []) {
    const frame = store.getFrame(id)
    if (!frame || frame.canvasId !== ctx.canvasId) continue
    try {
      checks[id] = await reviewOf(frame, ctx.actor, { render: true })
    } catch {
      checks[id] ??= { ok: false, error: 'the rendered review failed' }
    }
  }
  return checks
}

/** A script-supplied name filter: a case-insensitive substring, or a glob
 *  when the pattern holds a `*` (any run of characters, whole-name match).
 *  No guest input ever reaches the regex engine — a pathological pattern
 *  costs an indexOf, never exponential backtracking. */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const needle = pattern.toLowerCase()
  if (!needle.includes('*')) return (name) => name.toLowerCase().includes(needle)
  const parts = needle.split('*')
  return (name) => {
    const hay = name.toLowerCase()
    let at = 0
    for (const [i, part] of parts.entries()) {
      if (!part) continue
      const found = hay.indexOf(part, at)
      /* the first literal anchors the match at the name's start */
      if (found < 0 || (i === 0 && found !== 0)) return false
      at = found + part.length
    }
    /* a non-empty last literal anchors at the end */
    const last = parts[parts.length - 1]!
    return last === '' || hay.endsWith(last)
  }
}

/** The catalogue `get_sdk_docs` serves: which paths exist and which write. */
export function sdkPaths(): { path: string; write: boolean }[] {
  return Object.entries(HANDLERS).map(([path, e]) => ({ path, write: !!e.write }))
}
