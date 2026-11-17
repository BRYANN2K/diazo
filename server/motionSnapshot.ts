/**
 * server/motionSnapshot.ts — how the agent sees its film (motion-pro P0).
 *
 * `get_scene_snapshot` drives the real render harness
 * (`/c/<id>/motion-render`) through the renderer gate: seeks to the asked
 * times, draws a labelled contact sheet in-page and brings back the PNG
 * plus the stats each cell carried. `check_scene` adds the structure pass
 * (the same lint lint_motion runs) to pacing, safe-zone, legibility and
 * effect-cost numbers — the machine half of the director's rubric —
 * and `critique_scene` packages the rubric with a bounded pass budget.
 *
 * One browser pass serves all three: `driveHarness` opens the page once
 * and evaluates `__doopMotionSheet` / `__doopMotionMeasure` against it.
 */

import { env } from './env.ts'
import { openIsolatedPage, rendererAvailable } from './screenshot.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { mintRenderToken, renderCookieName, revokeRenderToken } from './motionRender.ts'
import { lintComposition, lintMotionHtml, motionLintSummary } from '../shared/motionLint.ts'
import { frameStateAt } from '../shared/motionRuntime.ts'
import { effectCost, effectSpec } from '../shared/motionFx.ts'
import { CRITIQUE_PASS_DEFAULT, CRITIQUE_PASS_MAX, type Composition, type MotionLintIssue } from '../shared/motion.ts'
import { store } from './store.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }
const ok = <T>(data: T) => ({ ok: true as const, data })
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const HARNESS_READY_MS = 60_000
const SHEET_BUDGET_MS = 120_000

export interface SheetCell {
  t: number
  x: number
  y: number
  w: number
  h: number
  mean: number
  stddev: number
}

export interface SheetResult {
  png: string
  width: number
  height: number
  cells: SheetCell[]
  motionEnergy: number[]
}

export interface TextBox {
  frameId: string
  elementId: string
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  fontWeight: string
  color: string
  background: string
  text: string
}

/** drive the harness once: the sheet at `times` and/or the text measure.
 *  Undefined when the renderer is unavailable — callers degrade to the
 *  structure-only report rather than fail. */
async function driveHarness(
  comp: Composition,
  opts: { times?: number[]; columns?: number; maxSide?: number; measure?: boolean },
): Promise<{ sheet?: SheetResult; boxes?: TextBox[] } | { error: string }> {
  if (!rendererAvailable()) return { error: 'no renderer on this instance' }
  const budget = SHEET_BUDGET_MS
  const token = mintRenderToken({ canvasId: comp.canvasId, pageId: comp.pageId }, budget)
  const iso = await openIsolatedPage({ priority: 'background', leaseMs: budget })
  try {
    const page = iso.page
    const origin = env.BETTER_AUTH_URL
    await guardPublicPageRequests(page, {
      allowUrl: (u) =>
        u.origin === origin || u.origin === 'https://fonts.googleapis.com' || u.origin === 'https://fonts.gstatic.com',
    })
    await page.setCookie({
      name: renderCookieName(),
      value: token,
      url: origin,
      path: '/',
      httpOnly: true,
      secure: origin.startsWith('https:'),
      sameSite: 'Strict',
      expires: Math.floor((Date.now() + budget) / 1000),
    })
    await page.setViewport({ width: comp.width, height: comp.height })
    await page.goto(`${origin}/c/${comp.canvasId}/motion-render?page=${comp.pageId}&start=0`, {
      waitUntil: 'networkidle0',
      timeout: HARNESS_READY_MS,
    })
    await page.waitForFunction('typeof window.__doopMotionSeek === "function"', { timeout: HARNESS_READY_MS })
    const ready = await page.evaluate(
      `Promise.race([window.__doopMotionReady.then(() => 'ready'), new Promise((r) => setTimeout(() => r('stalled'), ${HARNESS_READY_MS}))])`,
    )
    if (ready !== 'ready') return { error: 'the render harness did not become ready' }
    const out: { sheet?: SheetResult; boxes?: TextBox[] } = {}
    if (opts.times?.length) {
      out.sheet = (await page.evaluate(
        `window.__doopMotionSheet(${JSON.stringify({ times: opts.times, columns: opts.columns, maxSide: opts.maxSide })})`,
      )) as SheetResult
    }
    if (opts.measure) {
      out.boxes = (await page.evaluate('window.__doopMotionMeasure()')) as TextBox[]
    }
    return out
  } finally {
    revokeRenderToken(token)
    await iso.close()
  }
}

/* the times a `auto:'beats'` snapshot shows: shot midpoints between camera
   keyframe boundaries, clamped to a dozen cells */
export function beatTimes(comp: Composition, max = 12): number[] {
  const camera = comp.tracks.find((t) => t.kind === 'camera')
  const times = [...new Set((camera?.keyframes ?? []).map((k) => k.t))].sort((a, b) => a - b)
  const bounds = [0, ...times.filter((t) => t > 0 && t < comp.duration), comp.duration]
  const midpoints: number[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    midpoints.push((bounds[i]! + bounds[i + 1]!) / 2)
  }
  const cells = midpoints.length ? midpoints : [0]
  return cells.slice(0, max)
}

/** get_scene_snapshot: the contact sheet the agent looks at. */
export async function sceneSnapshot(
  canvas: Canvas,
  pageId: string,
  input: { times?: number[]; auto?: string; max_side?: number; columns?: number },
): Promise<Outcome> {
  if (!canvasPages(canvas).some((p) => p.id === pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to show`)
  const times =
    input.times?.length && input.times.every((t) => Number.isFinite(t) && t >= 0 && t <= comp.duration)
      ? input.times.slice(0, 24)
      : beatTimes(comp)
  const driven = await driveHarness(comp, {
    times,
    columns: input.columns,
    maxSide: input.max_side,
    measure: true,
  })
  if ('error' in driven) return fail(`snapshot needs the renderer — ${driven.error}`)
  const sheet = driven.sheet!
  return ok({
    times,
    sheet: { width: sheet.width, height: sheet.height, bytes: Math.round((sheet.png.length * 3) / 4) },
    cells: sheet.cells.map((c) => ({ t: c.t, mean_luminance: c.mean, contrast_stddev: c.stddev })),
    motion_energy: sheet.motionEnergy,
    text_boxes: (driven.boxes ?? []).map((b) => ({
      frame_id: b.frameId,
      element_id: b.elementId,
      rect: { x: b.x, y: b.y, w: b.w, h: b.h },
      font_px: b.fontSize,
    })),
    png: sheet.png,
  })
}

/* ---- check_scene ---- */

/** the film's shot structure from the camera track: boundary times →
 *  segments, for pacing stats and dead-beat spotting */
function shotsOf(comp: Composition): { t: number; duration: number }[] {
  const camera = comp.tracks.find((t) => t.kind === 'camera')
  const bounds = [...new Set((camera?.keyframes ?? []).map((k) => k.t))]
    .filter((t) => t >= 0 && t < comp.duration)
    .sort((a, b) => a - b)
  const edges = [0, ...bounds.filter((t) => t > 0), comp.duration]
  const out: { t: number; duration: number }[] = []
  for (let i = 0; i + 1 < edges.length; i++) out.push({ t: edges[i]!, duration: edges[i + 1]! - edges[i]! })
  return out
}

/** element/clip motion inside [t, t+d) — the "is anything alive" signal a
 *  dead beat checks */
function hasMotionInside(comp: Composition, t: number, d: number): boolean {
  const end = t + d
  for (const track of comp.tracks) {
    for (const kf of track.keyframes ?? []) if (kf.t > t && kf.t < end) return true
    for (const clip of track.clips ?? []) {
      if (clip.start < end && clip.start + clip.duration > t && clip.source.type !== 'adjustment') return true
    }
  }
  return false
}

/** a measured text box at shot time: world rect → output rect through the
 *  camera — the safe-zone and legibility checks' shared projection */
function boxAt(
  box: TextBox,
  frame: { x: number; y: number },
  camera: { x: number; y: number; zoom: number },
  out: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: (frame.x + box.x - camera.x) * camera.zoom + out.width / 2,
    y: (frame.y + box.y - camera.y) * camera.zoom + out.height / 2,
    w: box.w * camera.zoom,
    h: box.h * camera.zoom,
  }
}

const ACTION_SAFE = 0.05 /* broadcast convention: keep action inside 90% */
const TITLE_SAFE = 0.1 /* and titles inside 80% */
const MIN_TEXT_PX = 14 /* an effective text height under this reads small */

export async function checkScene(canvas: Canvas, pageId: string, input: { pixels?: boolean }): Promise<Outcome> {
  if (!canvasPages(canvas).some((p) => p.id === pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to check`)

  /* 1 — the same lint lint_motion runs */
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frames = pageFrames(loaded, pageId)
  const frameIds = new Set(frames.map((f) => f.id))
  const issues: MotionLintIssue[] = [...lintComposition(comp, { frameIds })]
  for (const frame of frames) issues.push(...lintMotionHtml(frame.html, frame.id))

  /* 2 — pacing from the camera shots */
  const shots = shotsOf(comp)
  const durations = shots.map((s) => s.duration)
  const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
  const deadBeats = shots.filter((s) => s.duration > 1.5 && !hasMotionInside(comp, s.t, s.duration))
  const pacing = {
    shots: shots.length,
    shot_seconds: {
      min: durations.length ? Math.min(...durations) : 0,
      max: durations.length ? Math.max(...durations) : 0,
      mean,
      variance: durations.length ? durations.reduce((a, b) => a + (b - mean) * (b - mean), 0) / durations.length : 0,
    },
    dead_beats: deadBeats.map((s) => ({ t: s.t, duration: s.duration })),
  }

  /* 3 — the effect bill, per track and in total */
  const perTrack = comp.tracks
    .map((track) => ({
      track_id: track.id,
      kind: track.kind,
      effects: (track.effects ?? []).map((e) => e.fx),
      cost: effectCost(track),
    }))
    .filter((t) => t.effects.length > 0 || t.kind === 'adjustment')
  const totalCost = perTrack.reduce((a, t) => a + t.cost, 0)
  const unsupported = new Set<string>()
  for (const track of comp.tracks) for (const e of track.effects ?? []) if (!effectSpec(e.fx)) unsupported.add(e.fx)
  const effects = {
    per_track: perTrack,
    total_cost: totalCost,
    /* the preview budget: 6 layers × 3 effects of average cost 2 ≈ 36 —
       over it, check reports over_budget */
    over_budget: totalCost > 36,
    unsupported: [...unsupported],
  }

  /* 4 — safe zones + legibility need measured text: the harness measure
     pass when the renderer is up, reported unavailable otherwise */
  let legibility: unknown = { available: false, reason: 'no renderer on this instance' }
  let safeZones: unknown = { available: false, reason: 'no renderer on this instance' }
  if (input.pixels !== false && rendererAvailable()) {
    const driven = await driveHarness(comp, { measure: true })
    if (!('error' in driven) && driven.boxes) {
      const frameById = new Map(frames.map((f) => [f.id, f]))
      const legItems: unknown[] = []
      const violations: unknown[] = []
      for (const shot of shots.length ? shots : [{ t: 0, duration: comp.duration }]) {
        const state = frameStateAt(comp, shot.t + shot.duration / 2)
        const camera = state.camera ?? { x: 0, y: 0, zoom: 1, rotation: 0 }
        for (const box of driven.boxes) {
          const frame = frameById.get(box.frameId)
          if (!frame) continue
          const rect = boxAt(box, frame, camera, comp)
          const cx = rect.x + rect.w / 2
          const cy = rect.y + rect.h / 2
          const inTitleSafe =
            cx > comp.width * TITLE_SAFE &&
            cx < comp.width * (1 - TITLE_SAFE) &&
            cy > comp.height * TITLE_SAFE &&
            cy < comp.height * (1 - TITLE_SAFE)
          const inActionSafe =
            cx > comp.width * ACTION_SAFE &&
            cx < comp.width * (1 - ACTION_SAFE) &&
            cy > comp.height * ACTION_SAFE &&
            cy < comp.height * (1 - ACTION_SAFE)
          if (!inTitleSafe) {
            violations.push({
              element_id: box.elementId,
              frame_id: box.frameId,
              t: shot.t,
              zone: inActionSafe ? 'title' : 'action',
              edge: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
            })
          }
          const effPx = box.fontSize * camera.zoom
          legItems.push({
            element_id: box.elementId,
            frame_id: box.frameId,
            t: shot.t,
            font_px_effective: Math.round(effPx * 10) / 10,
            under_minimum: effPx < MIN_TEXT_PX,
            small: effPx < MIN_TEXT_PX * 1.4,
          })
        }
      }
      legibility = {
        available: true,
        min_effective_px: MIN_TEXT_PX,
        elements: legItems,
        under_minimum: legItems.filter((i) => (i as { under_minimum: boolean }).under_minimum).length,
      }
      safeZones = {
        available: true,
        action_safe: ACTION_SAFE,
        title_safe: TITLE_SAFE,
        violations,
      }
    }
  }

  return ok({
    page_id: pageId,
    composition_id: comp.id,
    lint: { ...motionLintSummary(issues), issues },
    pacing,
    safe_zones: safeZones,
    legibility,
    effects,
  })
}

/* ---- critique_scene ---- */

/** the rubric the agent grades against — fixed, machine-readable */
const RUBRIC = [
  'intent_coverage',
  'hierarchy',
  'legibility',
  'pacing',
  'motion_quality',
  'continuity',
  'polish',
  'brand',
] as const

interface CritiqueState {
  /* compositionId → the revisions already critiqued; a pass is a new
     revision seen, so re-critiquing an unchanged film does not burn one */
  revisions: Set<number>
}
const critiques = new Map<string, CritiqueState>()

/** critique_scene: the check's numbers folded into the rubric, plus the
 *  pass budget — `direction.passes` (default 3, hard max 5). A call on a
 *  new revision is a pass; the same revision again is free. */
export async function critiqueScene(canvas: Canvas, pageId: string, input: { pixels?: boolean }): Promise<Outcome> {
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to critique`)
  const checked = await checkScene(canvas, pageId, input)
  if (!checked.ok) return checked
  const report = checked.data as {
    lint: { errors: number; warnings: number }
    pacing: { dead_beats: { t: number }[]; shot_seconds: { min: number; max: number; variance: number } }
    legibility: { available?: boolean; under_minimum?: number }
    safe_zones: { available?: boolean; violations?: unknown[] }
    effects: { over_budget: boolean; unsupported: string[] }
  }

  const key = `${canvas.id}/${pageId}/${comp.id}`
  let state = critiques.get(key)
  if (!state) critiques.set(key, (state = { revisions: new Set() }))
  const maxPasses = Math.min(comp.direction?.passes ?? CRITIQUE_PASS_DEFAULT, CRITIQUE_PASS_MAX)
  const firstOnRevision = !state.revisions.has(comp.revision)
  if (firstOnRevision) state.revisions.add(comp.revision)
  const pass = state.revisions.size
  const exhausted = pass >= maxPasses

  /* machine-gradeable signals land pre-filled; the rest the agent scores
     from the snapshot and the notes */
  const lint = report.lint
  const rubric: Record<
    string,
    { issues: { severity: string; at?: number; on?: string; fix: string }[]; note?: string }
  > = {}
  for (const cat of RUBRIC) rubric[cat] = { issues: [] }
  if (lint.errors > 0) {
    rubric.pacing!.issues.push({
      severity: 'blocker',
      fix: `${lint.errors} seek-safety error(s) — run lint_motion and fix before rendering`,
    })
  }
  for (const beat of report.pacing.dead_beats) {
    rubric.pacing!.issues.push({
      severity: 'major',
      at: beat.t,
      fix: 'a dead beat: nothing moves for over 1.5 s — animate an element or cut sooner',
    })
  }
  if (report.pacing.shot_seconds.variance < 0.01 && report.pacing.shot_seconds.max > 0) {
    rubric.pacing!.issues.push({
      severity: 'minor',
      fix: 'every shot is the same length — vary the rhythm for hierarchy',
    })
  }
  if ((report.legibility.under_minimum ?? 0) > 0) {
    rubric.legibility!.issues.push({
      severity: 'major',
      fix: `${report.legibility.under_minimum} text element(s) under ${14}px effective — zoom the camera or raise the type`,
    })
  }
  for (const v of report.safe_zones.violations ?? []) {
    const violation = v as { element_id: string; t: number; zone: string }
    rubric.polish!.issues.push({
      severity: 'minor',
      at: violation.t,
      on: violation.element_id,
      fix: `text outside the ${violation.zone}-safe zone — pull it inward`,
    })
  }
  if (report.effects.unsupported.length > 0) {
    rubric.polish!.issues.push({
      severity: 'major',
      fix: `unknown effect ids: ${report.effects.unsupported.join(', ')} — they render as passthrough`,
    })
  }
  if (report.effects.over_budget) {
    rubric.polish!.issues.push({
      severity: 'minor',
      fix: 'the effect stack is over the preview budget — trim or merge',
    })
  }
  const blockers = Object.values(rubric)
    .flatMap((r) => r.issues)
    .filter((i) => i.severity === 'blocker').length
  const majors = Object.values(rubric)
    .flatMap((r) => r.issues)
    .filter((i) => i.severity === 'major').length

  return ok({
    composition_id: comp.id,
    revision: comp.revision,
    pass,
    max_passes: maxPasses,
    exhausted,
    stop: exhausted || (blockers === 0 && majors === 0 && !firstOnRevision),
    blockers,
    majors,
    rubric,
    check: report,
    note: exhausted
      ? 'pass budget reached — ship what you have and say what stays rough'
      : 'score each rubric category, fix blockers and majors, then run critique_scene again after your edits',
  })
}
