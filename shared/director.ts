/**
 * The director run — the staged Animate loop (motion-director M0).
 *
 * A director run is server-owned: the model moves through plan → build →
 * refine × P → finish, the server charges every wrapped tool call against a
 * stage budget the model can read in each result footer, and delivery is
 * judged on the film — lint, shot coverage, machine rubric — not on how many
 * calls the model made. Ordinary design runs never see this file.
 *
 * Everything here is pure logic shared by the server loop and the tests;
 * nothing imports from server/.
 */
import { canonicalJson } from './canonicalJson.ts'
import {
  MOTION_LIMITS,
  type Composition,
  type EffectInstance,
  type MotionClip,
  type MotionKeyframe,
  type MotionTrack,
} from './motion.ts'
import type { Canvas, Frame } from './types.ts'
import type { RunnerPick } from './agentRunner.ts'

/* ---- the request a card carries ---- */

export type DirectorMode = 'fresh' | 'refine'
export type DirectorFreedom = 'faithful' | 'balanced' | 'free'

/** What an 'animate' card asks the director to run. Validated on the card
 *  route by parseAnimateRequest; the kind is never derived from text. */
export interface AnimateRequest {
  pageId: string
  /** 'fresh' plans and builds a film; 'refine' opens with a critique pass on
   *  the film already on the page (feedback reruns land here) */
  mode?: DirectorMode
  seconds?: number
  width?: number
  height?: number
  fps?: number
  /** refine passes the model may take; 1–5, default 3 */
  passes?: number
  freedom?: DirectorFreedom
  /** restrict the storyboard to these frames; default every page frame */
  frameIds?: string[]
  /** generation tools: disabled by default on a card unless the sender says so */
  paid?: { enabled: boolean; maxCalls?: number }
  /** the sender's ask in words — intent, not a script; ≤ 1_000 chars */
  note?: string
  /** the run this card retries/follows (feedback refine cards) */
  parentRunId?: string
}

const FREEDOMS: readonly string[] = ['faithful', 'balanced', 'free']

/** Validate an animate card payload. Returns the cleaned request or one
 *  error line; the route answers 400 on `!ok`. */
export function parseAnimateRequest(
  value: unknown,
): { ok: true; value: AnimateRequest } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: false, error: 'animate request required on an animate card' }
  if (typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'animate request must be an object' }
  const raw = value as Record<string, unknown>
  const out: AnimateRequest = { pageId: '' }
  if (typeof raw.pageId === 'string' && raw.pageId.trim()) out.pageId = raw.pageId.trim()
  else return { ok: false, error: 'animate.pageId is required' }
  if (raw.mode !== undefined) {
    if (raw.mode === 'fresh' || raw.mode === 'refine') out.mode = raw.mode
    else return { ok: false, error: "animate.mode is 'fresh' or 'refine'" }
  }
  const num = (key: 'seconds' | 'width' | 'height' | 'fps', lo: number, hi: number, int = false) => {
    const v = raw[key]
    if (v === undefined) return undefined as number | undefined
    const n = typeof v === 'number' ? v : NaN
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) {
      throw `animate.${key} must be ${int ? 'an integer ' : ''}between ${lo} and ${hi}`
    }
    return n
  }
  try {
    out.seconds = num('seconds', 0.1, MOTION_LIMITS.MAX_DURATION_S)
    out.width = num('width', MOTION_LIMITS.MIN_SIZE, MOTION_LIMITS.MAX_SIZE, true)
    out.height = num('height', MOTION_LIMITS.MIN_SIZE, MOTION_LIMITS.MAX_SIZE, true)
    out.fps = num('fps', MOTION_LIMITS.MIN_FPS, MOTION_LIMITS.MAX_FPS, true)
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  if (raw.passes !== undefined) {
    const p = raw.passes
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 5) {
      return { ok: false, error: 'animate.passes is an integer 1–5' }
    }
    out.passes = p
  }
  if (raw.freedom !== undefined) {
    if (typeof raw.freedom === 'string' && FREEDOMS.includes(raw.freedom)) out.freedom = raw.freedom as DirectorFreedom
    else return { ok: false, error: "animate.freedom is 'faithful', 'balanced' or 'free'" }
  }
  if (raw.frameIds !== undefined) {
    if (!Array.isArray(raw.frameIds) || raw.frameIds.some((f) => typeof f !== 'string') || raw.frameIds.length > 64) {
      return { ok: false, error: 'animate.frameIds is a list of frame ids (≤ 64)' }
    }
    out.frameIds = (raw.frameIds as string[]).filter((f, i, a) => a.indexOf(f) === i)
  }
  if (raw.paid !== undefined) {
    const p = raw.paid as Record<string, unknown>
    if (typeof p !== 'object' || p === null || typeof p.enabled !== 'boolean') {
      return { ok: false, error: 'animate.paid is { enabled: boolean, maxCalls?: number }' }
    }
    const max = p.maxCalls
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 200)) {
      return { ok: false, error: 'animate.paid.maxCalls is an integer 1–200' }
    }
    out.paid = { enabled: p.enabled, ...(max !== undefined ? { maxCalls: max } : {}) }
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length > 1_000) {
      return { ok: false, error: 'animate.note is text under 1,000 chars' }
    }
    const note = raw.note.trim()
    if (note) out.note = note
  }
  if (raw.parentRunId !== undefined) {
    if (typeof raw.parentRunId !== 'string' || !raw.parentRunId.trim()) {
      return { ok: false, error: 'animate.parentRunId is a run id' }
    }
    out.parentRunId = raw.parentRunId.trim()
  }
  return { ok: true, value: out }
}

/* ---- stages, status, records ---- */

export type DirectorStage = 'plan' | 'build' | 'refine' | 'finish'

export type DirectorStatus = 'running' | 'delivered' | 'delivered_with_issues' | 'failed' | 'stopped' | 'interrupted'

/** Per-stage budgets in charged calls; `refine` is per pass. `run` is the
 *  whole-run ceiling — the stages can sum past it but the run stops there. */
export interface DirectorBudgets {
  plan: number
  build: number
  refine: number
  run: number
}

/** What a run has spent. `activeMs` excludes time inside `wait_for_job`;
 *  `byStage` counts wrapped calls per stage (refine is per-pass). */
export interface DirectorSpent {
  calls: number
  inputTokens: number
  activeMs: number
  byStage: { plan: number; build: number; refine: number[]; finish: number }
}

/** something the run owes the asker at finish: unmet gate items, skipped
 *  shots, budget exhaustion on a stage — anything short of 'delivered' */
export interface OpenIssue {
  stage: DirectorStage
  text: string
}

/** one refine pass, recorded at its end */
export interface PassRecord {
  index: number
  /** contact-sheet still stored for this pass */
  sheetAssetId?: string
  /** machine rubric at pass end */
  blockers: number
  majors: number
  /** mean of the model's 8 scores, when it filed any */
  meanScore?: number
  /** model-filed issues this pass */
  issues?: { severity: string; fix: string }[]
  /** film signature at pass end — drives the unchanged/A-B-A stop */
  signature: string
  /** composition revision at pass end — the restore point */
  revision?: number
  startedAt: number
  endedAt?: number
}

/** the run's own ledger: one row per wrapped call that ran (or was refused).
 *  `effective` is before≠after on the target signature — a write that left
 *  the film or frame exactly as it was is recorded but does not count. */
export interface LedgerEntry {
  stage: DirectorStage
  pass?: number
  tool: string
  /** canonicalJson of the call's input */
  inputKey: string
  /** target signature before the call */
  before: string
  /** target signature after the call */
  after: string
  effective: boolean
  refused?: 'repeat' | 'paid' | 'allowlist' | 'ceiling'
  at: number
}

/** The persisted run row (plus the in-memory fields the loop keeps). */
export interface DirectorRun {
  id: string
  canvasId: string
  pageId: string
  taskId: string
  /** the account the run bills to */
  ownerId: string
  askerId?: string
  agent: string
  runner?: RunnerPick
  mode: DirectorMode
  status: DirectorStatus
  stage: DirectorStage
  /** current pass index (1-based inside refine), 0 elsewhere */
  pass: number
  maxPasses: number
  budgets: DirectorBudgets
  spent: DirectorSpent
  passes: PassRecord[]
  openIssues: OpenIssue[]
  /** failure/stop reason */
  reason?: string
  /** film signature at run start and at finish */
  startSig: string
  endSig?: string
  /** writes that changed the run's film or a frame it owns */
  effectiveWrites: number
  startedAt: number
  endedAt?: number

  /** in-memory only: the ledger, the revision the run last wrote, the shots
   *  it skipped on purpose, the calls refused in a row per tool */
  ledger: LedgerEntry[]
  lastWrittenRevision?: number
  skippedShots?: Record<string, string>
}

/** What a client sees of a run — the row minus loop internals. */
export type DirectorRunView = Omit<DirectorRun, 'ledger' | 'lastWrittenRevision' | 'skippedShots'>

export function directorRunView(run: DirectorRun): DirectorRunView {
  const { ledger: _l, lastWrittenRevision: _r, skippedShots: _s, ...view } = run
  return view
}

/* ---- the budgets ---- */

export const DIRECTOR_LIMITS = {
  PLAN_BASE: 8,
  PLAN_PER_SHOT: 1,
  PLAN_CAP: 24,
  BUILD_BASE: 12,
  BUILD_PER_SHOT: 8,
  BUILD_CAP: 120,
  REFINE_BASE: 10,
  REFINE_PER_SHOT: 4,
  REFINE_CAP: 60,
  /** whole-run ceiling in charged calls */
  RUN_CAP: 300,
  /** active wall time; waits don't consume it */
  MAX_ACTIVE_MS: 45 * 60_000,
  MAX_INPUT_TOKENS: 4_000_000,
  /** one wait_for_job call may block this long */
  WAIT_CALL_MS: 90_000,
  /** total wait per job — past it the tool says "go on without it" */
  WAIT_JOB_MS: 600_000,
  /** calls after the run ceiling before the server aborts */
  GRACE_CALLS: 3,
  /** 'free' multiplies stage budgets (still under each cap) */
  FREE_MULTIPLIER: 1.5,
} as const

export function stageBudgets(shots: number, passes: number, freedom: DirectorFreedom = 'balanced'): DirectorBudgets {
  const m = freedom === 'free' ? DIRECTOR_LIMITS.FREE_MULTIPLIER : 1
  const L = DIRECTOR_LIMITS
  const plan = Math.min(Math.ceil((L.PLAN_BASE + L.PLAN_PER_SHOT * shots) * m), L.PLAN_CAP)
  const build = Math.min(Math.ceil((L.BUILD_BASE + L.BUILD_PER_SHOT * shots) * m), L.BUILD_CAP)
  const refine = Math.min(Math.ceil((L.REFINE_BASE + L.REFINE_PER_SHOT * shots) * m), L.REFINE_CAP)
  const run = Math.min(plan + build + refine * Math.max(1, passes), L.RUN_CAP)
  return { plan, build, refine, run }
}

/* ---- the film signature ---- */

/** deterministic hash — FNV-1a 64-bit over UTF-16 units is plenty here: the
 *  signature compares states of one film, it is not a security boundary */
function hash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** A stable key for dedupe maps: canonicalJson (key-order free) hashed. The
 *  paid tools' effectiveKey and the repeat guard both key on this. */
export function directorKey(value: unknown): string {
  return hash(canonicalJson(value))
}

/** `fx:<instanceId>.<param>` lanes name a generated id — rewrite to the
 *  effect's index on its own track so two identical builds differ only in ids */
function laneProperty(property: string, track: MotionTrack): string {
  const m = /^fx:([A-Za-z0-9_-]{1,100})\.([A-Za-z][A-Za-z0-9-]{0,59})$/.exec(property)
  if (!m) return property
  const idx = (track.effects ?? []).findIndex((e) => e.id === m[1])
  return idx < 0 ? `fx:?.${m[2]}` : `fx:#${idx}.${m[2]}`
}

function trackKey(track: MotionTrack): string {
  return `${track.kind}/${track.frameId ?? ''}/${track.elementId ?? ''}`
}

function normKeyframe(k: MotionKeyframe, track: MotionTrack) {
  return { property: laneProperty(k.property, track), t: k.t, value: k.value, easing: k.easing }
}

function normClip(c: MotionClip) {
  const { id: _id, ...body } = c
  return body
}

function normEffect(e: EffectInstance, index: number) {
  const { id: _id, ...body } = e
  return { index, ...body }
}

function normTrack(track: MotionTrack, idKeys: Map<string, string>) {
  const { id, keyframes, clips, effects, masks, matte, ...body } = track
  void id
  const out: Record<string, unknown> = { ...body }
  /* the structural key rides along so a matte can name its source track */
  idKeys.set(track.id, trackKey(track))
  if (keyframes?.length) {
    out.keyframes = keyframes
      .map((k) => normKeyframe(k, track))
      .sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : a.t - b.t))
  }
  if (clips?.length) out.clips = clips.map(normClip)
  if (effects?.length) out.effects = effects.map(normEffect)
  if (matte) {
    out.matte = { ...matte, source: `track:${track.id}` }
    void out /* resolved in a second pass */
  }
  if (masks?.length) out.masks = masks.map(({ id: _mid, ...m }) => m)
  return { id: track.id, norm: out }
}

function frameHtmlOf(frame: Frame): string {
  try {
    return frame.html ?? ''
  } catch {
    return ''
  }
}

/** The frames a composition actually films: frame-clip sources and element
 *  track targets. */
export function shotFrameIds(comp: Composition): Set<string> {
  const ids = new Set<string>()
  for (const t of comp.tracks) {
    if (t.frameId) ids.add(t.frameId)
    for (const c of t.clips ?? []) if (c.source.type === 'frame') ids.add(c.source.frameId)
  }
  return ids
}

/**
 * The deterministic signature of a film: the composition body minus
 * revision/createdAt/updatedAt/updatedBy/id (by exclusion — a future field
 * is hashed), every track/keyframe/clip/effect id replaced by a structural
 * key, keyframes sorted by property then t, `fx:` lanes rewritten to effect
 * indexes; plus, per shot frame, a hash of html/width/height. Two builds
 * that differ only in regenerated ids compare equal; a keyframe value/time/
 * easing, an effect param, direction, motionBlur or a shot frame's HTML
 * changes it.
 */
export function filmSignature(comp: Composition | null | undefined, frames: readonly Frame[]): string {
  if (!comp) return 'none'
  const idKeys = new Map<string, string>()
  const normalized = comp.tracks.map((t) => normTrack(t, idKeys))
  /* second pass: matte.source points at a track id — swap in the structural
     key so a rebuild with fresh ids compares equal */
  const tracks = normalized.map(({ norm }) => {
    if (norm.matte && typeof norm.matte === 'object') {
      const m = norm.matte as { source: string }
      const raw = m.source.replace(/^track:/, '')
      return { ...norm, matte: { ...(norm.matte as object), source: idKeys.get(raw) ?? raw } }
    }
    return norm
  })
  const { id: _id, revision: _rev, createdAt: _ca, updatedAt: _ua, updatedBy: _ub, ...body } = comp
  const bodyNorm: Record<string, unknown> = { ...body, tracks }
  const shotIds = shotFrameIds(comp)
  const frameHashes: Record<string, string> = {}
  for (const f of frames) {
    if (!shotIds.has(f.id)) continue
    frameHashes[f.id] = hash(`${f.width}x${f.height}\n${frameHtmlOf(f)}`)
  }
  /* a shot whose frame is gone still shows up — the film changed */
  for (const id of shotIds) if (!(id in frameHashes)) frameHashes[id] = 'gone'
  return hash(canonicalJson({ comp: bodyNorm, frames: frameHashes }))
}

/** A frame's own signature — what frame-scoped tools move. */
export function frameSignature(frame: Frame | undefined): string {
  if (!frame) return 'none'
  return hash(`${frame.width}x${frame.height}\n${frameHtmlOf(frame)}`)
}

/* ---- target signatures (the ledger's before/after) ---- */

/** tools whose target is the page's film — a write lands in the signature */
const FILM_TOOLS = new Set([
  'set_composition',
  'animate_storyboard',
  'set_direction',
  'add_effect',
  'update_effect',
  'remove_effect',
  'set_effects',
  'apply_look',
  'set_layer',
  'apply_element_preset',
  'apply_camera_preset',
  'apply_transition',
  'apply_text_animation',
  'set_motion_blur',
  'insert_clip',
  'set_media',
  'build_captions',
  'duck_audio',
  'generate_voiceover',
  'transcribe_clip',
  'generate_video',
])

/** tools whose target is one frame's markup */
const FRAME_TOOLS = new Set([
  'edit_frame_html',
  'set_frame_html',
  'create_frame',
  'begin_frame_rewrite',
  'append_frame_rewrite',
  'commit_frame_rewrite',
])

function pageOf(input: Record<string, unknown>, canvas: Canvas): string | undefined {
  const direct = input.page_id ?? input.pageId
  if (typeof direct === 'string' && direct) return direct
  const frameId = input.frame_id ?? input.frameId
  if (typeof frameId === 'string') {
    const f = canvas.frames.find((fr) => fr.id === frameId)
    return f?.pageId ?? canvas.pages?.[0]?.id
  }
  return undefined
}

/**
 * The signature a tool call moves: the film signature for timeline tools,
 * the frame hash for frame tools, '' for reads and fire-and-forget jobs
 * (paid tools dedupe on their own effective key). The wrapper takes it
 * before and after execution — before≠after is an effective write.
 */
export function targetSignature(tool: string, input: Record<string, unknown>, canvas: Canvas): string {
  const pageId = pageOf(input, canvas)
  if (FILM_TOOLS.has(tool)) {
    if (!pageId) return ''
    const firstPage = canvas.pages?.[0]?.id
    const frames = canvas.frames.filter((f) => (f.pageId ?? firstPage) === pageId)
    const comp = (canvas.compositions ?? []).find((c) => c.pageId === pageId)
    return filmSignature(comp ?? null, frames)
  }
  if (FRAME_TOOLS.has(tool)) {
    const frameId = String(input.frame_id ?? input.id ?? '')
    return frameSignature(canvas.frames.find((f) => f.id === frameId))
  }
  return ''
}

/* ---- the build gate ---- */

export interface BuildGateFacts {
  /** error-severity lint issues on the composition */
  lintErrors: number
  /** per selected shot: covered = a real element animates on a non-opacity
   *  lane inside the shot window; skipped = the model declined it with a reason */
  shots: { frameId: string; animated: boolean; skipped?: string }[]
  /** every notes layer and the notes panel sits at opacity 0 */
  notesHidden: boolean
  effectCost: number
  effectCostCap: number
}

export function buildGate(f: BuildGateFacts): { pass: boolean; unmet: string[] } {
  const unmet: string[] = []
  if (f.lintErrors > 0) unmet.push(`${f.lintErrors} lint error${f.lintErrors === 1 ? '' : 's'} on the film`)
  for (const s of f.shots) {
    if (!s.animated && !s.skipped) unmet.push(`shot ${s.frameId}: no element motion — give a lane other than opacity`)
  }
  if (!f.notesHidden) unmet.push('notes layers are still visible — hold them at opacity 0')
  if (f.effectCost > f.effectCostCap) unmet.push(`effect cost ${f.effectCost} over the cap ${f.effectCostCap}`)
  return { pass: unmet.length === 0, unmet }
}

/* ---- the refine stop ---- */

/** Whether the pass sequence should end. Boundaries holds the film
 *  signature at each pass's start (this pass's first). */
export function refineStop(args: {
  blockers: number
  majors: number
  meanScore: number | undefined
  passCount: number
  maxPasses: number
  /** film signature at the end of the pass that just ran */
  signature: string
  boundaries: readonly string[]
}): { stop: boolean; reason?: string } {
  if (args.boundaries.includes(args.signature)) return { stop: true, reason: 'the pass changed nothing' }
  if (args.blockers === 0 && args.majors === 0 && (args.meanScore ?? 0) >= 3.5) {
    return { stop: true, reason: 'clean pass' }
  }
  if (args.passCount >= args.maxPasses) return { stop: true, reason: 'passes used' }
  return { stop: false }
}

/* ---- the verdict ---- */

export function verdict(r: {
  effectiveWrites: number
  lintErrors: number
  openIssues: readonly OpenIssue[]
  stopped?: boolean
}): { status: DirectorStatus; reason?: string } {
  if (r.stopped) return { status: 'stopped' }
  if (r.effectiveWrites === 0) return { status: 'failed', reason: 'the run made no effective write to the film' }
  if (r.lintErrors > 0) {
    return { status: 'failed', reason: `the film still has ${r.lintErrors} lint error${r.lintErrors === 1 ? '' : 's'}` }
  }
  if (r.openIssues.length > 0) return { status: 'delivered_with_issues' }
  return { status: 'delivered' }
}

/* ---- the film outline the briefs carry ---- */

const OUTLINE_CAP = 6_000

function lanesOf(track: MotionTrack): string {
  const byProp = new Map<string, number>()
  for (const k of track.keyframes ?? []) {
    const prop = laneProperty(k.property, track)
    byProp.set(prop, (byProp.get(prop) ?? 0) + 1)
  }
  return [...byProp.entries()].map(([p, n]) => `${p}×${n}`).join(', ')
}

function fmtT(t: number): string {
  return (Math.round(t * 100) / 100).toString()
}

/**
 * The compact film outline a stage brief carries — per shot: the window and
 * its source, the element tracks on the shot's frame with their lanes and
 * key counts, effects; camera, audio, captions once. Capped at 6 KB.
 */
export function compositionOutline(comp: Composition | null | undefined): string {
  if (!comp) return '(no film yet)'
  const lines: string[] = [
    `film ${fmtT(comp.duration)}s · ${comp.width}×${comp.height} · ${comp.fps}fps · rev ${comp.revision}`,
  ]
  /* shots = frame-source clips on clip tracks, in order */
  const shots: { start: number; end: number; frameId: string; transition?: string }[] = []
  for (const t of comp.tracks) {
    if (t.kind !== 'clip') continue
    for (const c of t.clips ?? []) {
      if (c.source.type === 'frame') {
        shots.push({
          start: c.start,
          end: c.start + c.duration,
          frameId: c.source.frameId,
          transition: c.transition?.kind,
        })
      }
    }
  }
  shots.sort((a, b) => a.start - b.start)
  for (const s of shots) {
    lines.push(`shot ${fmtT(s.start)}–${fmtT(s.end)} frame ${s.frameId}${s.transition ? ` ← ${s.transition}` : ''}`)
    for (const t of comp.tracks) {
      if (t.kind !== 'element' || t.frameId !== s.frameId) continue
      const fx = (t.effects ?? []).filter((e) => e.enabled !== false).map((e) => e.fx)
      lines.push(
        `  element ${t.elementId}${t.muted ? ' (muted)' : ''}: ${lanesOf(t) || 'no lanes'}${fx.length ? `; fx ${fx.join(',')}` : ''}`,
      )
    }
  }
  for (const t of comp.tracks) {
    if (t.kind === 'camera') lines.push(`camera: ${lanesOf(t) || 'no lanes'}`)
    else if (t.kind === 'audio' || t.kind === 'caption') lines.push(`${t.kind}: ${(t.clips ?? []).length} clip(s)`)
    else if (t.kind === 'adjustment') {
      const fx = (t.effects ?? []).map((e) => e.fx).join(',')
      lines.push(`adjustment ${fmtT(t.clips?.[0]?.start ?? 0)}: fx ${fx || 'none'}`)
    } else if (t.kind === 'clip' && (t.clips ?? []).some((c) => c.source.type !== 'frame')) {
      const others = (t.clips ?? []).filter((c) => c.source.type !== 'frame')
      lines.push(`media: ${others.map((c) => `${c.source.type}@${fmtT(c.start)}+${fmtT(c.duration)}`).join(', ')}`)
    }
  }
  let out = lines.join('\n')
  if (out.length > OUTLINE_CAP) out = out.slice(0, OUTLINE_CAP) + '\n…'
  return out
}
