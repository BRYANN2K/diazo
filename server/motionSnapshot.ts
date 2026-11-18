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
import { planLayers } from '../shared/motionLayers.ts'
import { frameStateAt } from '../shared/motionRuntime.ts'
import { EFFECT_COST_CAP, effectCost, effectSpec, GL_EFFECT_IDS } from '../shared/motionFx.ts'
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
  /* a caller-provided `times` is validated, not silently replaced with the
     beats — an out-of-range time must surface as a bad call */
  if (input.times?.length && !input.times.every((t) => Number.isFinite(t) && t >= 0 && t <= comp.duration)) {
    return fail(`times must be finite seconds within [0, ${comp.duration}]`)
  }
  const times = input.times?.length ? input.times.slice(0, 24) : beatTimes(comp)
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

/** a measured text box at shot time: the frame's own rotation carries it
 *  to world space, then the camera transform (translate → inverse rotate →
 *  zoom, the same order the compositor draws) to output space. Returns the
 *  projected corners' bounding box. */
function boxAt(
  box: TextBox,
  frame: { x: number; y: number; width: number; height: number; rotation?: number },
  camera: { x: number; y: number; zoom: number; rotation?: number },
  out: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const fc = ((frame.rotation ?? 0) * Math.PI) / 180
  const fcx = frame.x + frame.width / 2
  const fcy = frame.y + frame.height / 2
  const cc = (-(camera.rotation ?? 0) * Math.PI) / 180
  const [fcos, fsin, ccos, csin] = [Math.cos(fc), Math.sin(fc), Math.cos(cc), Math.sin(cc)]
  const project = (px: number, py: number): [number, number] => {
    const wx = fcx + fcos * (px - frame.width / 2) - fsin * (py - frame.height / 2)
    const wy = fcy + fsin * (px - frame.width / 2) + fcos * (py - frame.height / 2)
    const dx = wx - camera.x
    const dy = wy - camera.y
    return [
      (ccos * dx - csin * dy) * camera.zoom + out.width / 2,
      (csin * dx + ccos * dy) * camera.zoom + out.height / 2,
    ]
  }
  const pts = [
    project(box.x, box.y),
    project(box.x + box.w, box.y),
    project(box.x, box.y + box.h),
    project(box.x + box.w, box.y + box.h),
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/* -- contrast (WCAG 2.x ratio on the sampled colours) -- */

const CONTRAST_AA = 4.5 /* normal text */
const CONTRAST_AA_LARGE = 3 /* ≥24px effective, or ≥18.66px bold */

function srgb(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** a css colour as [r,g,b,a]: '#rgb', '#rrggbb', 'rgb()' or 'rgba()' */
export function parseColor(input: string): [number, number, number, number] | undefined {
  const s = input.trim().toLowerCase()
  if (s.startsWith('#')) {
    const hex = s.slice(1)
    const v =
      hex.length === 3
        ? [...hex].map((ch) => parseInt(ch + ch, 16))
        : hex.length === 6
          ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
          : []
    if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) return undefined
    return [v[0]!, v[1]!, v[2]!, 1]
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s)
  if (!m) return undefined
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number.isFinite(a) ? Math.min(a, 1) : 1]
}

/** WCAG contrast of `fg` text over the `bg` backdrop it sits on — the
 *  text's own alpha is composited onto the backdrop first */
export function contrastRatio(fg: string, bg: string): number | undefined {
  const f = parseColor(fg)
  const b = parseColor(bg)
  if (!f || !b) return undefined
  const lum = (r: number, g: number, bl: number) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(bl)
  const lf = lum(f[0] * f[3] + (1 - f[3]) * b[0], f[1] * f[3] + (1 - f[3]) * b[1], f[2] * f[3] + (1 - f[3]) * b[2])
  const lb = lum(b[0], b[1], b[2])
  return (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)
}

const fontWeightNum = (w: string): number => (w === 'bold' ? 700 : Number.parseInt(w, 10) || 400)

const ACTION_SAFE = 0.05 /* broadcast convention: keep action inside 90% */
const TITLE_SAFE = 0.1 /* and titles inside 80% */
const MIN_TEXT_PX = 14 /* an effective text height under this reads small */

export interface LegibilityItem {
  element_id: string
  frame_id: string
  t: number
  font_px_effective: number
  under_minimum: boolean
  small: boolean
  contrast: number | null
  contrast_min: number
  low_contrast: boolean
}

/** the safe-zone and legibility numbers for the measured text boxes, per
 *  shot: a box counts only while the camera keeps its projected rect on the
 *  raster — off-screen text is another shot's content, never a violation.
 *  Exported so the checks are unit-testable without a renderer. */
export function measureChecks(
  comp: Composition,
  shots: { t: number; duration: number }[],
  boxes: TextBox[],
  frameById: Map<string, { x: number; y: number; width: number; height: number; rotation?: number }>,
): { legItems: LegibilityItem[]; violations: unknown[] } {
  const legItems: LegibilityItem[] = []
  const violations: unknown[] = []
  for (const shot of shots) {
    const state = frameStateAt(comp, shot.t + shot.duration / 2)
    const camera = state.camera ?? { x: 0, y: 0, zoom: 1, rotation: 0 }
    for (const box of boxes) {
      const frame = frameById.get(box.frameId)
      if (!frame) continue
      const rect = boxAt(box, frame, camera, comp)
      if (rect.x >= comp.width || rect.x + rect.w <= 0 || rect.y >= comp.height || rect.y + rect.h <= 0) {
        continue
      }
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
      const contrast = contrastRatio(box.color, box.background)
      const large = effPx >= 24 || (effPx >= 18.66 && fontWeightNum(box.fontWeight) >= 700)
      const contrastMin = large ? CONTRAST_AA_LARGE : CONTRAST_AA
      legItems.push({
        element_id: box.elementId,
        frame_id: box.frameId,
        t: shot.t,
        font_px_effective: Math.round(effPx * 10) / 10,
        under_minimum: effPx < MIN_TEXT_PX,
        small: effPx < MIN_TEXT_PX * 1.4,
        contrast: contrast === undefined ? null : Math.round(contrast * 100) / 100,
        contrast_min: contrastMin,
        low_contrast: contrast !== undefined && contrast < contrastMin,
      })
    }
  }
  return { legItems, violations }
}

export async function checkScene(canvas: Canvas, pageId: string, input: { pixels?: boolean }): Promise<Outcome> {
  if (!canvasPages(canvas).some((p) => p.id === pageId)) return fail(`no page ${pageId} on this canvas`)
  const comp = store.getComposition(canvas.id, pageId)
  if (!comp) return fail(`page ${pageId} has no composition — nothing to check`)

  /* 1 — the same lint lint_motion runs */
  const loaded = (await store.load(canvas.id)) ?? canvas
  const frames = pageFrames(loaded, pageId)
  const frameIds = new Set(frames.map((f) => f.id))
  const issues: MotionLintIssue[] = [
    ...lintComposition(comp, { frameIds, frameHtml: new Map(frames.map((f) => [f.id, f.html])) }),
  ]
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

  /* 3 — the effect bill, per track and in total, plus what the renderer
     cannot draw: stacks on tracks whose pixels never reach the GL pass
     (clip/audio/caption), a blend on a non-element track, a per-effect
     blend (P1), and registry effects this GL build has no body for.
     Element tracks draw in the layer compositor (motion-elements P0). */
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
  const notDrawn: { track_id: string; what: string; reason: string }[] = []
  for (const track of comp.tracks) {
    for (const e of track.effects ?? []) {
      if (!effectSpec(e.fx)) unsupported.add(e.fx)
      if (track.kind !== 'camera' && track.kind !== 'adjustment' && track.kind !== 'element') {
        notDrawn.push({
          track_id: track.id,
          what: e.fx,
          reason: `effects on ${track.kind} tracks are not drawn`,
        })
      } else if (effectSpec(e.fx) && !GL_EFFECT_IDS.has(e.fx)) {
        notDrawn.push({ track_id: track.id, what: e.fx, reason: 'no shader in this build — renders as passthrough' })
      }
      if (e.blend != null) {
        notDrawn.push({
          track_id: track.id,
          what: `blend:${e.blend} on ${e.fx}`,
          reason: 'per-effect blend draws in P1',
        })
      }
    }
    if (track.blend != null && track.kind !== 'element') {
      notDrawn.push({ track_id: track.id, what: `blend:${track.blend}`, reason: 'only element tracks blend' })
    }
    if (track.matte != null) {
      notDrawn.push({ track_id: track.id, what: `matte → ${track.matte.source}`, reason: 'mattes draw in P1' })
    }
    if ((track.masks?.length ?? 0) > 0) {
      notDrawn.push({ track_id: track.id, what: `${track.masks!.length} mask(s)`, reason: 'masks draw in P1' })
    }
  }
  const effects = {
    per_track: perTrack,
    total_cost: totalCost,
    cost_cap: EFFECT_COST_CAP,
    over_budget: totalCost > EFFECT_COST_CAP,
    unsupported: [...unsupported],
    not_drawn: notDrawn,
  }

  /* 3b — the layer plan (static part) and motion variety: what promotes,
     what it costs, and which shots read as fade-only */
  const plans = planLayers(
    comp,
    frames.map((f) => ({ id: f.id, html: f.html })),
  )
  const layers = {
    count: plans.reduce((a, p) => a + p.layers.length, 0),
    frames: plans
      .filter((p) => p.layers.length > 0)
      .map((p) => ({
        frame_id: p.frameId,
        layers: p.layers.map((l) => ({
          element_id: l.elementId,
          track_id: l.trackId,
          content: l.content,
          transform: l.transform,
          visible: l.visible,
          pad: l.pad,
          scale: l.scale,
          cost: l.cost,
          geometry: l.geometry,
        })),
      })),
    issues: plans.flatMap((p) => p.issues),
  }
  const motionVariety = shots.map((shot) => {
    const end = shot.t + shot.duration
    const props = new Set<string>()
    let animated = 0
    for (const track of comp.tracks) {
      if (track.kind !== 'element') continue
      const inShot = (track.keyframes ?? []).filter((k) => k.t >= shot.t && k.t < end)
      if (inShot.length === 0) continue
      animated += 1
      for (const k of inShot) props.add(k.property)
    }
    return {
      t: shot.t,
      duration: shot.duration,
      element_tracks: animated,
      properties: [...props].sort(),
      only_opacity: animated > 0 && [...props].every((p) => p === 'opacity'),
    }
  })

  /* 4 — safe zones + legibility need measured text: the harness measure
     pass when the renderer is up, reported unavailable otherwise */
  let legibility: unknown = { available: false, reason: 'no renderer on this instance' }
  let safeZones: unknown = { available: false, reason: 'no renderer on this instance' }
  if (input.pixels !== false && rendererAvailable()) {
    const driven = await driveHarness(comp, { measure: true })
    if (!('error' in driven) && driven.boxes) {
      const frameById = new Map(frames.map((f) => [f.id, f]))
      const measured = measureChecks(
        comp,
        shots.length ? shots : [{ t: 0, duration: comp.duration }],
        driven.boxes,
        frameById,
      )
      legibility = {
        available: true,
        min_effective_px: MIN_TEXT_PX,
        contrast_aa: { normal: CONTRAST_AA, large: CONTRAST_AA_LARGE },
        elements: measured.legItems,
        under_minimum: measured.legItems.filter((i) => i.under_minimum).length,
        low_contrast: measured.legItems.filter((i) => i.low_contrast).length,
      }
      safeZones = {
        available: true,
        action_safe: ACTION_SAFE,
        title_safe: TITLE_SAFE,
        violations: measured.violations,
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
    layers,
    motion_variety: motionVariety,
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
/* the budget is per run, not per process: a long-lived instance could
   otherwise strand an exhausted budget on a page the agent moved on from */
const CRITIQUE_STATES_MAX = 200

/** a new run on the page restarts the critique budget — animate_storyboard
 *  and set_direction both clear it */
export function resetCritiques(canvasId: string, pageId: string) {
  const prefix = `${canvasId}/${pageId}/`
  for (const key of critiques.keys()) if (key.startsWith(prefix)) critiques.delete(key)
}

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
    legibility: { available?: boolean; under_minimum?: number; low_contrast?: number }
    safe_zones: { available?: boolean; violations?: unknown[] }
    effects: {
      over_budget: boolean
      unsupported: string[]
      not_drawn?: { track_id: string; what: string; reason: string }[]
    }
  }

  const key = `${canvas.id}/${pageId}/${comp.id}`
  let state = critiques.get(key)
  if (!state) {
    /* bound the map — a canvas left mid-run must not grow it forever */
    if (critiques.size >= CRITIQUE_STATES_MAX) critiques.delete(critiques.keys().next().value!)
    critiques.set(key, (state = { revisions: new Set() }))
  }
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
      fix: `${report.legibility.under_minimum} text element(s) under ${MIN_TEXT_PX}px effective — zoom the camera or raise the type`,
    })
  }
  if ((report.legibility.low_contrast ?? 0) > 0) {
    rubric.legibility!.issues.push({
      severity: 'major',
      fix: `${report.legibility.low_contrast} text element(s) under the WCAG contrast floor — change the colour or the backdrop`,
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
  for (const gap of report.effects.not_drawn ?? []) {
    rubric.polish!.issues.push({
      severity: 'major',
      on: gap.track_id,
      fix: `${gap.what} — ${gap.reason}; it will not appear in the render`,
    })
  }
  if (report.effects.over_budget) {
    rubric.polish!.issues.push({
      severity: 'minor',
      fix: `the effect stack is over the ${EFFECT_COST_CAP}-point render cap — a server render refuses it; trim or merge`,
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
