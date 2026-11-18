/**
 * server/directorLoop.ts — the staged Animate run (motion-director M0).
 *
 * runAgent hands an 'animate' card here; nothing else calls it. The server
 * owns the run: stage entry does its own work (shot digest, the first film,
 * the contact sheet), the model spends a per-stage call budget it reads in
 * every result's footer, and delivery is judged on the film — lint, shot
 * coverage, the machine rubric — never on how many calls it took.
 *
 * Two model paths charge identically: the API loop (model.run, one user
 * message per stage boundary) and a local harness (model.runHarness, stage
 * briefs riding in end_stage results). Every wrapped call — executed or
 * refused — costs one call; the run ceiling answers "Budget spent" for
 * GRACE_CALLS more and then aborts.
 */
import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import * as actions from './actions.ts'
import { store } from './store.ts'
import { storeAsset } from './assets.ts'
import { getJob } from './speech.ts'
import { getBlenderOp } from './blenderOps.ts'
import { getRenderJob } from './motionJobs.ts'
import { animateStoryboard } from './motionTools.ts'
import { analyzeShotHtml } from './storyboard.ts'
import { retryModelTurn } from './modelTurnRetry.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { lintComposition } from '../shared/motionLint.ts'
import { effectCost, EFFECT_COST_CAP } from '../shared/motionFx.ts'
import { canonicalJson } from '../shared/canonicalJson.ts'
import { DIRECTOR } from './guide.ts'
import {
  buildGate,
  compositionOutline,
  directorKey,
  DIRECTOR_LIMITS,
  filmSignature,
  refineStop,
  stageBudgets,
  targetSignature,
  verdict,
  type AnimateRequest,
  type DirectorRun,
  type DirectorStage,
  type PassRecord,
} from '../shared/director.ts'
import { insertDirectorRun, registerAgentRun, touchDirectorRun, unregisterAgentRun } from './directorRuns.ts'
import { listMotionEffects, listElementPresets, listLooks, listMotionPresets } from './motionProTools.ts'
import type { AgentModel } from './agentModel.ts'
import type { MeteredRun } from './agentRuns.ts'
import type { AgentRole } from '../shared/agents.ts'
import type { Actor, AgentTask, Canvas, Frame } from '../shared/types.ts'
import type { Composition } from '../shared/motion.ts'
import type { RunState } from './resident.ts'
import type { CheckReport } from './motionSnapshot.ts'

/* ---------------------------------------------------------------- */
/* the pieces tests swap out                                         */
/* ---------------------------------------------------------------- */

export type DirectorJobKind = 'speech' | 'video' | 'blender' | 'render'

export interface DirectorJobState {
  found: boolean
  /** queued | running | done | failed | canceled — the job's own word */
  state: string
  detail?: Record<string, unknown>
}

type Outcome = { ok: true; data: unknown } | { ok: false; error: string }

export type DirectorExec = (
  block: Anthropic.ToolUseBlockParam,
  canvasId: string,
  actor: Actor,
  runState: RunState,
) => Promise<Anthropic.ToolResultBlockParam>

export const directorDeps = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  checkScene: async (canvas: Canvas, pageId: string, input: { pixels?: boolean }): Promise<Outcome> =>
    (await import('./motionSnapshot.ts')).checkScene(canvas, pageId, input),
  sceneSnapshot: async (
    canvas: Canvas,
    pageId: string,
    input: { times?: number[]; auto?: string; max_side?: number; columns?: number },
  ): Promise<Outcome> => (await import('./motionSnapshot.ts')).sceneSnapshot(canvas, pageId, input),
  storeSheet: async (pngBase64: string, meta: { canvasId: string; ownerId?: string; uploadedBy: string }) => {
    const buf = Buffer.from(pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
    return storeAsset(buf, { mime: 'image/png', ext: 'png' }, meta)
  },
  /** one job's current state, scoped to the canvas — a job id from another
   *  canvas reads as missing */
  jobState: async (kind: DirectorJobKind, jobId: string, canvasId: string): Promise<DirectorJobState> => {
    if (kind === 'speech') {
      const job = await getJob(jobId)
      return job && job.canvasId === canvasId
        ? { found: true, state: job.state, detail: { progress: job.progress, error: job.error } }
        : { found: false, state: '' }
    }
    if (kind === 'blender') {
      const op = await getBlenderOp(jobId)
      return op && op.canvasId === canvasId
        ? { found: true, state: op.state, detail: { tool: op.tool, error: op.error } }
        : { found: false, state: '' }
    }
    if (kind === 'render') {
      const job = getRenderJob(jobId)
      return job && job.canvasId === canvasId
        ? { found: true, state: job.status, detail: { progress: job.progress, error: job.error } }
        : { found: false, state: '' }
    }
    /* generate_video is synchronous — the call returns with its clip placed */
    return { found: false, state: '' }
  },
  /** versions of the run's composition, for the regression restore */
  versions: (canvasId: string, compositionId: string) =>
    import('./db/persist.ts').then((p) => p.listCompositionVersions(canvasId, compositionId)),
  versionState: (canvasId: string, versionId: string) =>
    import('./db/persist.ts').then((p) => p.getCompositionVersion(canvasId, versionId)),
  /** the rubric a check_scene report grades to — pure, lives with the check */
  machineRubric: (report: CheckReport) => import('./motionSnapshot.ts').then((m) => m.machineRubric(report)),
}

/* ---------------------------------------------------------------- */
/* the tools a stage may call                                        */
/* ---------------------------------------------------------------- */

const READ_TOOLS = [
  'set_status',
  'find_in_canvas',
  'inspect_frame',
  'get_frame_html',
  'screenshot_frame',
  'get_composition',
  'get_direction',
  'list_motion_presets',
  'list_element_presets',
  'list_looks',
  'list_motion_effects',
  'get_layer_plan',
  'get_scene_snapshot',
  'check_scene',
  'lint_motion',
  'list_media',
  'list_speech_engines',
  'estimate_speech',
  'get_transcript',
  'list_voices',
  'list_video_models',
  'get_blender_result',
  'blender_get_scene',
  'blender_get_object',
  'search_images',
  'list_backgrounds',
  'wait_for_job',
] as const

const WRITE_TOOLS = [
  'set_direction',
  'set_composition',
  'animate_storyboard',
  'apply_camera_preset',
  'apply_transition',
  'apply_text_animation',
  'add_effect',
  'update_effect',
  'remove_effect',
  'set_effects',
  'apply_look',
  'set_motion_blur',
  'set_layer',
  'apply_element_preset',
  'insert_clip',
  'set_media',
  'build_captions',
  'duck_audio',
  'suggest_cuts',
  'edit_frame_html',
  'set_frame_html',
  'begin_frame_rewrite',
  'append_frame_rewrite',
  'commit_frame_rewrite',
  'create_frame',
  'generate_image',
  'generate_voiceover',
  'transcribe_clip',
  'generate_video',
  'blender_render_frame',
  'render_composition',
] as const

/** paid filings dedupe on their effectiveKey and obey paid.enabled/maxCalls */
const PAID_TOOLS = new Set([
  'generate_voiceover',
  'transcribe_clip',
  'generate_video',
  'generate_image',
  'blender_render_frame',
  'render_composition',
])

function stageAllowlist(stage: DirectorStage, pass: number): ReadonlySet<string> {
  switch (stage) {
    case 'plan':
      return new Set([...READ_TOOLS, 'set_direction', 'end_stage'])
    case 'build':
      return new Set([...READ_TOOLS, ...WRITE_TOOLS, 'end_stage'])
    case 'refine':
      /* a refine pass edits the film and critiques it — it does not rebuild
         the storyboard */
      return new Set(
        [...READ_TOOLS, ...WRITE_TOOLS, 'end_stage', 'critique_scene'].filter(
          (t) => t !== 'animate_storyboard' && (pass > 1 ? t !== 'set_direction' : true),
        ),
      )
    case 'finish':
      return new Set()
  }
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

export interface DirectorOptions {
  canvasId: string
  /** the claimed 'animate' card — animate.pageId names the film's page */
  card: AgentTask
  role: AgentRole
  payer: string
  /** the metered model — its calls bill the run's ledger row */
  model: AgentModel
  /** the run's ledger row id — pass state reads through it */
  meter: MeteredRun
  actor: Actor
  canceled: () => boolean
  abort: AbortController
  exec: DirectorExec
  /** the resident tool list; the stage's subset goes to the model */
  tools: Anthropic.Tool[]
  system: string
}

interface Ctx extends DirectorOptions {
  req: AnimateRequest
  pageId: string
  run: DirectorRun
  runState: RunState
  /** calls charged in the current stage (refine: the current pass) */
  stageSpent: number
  /** film signatures at each pass's start */
  boundaries: string[]
  /** exact-repeat guard, cleared at each stage boundary */
  seen: Map<string, { after: string; effective: boolean; result: Anthropic.ToolResultBlockParam }>
  /** effectiveKey → the first filing's result */
  paid: Map<string, Anthropic.ToolResultBlockParam>
  paidCount: number
  /** consecutive refusals per tool — the schema hint lands after five */
  refusals: Map<string, number>
  /** 'kind:id' → ms spent inside wait_for_job */
  jobWait: Map<string, number>
  /** set by the stage advance — the next request's single message */
  pendingBrief?: string
  stageChanged: boolean
  done: boolean
  /** run ceiling spent — calls answer "Budget spent", GRACE_CALLS to abort */
  ceiling: boolean
  grace: number
  aborted: boolean
  /** implicit end_stage nudges already given on this stage */
  nudged: number
  /** the current pass's contact-sheet asset */
  sheetAssetId?: string
  passStartedAt: number
  /** model-filed critique this pass (scores + issues) */
  passScores?: Record<string, number>
  passIssues?: { severity: string; fix: string; at?: number; on?: string }[]
  /** the harness result's closing text — the summary on that path */
  harnessText?: string
  /** the run's frames on the card's page (refresh per use) */
  shots: { frameId: string; start: number; end: number }[]
  /** shot digests from plan entry: element sets the gates and briefs need */
  shotInfo: Map<string, { notes: string[]; noteIds: Set<string>; elementIds: Set<string>; panelId?: string }>
  /** the plan brief's per-shot digest */
  shotDigest?: string
  /** the check_scene report at pass entry, carried into the refine brief */
  lastCheck?: Record<string, unknown>
}

const ok = (
  tool_use_id: string,
  content: Anthropic.ToolResultBlockParam['content'],
): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id,
  content,
})

const failRes = (tool_use_id: string, msg: string): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id,
  content: msg,
  is_error: true,
})

function compOf(ctx: Ctx): Composition | undefined {
  return store.getComposition(ctx.canvasId, ctx.pageId)
}

function pageFramesOf(ctx: Ctx): Frame[] {
  const canvas = store.getCanvas(ctx.canvasId)
  if (!canvas) return []
  const wanted = ctx.req.frameIds?.length ? new Set(ctx.req.frameIds) : undefined
  return pageFrames(canvas, ctx.pageId).filter((f) => !wanted || wanted.has(f.id))
}

function filmSig(ctx: Ctx): string {
  return filmSignature(compOf(ctx), pageFramesOf(ctx))
}

function stageBudget(ctx: Ctx): number {
  const b = ctx.run.budgets
  return ctx.run.stage === 'plan'
    ? b.plan
    : ctx.run.stage === 'build'
      ? b.build
      : ctx.run.stage === 'refine'
        ? b.refine
        : 0
}

function charge(ctx: Ctx) {
  const run = ctx.run
  run.spent.calls++
  ctx.stageSpent++
  if (run.stage === 'refine') {
    const list = run.spent.byStage.refine
    while (list.length < run.pass) list.push(0)
    list[run.pass - 1]!++
  } else {
    run.spent.byStage[run.stage as 'plan' | 'build' | 'finish']++
  }
  touchDirectorRun(run)
}

/** active wall time: waits inside wait_for_job do not count */
function chargeTime(ctx: Ctx, elapsedMs: number) {
  ctx.run.spent.activeMs += Math.max(0, elapsedMs)
}

function footer(ctx: Ctx): string {
  const run = ctx.run
  const mins = Math.round(run.spent.activeMs / 60_000)
  return `\n\n[director: ${run.stage} · ${ctx.stageSpent}/${stageBudget(ctx)} calls · pass ${run.pass}/${run.maxPasses} · ${mins} min]`
}

function withFooter(ctx: Ctx, res: Anthropic.ToolResultBlockParam, extra?: string): Anthropic.ToolResultBlockParam {
  const text = footer(ctx) + (extra ? `\n\n${extra}` : '')
  if (typeof res.content === 'string') return { ...res, content: res.content + text }
  return { ...res, content: [...(res.content ?? []), { type: 'text', text }] }
}

/** the run's ledger row — every wrapped call, effective or not */
function ledger(ctx: Ctx, entry: { tool: string; input: unknown; before: string; after: string; refused?: string }) {
  const run = ctx.run
  run.ledger.push({
    stage: run.stage,
    ...(run.stage === 'refine' ? { pass: run.pass } : {}),
    tool: entry.tool,
    inputKey: directorKey(entry.input),
    before: entry.before,
    after: entry.after,
    effective: entry.before !== entry.after,
    ...(entry.refused ? { refused: entry.refused as 'repeat' | 'paid' | 'allowlist' | 'ceiling' } : {}),
    at: directorDeps.now(),
  })
  if (entry.before !== entry.after) {
    run.effectiveWrites++
    const comp = compOf(ctx)
    if (comp) run.lastWrittenRevision = comp.revision
  }
}

function pushIssue(ctx: Ctx, stage: DirectorStage, text: string) {
  const issues = ctx.run.openIssues
  if (!issues.some((i) => i.text === text)) issues.push({ stage, text })
  if (issues.length > 60) issues.length = 60
}

/* ---------------------------------------------------------------- */
/* stage gates                                                       */
/* ---------------------------------------------------------------- */

function planGate(ctx: Ctx): { pass: boolean; unmet: string[] } {
  const unmet: string[] = []
  const comp = compOf(ctx)
  const direction = comp?.direction
  if (!direction?.treatment?.trim()) unmet.push('no Direction — set_direction with a treatment and beats')
  const beats = direction?.beats ?? []
  if (!beats.length) unmet.push('the Direction has no beats')
  else if (ctx.req.seconds) {
    const sum = beats.reduce((a, b) => a + (typeof b.seconds === 'number' ? b.seconds : 0), 0)
    const slack = Math.max(0.5, ctx.req.seconds * 0.1)
    if (Math.abs(sum - ctx.req.seconds) > slack) {
      unmet.push(`beats sum ${sum.toFixed(1)}s — the ask is ${ctx.req.seconds}s`)
    }
  }
  return { pass: unmet.length === 0, unmet }
}

/** shot windows from the film's frame-source clips, in order */
function shotWindows(ctx: Ctx): { frameId: string; start: number; end: number }[] {
  const comp = compOf(ctx)
  if (!comp) return []
  const shots: { frameId: string; start: number; end: number }[] = []
  for (const t of comp.tracks) {
    if (t.kind !== 'clip') continue
    for (const c of t.clips ?? []) {
      if (c.source.type === 'frame' && c.source.frameId) {
        shots.push({ frameId: c.source.frameId, start: c.start, end: c.start + c.duration })
      }
    }
  }
  return shots.sort((a, b) => a.start - b.start)
}

function buildGateFacts(ctx: Ctx) {
  const canvas = store.getCanvas(ctx.canvasId)
  const comp = compOf(ctx)
  const frames = pageFramesOf(ctx)
  const frameIds = new Set(frames.map((f) => f.id))
  const html = new Map<string, string>()
  for (const f of frames) {
    try {
      html.set(f.id, f.html ?? '')
    } catch {
      html.set(f.id, '')
    }
  }
  const lintErrors = comp
    ? lintComposition(comp, { frameIds, frameHtml: html }).filter((i) => i.severity === 'error').length
    : 0
  const shots = shotWindows(ctx)
  const facts = {
    lintErrors,
    shots: shots.map((shot) => {
      const info = ctx.shotInfo.get(shot.frameId)
      const animated = (comp?.tracks ?? []).some((track) => {
        if (track.kind !== 'element' || track.muted) return false
        if (track.frameId !== shot.frameId || !track.elementId) return false
        if (info && !info.elementIds.has(track.elementId)) return false
        if (info && info.noteIds.has(track.elementId)) return false
        return (track.keyframes ?? []).some(
          (k) => k.property !== 'opacity' && k.t >= shot.start - 0.001 && k.t < shot.end,
        )
      })
      return {
        frameId: shot.frameId,
        animated,
        ...(ctx.run.skippedShots?.[shot.frameId] ? { skipped: ctx.run.skippedShots[shot.frameId] } : {}),
      }
    }),
    notesHidden: shots.every((shot) => {
      const info = ctx.shotInfo.get(shot.frameId)
      if (!info) return true
      const hide = [...info.noteIds, ...(info.panelId ? [info.panelId] : [])]
      return hide.every((elementId) =>
        (comp?.tracks ?? []).some((track) => {
          if (track.kind !== 'element' || track.elementId !== elementId) return false
          const keys = (track.keyframes ?? [])
            .filter((k) => k.property === 'opacity' && k.t >= shot.start - 0.001 && k.t < shot.end + 0.2)
            .sort((a, b) => a.t - b.t)
          const first = keys[0]
          /* held at 0: the first opacity key in the window is ~0 and nothing
             lifts it again inside the shot */
          return (
            !!first &&
            (typeof first.value === 'number' ? first.value : parseFloat(String(first.value))) <= 0.01 &&
            !keys.some(
              (k) =>
                k.t > first.t + 0.001 && (typeof k.value === 'number' ? k.value : parseFloat(String(k.value))) > 0.01,
            )
          )
        }),
      )
    }),
    effectCost: (comp?.tracks ?? []).reduce((a, t) => a + effectCost(t), 0),
    effectCostCap: EFFECT_COST_CAP,
  }
  void canvas
  return facts
}

function gateFor(ctx: Ctx): { pass: boolean; unmet: string[] } {
  if (ctx.run.stage === 'plan') return planGate(ctx)
  if (ctx.run.stage === 'build') return buildGate(buildGateFacts(ctx))
  /* refine and finish gate nothing — a pass ends when the model says so or
     its calls run out */
  return { pass: true, unmet: [] }
}

/* ---------------------------------------------------------------- */
/* stage entries — server work, no model call                        */
/* ---------------------------------------------------------------- */

/** plan: the shots' notes and targets (the animate_storyboard analysis,
 *  ids committed) plus the vocabulary by name — no film yet */
async function enterPlan(ctx: Ctx) {
  const canvas = (await store.load(ctx.canvasId)) ?? store.getCanvas(ctx.canvasId)
  if (!canvas) throw new Error('canvas not found')
  const frames = pageFramesOf(ctx)
  ctx.shotInfo = new Map()
  const lines: string[] = []
  for (const frame of frames) {
    let html = ''
    try {
      html = frame.html ?? ''
    } catch {
      html = ''
    }
    if (!html.trim()) {
      ctx.shotInfo.set(frame.id, { notes: [], noteIds: new Set(), elementIds: new Set() })
      lines.push(`shot ${frame.id} ("${frame.name}") — empty frame`)
      continue
    }
    const analysis = analyzeShotHtml(html)
    let notes = analysis.notes
    let targets = analysis.targets
    let panelId = analysis.panelId
    const noteIds = new Set(analysis.noteIds)
    const elementIds = new Set(analysis.elementIds)
    if (analysis.stampedIds.length > 0) {
      const landed =
        !actions.isFrameStreaming(frame.id) &&
        !!(await actions.commitElementStamps(frame, analysis.html, analysis.stampedIds, ctx.actor.name, ctx.actor.kind))
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
    ctx.shotInfo.set(frame.id, {
      notes: notes.map((n) => n.text),
      noteIds,
      elementIds,
      ...(panelId ? { panelId } : {}),
    })
    lines.push(
      `shot ${frame.id} ("${frame.name}")` +
        (notes.length ? `\n  notes: ${notes.map((n) => n.text).join(' | ')}` : '\n  notes: none') +
        `\n  targets: ${targets.map((t) => `${t.id} ${t.tag} ${t.label}`).join('; ') || 'none'}` +
        (panelId ? `\n  notes panel: ${panelId}` : '') +
        (noteIds.size ? `\n  note ids: ${[...noteIds].join(', ')}` : ''),
    )
  }
  ctx.shotDigest = lines.join('\n')
  /* the film the model is about to direct needs somewhere to live: a shell
     composition carries the Direction until build writes the storyboard */
  if (!compOf(ctx)) {
    actions.setComposition(
      ctx.canvasId,
      {
        duration: ctx.req.seconds ?? Math.max(3, frames.length * 3),
        fps: ctx.req.fps ?? 30,
        width: ctx.req.width ?? 1920,
        height: ctx.req.height ?? 1080,
        tracks: [],
      },
      ctx.pageId,
      ctx.actor,
    )
    ctx.run.effectiveWrites++
    const comp = compOf(ctx)
    if (comp) ctx.run.lastWrittenRevision = comp.revision
  }
}

/** the names-only vocabulary the plan brief carries */
function vocabulary(): string {
  const names = (data: unknown, key: string): string[] => {
    const list = (data as Record<string, unknown>)?.[key]
    if (!Array.isArray(list)) return []
    return list
      .map((item) =>
        typeof item === 'string' ? item : ((item as { id?: string }).id ?? (item as { kind?: string }).kind),
      )
      .filter((v): v is string => typeof v === 'string')
  }
  const motion = listMotionPresets().ok ? listMotionPresets() : undefined
  const elements = listElementPresets()
  const looks = listLooks()
  const effects = listMotionEffects()
  const parts: string[] = []
  if (motion && 'data' in motion) {
    parts.push(`camera presets: ${names(motion.data, 'camera_presets').join(', ')}`)
    parts.push(`transitions: ${names(motion.data, 'transitions').join(', ')}`)
    parts.push(`text animators: ${names(motion.data, 'text_animators').join(', ')}`)
  }
  if (elements.ok) parts.push(`element presets: ${names(elements.data, 'presets').join(', ')}`)
  if (looks.ok) parts.push(`looks: ${names(looks.data, 'looks').join(', ')}`)
  if (effects.ok) {
    const list = (effects.data as { effects?: { id: string; family?: string }[] }).effects ?? []
    parts.push(`effects: ${list.map((e) => `${e.id}${e.family ? ` (${e.family})` : ''}`).join(', ')}`)
  }
  return parts.join('\n')
}

/** build: the first film — animate_storyboard with the Direction the plan
 *  stage left on the composition */
async function enterBuild(ctx: Ctx) {
  const canvas = (await store.load(ctx.canvasId)) ?? store.getCanvas(ctx.canvasId)
  if (!canvas) throw new Error('canvas not found')
  const comp = compOf(ctx)
  const before = filmSig(ctx)
  const out = await animateStoryboard(
    canvas,
    ctx.pageId,
    {
      ...(ctx.req.seconds ? { shot_seconds: ctx.req.seconds / Math.max(1, ctx.shotInfo.size || 1) } : {}),
      ...(ctx.req.fps ? { fps: ctx.req.fps } : {}),
      ...(ctx.req.width ? { width: ctx.req.width } : {}),
      ...(ctx.req.height ? { height: ctx.req.height } : {}),
      ...(ctx.req.frameIds?.length ? { frame_ids: ctx.req.frameIds } : {}),
      ...(comp?.direction ? { direction: comp.direction } : {}),
    },
    ctx.actor,
  )
  const after = filmSig(ctx)
  ledger(ctx, { tool: 'animate_storyboard', input: { server: 'build-entry' }, before, after })
  if (!out.ok) pushIssue(ctx, 'build', `animate_storyboard failed: ${out.error}`)
  /* the storyboard's shots describe their windows */
  ctx.shots = shotWindows(ctx)
}

/** refine: contact sheet (stored, its id on the pass) + the machine rubric */
async function enterRefine(ctx: Ctx) {
  const canvas = store.getCanvas(ctx.canvasId)
  if (!canvas) return
  const snap = await directorDeps.sceneSnapshot(canvas, ctx.pageId, { auto: 'beats' })
  if (snap.ok) {
    const png = (snap.data as { png?: string }).png
    if (typeof png === 'string' && png.length > 100) {
      try {
        const asset = await directorDeps.storeSheet(png, {
          canvasId: ctx.canvasId,
          ...(ctx.run.ownerId ? { ownerId: ctx.run.ownerId } : {}),
          uploadedBy: ctx.actor.name,
        })
        ctx.sheetAssetId = asset.id
      } catch {
        /* a sheet that cannot be stored still shows in the result; it just
           never lands on the pass record */
      }
    }
  }
  const checked = await directorDeps.checkScene(canvas, ctx.pageId, { pixels: false })
  ctx.lastCheck = checked.ok ? (checked.data as Record<string, unknown>) : undefined
}

/* ---------------------------------------------------------------- */
/* the stage machine                                                 */
/* ---------------------------------------------------------------- */

async function recordPass(ctx: Ctx): Promise<{ stop: boolean; reason?: string; rec: PassRecord }> {
  const canvas = store.getCanvas(ctx.canvasId)
  const checked = canvas ? await directorDeps.checkScene(canvas, ctx.pageId, { pixels: false }) : undefined
  const machine = checked?.ok
    ? await directorDeps.machineRubric(checked.data as CheckReport)
    : { blockers: 0, majors: 0 }
  const modelMajors = (ctx.passIssues ?? []).filter((i) => i.severity === 'major').length
  const scores = ctx.passScores ? Object.values(ctx.passScores) : []
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined
  const comp = compOf(ctx)
  const signature = filmSig(ctx)
  const rec: PassRecord = {
    index: ctx.run.pass,
    ...(ctx.sheetAssetId ? { sheetAssetId: ctx.sheetAssetId } : {}),
    blockers: machine.blockers,
    majors: machine.majors + modelMajors,
    ...(meanScore !== undefined ? { meanScore } : {}),
    ...(ctx.passIssues?.length ? { issues: ctx.passIssues } : {}),
    signature,
    ...(comp ? { revision: comp.revision } : {}),
    startedAt: ctx.passStartedAt,
    endedAt: directorDeps.now(),
  }
  ctx.run.passes.push(rec)
  const decision = refineStop({
    blockers: machine.blockers,
    majors: modelMajors,
    meanScore,
    passCount: ctx.run.pass,
    maxPasses: ctx.run.maxPasses,
    signature,
    boundaries: ctx.boundaries,
  })
  return { ...decision, rec }
}

async function advanceStage(ctx: Ctx, why: 'end_stage' | 'budget' | 'implicit') {
  const run = ctx.run
  /* leaving a gated stage with unmet items files them as open issues */
  if (why !== 'end_stage') {
    for (const unmet of gateFor(ctx).unmet) pushIssue(ctx, run.stage, unmet)
  }
  if (run.stage === 'plan') {
    run.stage = 'build'
    ctx.stageSpent = 0
    ctx.seen.clear()
    ctx.nudged = 0
    await enterBuild(ctx)
  } else if (run.stage === 'build') {
    run.stage = 'refine'
    run.pass = 1
    ctx.stageSpent = 0
    ctx.seen.clear()
    ctx.nudged = 0
    ctx.passStartedAt = directorDeps.now()
    ctx.boundaries.push(filmSig(ctx))
    await enterRefine(ctx)
  } else if (run.stage === 'refine') {
    const { stop } = await recordPass(ctx)
    if (stop) {
      /* stop reasons are convergence signals, not gate items — they never
         file as open issues */
      run.stage = 'finish'
      run.pass = 0
      ctx.done = true
    } else {
      run.pass++
      ctx.stageSpent = 0
      ctx.seen.clear()
      ctx.nudged = 0
      ctx.passScores = undefined
      ctx.passIssues = undefined
      ctx.sheetAssetId = undefined
      ctx.passStartedAt = directorDeps.now()
      ctx.boundaries.push(filmSig(ctx))
      await enterRefine(ctx)
    }
  }
  ctx.pendingBrief = ctx.done ? undefined : composeBrief(ctx)
  ctx.stageChanged = true
  touchDirectorRun(run, { force: true })
}

/** the stage's user message: fixed text + the ask + Direction + the film
 *  outline + open issues + the call budget */
function composeBrief(ctx: Ctx): string {
  const { run, req } = ctx
  const parts: string[] = [DIRECTOR[run.stage === 'finish' ? 'finish' : run.stage]]
  const ask: string[] = []
  ask.push(`${req.seconds ? `${req.seconds}s` : 'a film'} on page ${ctx.pageId}`)
  if (req.width || req.height) ask.push(`${req.width ?? '?'}×${req.height ?? '?'}`)
  if (req.fps) ask.push(`${req.fps}fps`)
  ask.push(`freedom ${req.freedom ?? 'balanced'}`)
  ask.push(`mode ${req.mode ?? 'fresh'}`)
  parts.push(`Ask: ${ask.join(' · ')}`)
  if (req.note) parts.push(`Note from the asker (intent, not a script): ${req.note}`)
  const comp = compOf(ctx)
  if (comp?.direction && run.stage !== 'plan') {
    parts.push(`Direction:\n${JSON.stringify(comp.direction)}`)
  }
  if (run.stage === 'plan' && ctx.shotDigest) {
    parts.push(`Storyboard digest:\n${ctx.shotDigest}`)
    parts.push(`Vocabulary:\n${vocabulary()}`)
  }
  if (run.stage !== 'plan') {
    parts.push(`Film:\n${compositionOutline(comp)}`)
  }
  if (run.stage === 'refine') {
    if (ctx.sheetAssetId) parts.push(`Contact sheet for this pass: /a/${ctx.sheetAssetId}.png`)
    if (ctx.lastCheck) parts.push(`Machine rubric at pass start:\n${JSON.stringify(ctx.lastCheck).slice(0, 4_000)}`)
    if (!ctx.model.vision) parts.push('This model cannot see images — judge on the numbers alone. One pass.')
  }
  if (run.openIssues.length) {
    parts.push(`Open issues:\n${run.openIssues.map((i) => `- [${i.stage}] ${i.text}`).join('\n')}`)
  }
  parts.push(
    `Budget: this stage ${stageBudget(ctx)} calls · run ${Math.max(0, run.budgets.run - run.spent.calls)} of ${run.budgets.run} left` +
      (run.stage === 'refine' ? ` · pass ${run.pass}/${run.maxPasses}` : ''),
  )
  return parts.join('\n\n')
}

/* ---------------------------------------------------------------- */
/* the paid filings                                                  */
/* ---------------------------------------------------------------- */

async function paidKey(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<string | undefined> {
  const { speechEffectiveKey } = await import('./speechTools.ts')
  const { videoEffectiveKey, renderEffectiveKey } = await import('./motionTools.ts')
  const { blenderEffectiveKey } = await import('./blenderTools.ts')
  const key =
    name === 'generate_voiceover' || name === 'transcribe_clip'
      ? speechEffectiveKey(name, input, ctx.pageId)
      : name === 'generate_video'
        ? videoEffectiveKey(input, ctx.pageId)
        : name === 'render_composition'
          ? renderEffectiveKey(input, ctx.pageId, compOf(ctx)?.revision ?? 0)
          : name === 'blender_render_frame'
            ? blenderEffectiveKey(name, input, ctx.pageId)
            : name === 'generate_image'
              ? directorKey({
                  tool: name,
                  pageId: ctx.pageId,
                  prompt: String(input.prompt ?? '').trim(),
                  aspect: input.aspect ?? 'square',
                  quality: input.quality,
                })
              : undefined
  return key
}

/* ---------------------------------------------------------------- */
/* wait_for_job — shared with execTool's ordinary-run case           */
/* ---------------------------------------------------------------- */

export async function waitForJob(
  kind: string,
  jobId: string,
  canvasId: string,
  timeoutMs: number,
  deps: Pick<typeof directorDeps, 'jobState' | 'sleep' | 'now'> = directorDeps,
): Promise<{ text: string; waitMs: number; overBudget: boolean }> {
  const t0 = deps.now()
  while (true) {
    const s = await deps.jobState(kind as DirectorJobKind, jobId, canvasId)
    if (!s.found) return { text: `no ${kind} job ${jobId} on this canvas`, waitMs: deps.now() - t0, overBudget: false }
    if (s.state !== 'queued' && s.state !== 'running') {
      return {
        text: `${kind} job ${jobId}: ${s.state}${s.detail?.error ? ` — ${s.detail.error}` : ''}`,
        waitMs: deps.now() - t0,
        overBudget: false,
      }
    }
    if (deps.now() - t0 >= timeoutMs) break
    await deps.sleep(Math.min(2_000, timeoutMs - (deps.now() - t0)))
  }
  return {
    text: `${kind} job ${jobId} still running`,
    waitMs: deps.now() - t0,
    overBudget: true,
  }
}

/* ---------------------------------------------------------------- */
/* the wrapped call — one call charged for every call, run or refused */
/* ---------------------------------------------------------------- */

async function wrappedCall(ctx: Ctx, block: Anthropic.ToolUseBlockParam): Promise<Anthropic.ToolResultBlockParam> {
  const { run } = ctx
  const t0 = directorDeps.now()
  const refuse = (msg: string, kind: 'repeat' | 'paid' | 'allowlist' | 'ceiling') => {
    charge(ctx)
    const streak = (ctx.refusals.get(block.name) ?? 0) + 1
    ctx.refusals.set(block.name, streak)
    let extra = ''
    if (streak >= 5) {
      const schema = ctx.tools.find((t) => t.name === block.name)?.input_schema
      if (schema) extra = `\n\n${block.name} takes:\n${JSON.stringify(schema)}`
    }
    ledger(ctx, { tool: block.name, input: block.input, before: '', after: '', refused: kind })
    chargeTime(ctx, directorDeps.now() - t0)
    return withFooter(ctx, failRes(block.id, msg), extra || undefined)
  }

  /* 1 — stopped runs answer immediately and run nothing */
  if (ctx.canceled()) return failRes(block.id, 'This run has been stopped.')

  /* 2 — the run ceiling: calls, active time, input tokens */
  if (
    run.spent.calls >= run.budgets.run ||
    run.spent.activeMs >= DIRECTOR_LIMITS.MAX_ACTIVE_MS ||
    run.spent.inputTokens >= DIRECTOR_LIMITS.MAX_INPUT_TOKENS
  ) {
    ctx.ceiling = true
    ctx.grace++
    if (ctx.grace > DIRECTOR_LIMITS.GRACE_CALLS) {
      ctx.aborted = true
      ctx.abort.abort()
    }
    ctx.done = true
    run.stage = 'finish'
    return failRes(block.id, 'Budget spent. Write your summary now.')
  }

  /* 3 — the stage budget spent: advance, then this call runs under the new
     stage's rules */
  if (run.stage !== 'finish' && ctx.stageSpent >= stageBudget(ctx)) {
    await advanceStage(ctx, 'budget')
    if (ctx.done) {
      charge(ctx)
      ledger(ctx, { tool: block.name, input: block.input, before: '', after: '', refused: 'ceiling' })
      chargeTime(ctx, directorDeps.now() - t0)
      return failRes(block.id, 'The run is over — write your summary in plain text.')
    }
  }

  /* 4 — the stage's allowlist */
  if (!stageAllowlist(run.stage, run.pass).has(block.name)) {
    return refuse(`${block.name} is not available in the ${run.stage} stage`, 'allowlist')
  }

  /* 5 — end_stage and wait_for_job are the wrapper's own */
  if (block.name === 'end_stage') {
    charge(ctx)
    const input = (block.input ?? {}) as { summary?: string; skipped?: { frame_id?: string; reason?: string }[] }
    if (Array.isArray(input.skipped)) {
      run.skippedShots = run.skippedShots ?? {}
      for (const s of input.skipped) {
        if (typeof s?.frame_id === 'string') run.skippedShots[s.frame_id] = String(s.reason ?? 'skipped')
      }
    }
    const gate = gateFor(ctx)
    if (!gate.pass) {
      chargeTime(ctx, directorDeps.now() - t0)
      ledger(ctx, { tool: 'end_stage', input: block.input, before: '', after: '' })
      return withFooter(
        ctx,
        failRes(block.id, `the ${run.stage} gate is not met:\n${gate.unmet.map((u) => `- ${u}`).join('\n')}`),
      )
    }
    await advanceStage(ctx, 'end_stage')
    chargeTime(ctx, directorDeps.now() - t0)
    ledger(ctx, { tool: 'end_stage', input: block.input, before: '', after: '' })
    return withFooter(ctx, ok(block.id, 'stage complete'), ctx.done ? undefined : ctx.pendingBrief)
  }

  if (block.name === 'wait_for_job') {
    charge(ctx)
    const input = (block.input ?? {}) as { kind?: string; job_id?: string; timeout_s?: number }
    const kind = String(input.kind ?? '')
    const jobId = String(input.job_id ?? '')
    if (!['speech', 'video', 'blender', 'render'].includes(kind) || !jobId) {
      chargeTime(ctx, directorDeps.now() - t0)
      return refuse("wait_for_job takes { kind: 'speech'|'video'|'blender'|'render', job_id, timeout_s? }", 'allowlist')
    }
    const timeoutMs = Math.min(DIRECTOR_LIMITS.WAIT_CALL_MS, Math.max(5_000, (Number(input.timeout_s) || 90) * 1_000))
    const result = await waitForJob(kind, jobId, ctx.canvasId, timeoutMs)
    const total = (ctx.jobWait.get(`${kind}:${jobId}`) ?? 0) + result.waitMs
    ctx.jobWait.set(`${kind}:${jobId}`, total)
    const over = total >= DIRECTOR_LIMITS.WAIT_JOB_MS
    chargeTime(ctx, directorDeps.now() - t0 - result.waitMs)
    ledger(ctx, { tool: 'wait_for_job', input: block.input, before: '', after: '' })
    return withFooter(ctx, ok(block.id, `${result.text}${over ? ' — go on without it' : ''}`))
  }

  /* 6 — exact-repeat guard: same tool, same input, the target still in the
     state the earlier identical call left it (or unchanged since an
     ineffective one) → replay the earlier result */
  const inputKey = canonicalJson(block.input ?? {})
  const canvas = store.getCanvas(ctx.canvasId)
  const before = canvas ? targetSignature(block.name, (block.input ?? {}) as Record<string, unknown>, canvas) : ''
  const seenKey = `${block.name}\n${inputKey}`
  const seen = ctx.seen.get(seenKey)
  if (seen && seen.after === before) {
    charge(ctx)
    chargeTime(ctx, directorDeps.now() - t0)
    ledger(ctx, { tool: block.name, input: block.input, before, after: before, refused: 'repeat' })
    return withFooter(ctx, { ...seen.result, tool_use_id: block.id }, 'Identical call, nothing changed since.')
  }

  /* 7 — paid filings: the card's paid gate, then the effective-key dedupe */
  if (PAID_TOOLS.has(block.name)) {
    const paid = ctx.req.paid
    if (!paid?.enabled) {
      return refuse(`${block.name} is a paid generation — this card did not enable paid tools`, 'paid')
    }
    if (paid.maxCalls !== undefined && ctx.paidCount >= paid.maxCalls) {
      return refuse(`the card's paid call cap (${paid.maxCalls}) is spent`, 'paid')
    }
    const key = await paidKey(ctx, block.name, (block.input ?? {}) as Record<string, unknown>)
    if (key) {
      const first = ctx.paid.get(key)
      if (first) {
        charge(ctx)
        chargeTime(ctx, directorDeps.now() - t0)
        ledger(ctx, { tool: block.name, input: block.input, before, after: before, refused: 'paid' })
        return withFooter(
          ctx,
          { ...first, tool_use_id: block.id },
          'Identical filing — the earlier call already filed this job.',
        )
      }
      /* remembered after execution, so a failed filing is not sticky */
      const execResult = await ctx.exec(block, ctx.canvasId, ctx.actor, ctx.runState)
      const canvasAfter = store.getCanvas(ctx.canvasId)
      const after = canvasAfter
        ? targetSignature(block.name, (block.input ?? {}) as Record<string, unknown>, canvasAfter)
        : ''
      charge(ctx)
      ledger(ctx, { tool: block.name, input: block.input, before, after })
      if (!execResult.is_error) {
        ctx.paid.set(key, execResult)
        ctx.paidCount++
        ctx.refusals.delete(block.name)
      }
      ctx.seen.set(seenKey, { after, effective: before !== after, result: execResult })
      chargeTime(ctx, directorDeps.now() - t0)
      /* a budget-advance mid-call: the harness's brief travels in results */
      return withFooter(ctx, execResult, ctx.stageChanged ? ctx.pendingBrief : undefined)
    }
  }

  /* 8 — execute */
  const res = await ctx.exec(block, ctx.canvasId, ctx.actor, ctx.runState)
  const canvasAfter = store.getCanvas(ctx.canvasId)
  const after = canvasAfter
    ? targetSignature(block.name, (block.input ?? {}) as Record<string, unknown>, canvasAfter)
    : ''
  charge(ctx)
  ledger(ctx, { tool: block.name, input: block.input, before, after })
  ctx.seen.set(seenKey, { after, effective: before !== after, result: res })
  if (!res.is_error) ctx.refusals.delete(block.name)

  /* critique_scene's model-filed scores/issues feed the pass record */
  if (block.name === 'critique_scene' && !res.is_error) {
    try {
      const data = JSON.parse(typeof res.content === 'string' ? res.content : 'null') as {
        scores?: Record<string, number>
        model?: { issues?: { severity: string; fix: string; at?: number; on?: string }[] }
      } | null
      if (data?.scores) ctx.passScores = data.scores
      if (data?.model?.issues) ctx.passIssues = data.model.issues
    } catch {
      /* a non-JSON critique still counts its call */
    }
  }

  chargeTime(ctx, directorDeps.now() - t0)
  /* a budget-advance mid-call: the harness's brief travels in results */
  return withFooter(ctx, res, ctx.stageChanged ? ctx.pendingBrief : undefined)
}

/* ---------------------------------------------------------------- */
/* the two model paths                                               */
/* ---------------------------------------------------------------- */

function syncTokens(
  ctx: Ctx,
  usage:
    { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
) {
  if (!usage) return
  ctx.run.spent.inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** API path: each stage's first request carries exactly the one brief
 *  message; turns accumulate only inside the stage (AC-13). */
async function apiLoop(ctx: Ctx) {
  const run = ctx.run
  while (!ctx.done && !ctx.canceled() && !ctx.aborted) {
    const brief = ctx.pendingBrief
    ctx.pendingBrief = undefined
    if (!brief || run.stage === 'finish') break
    const allowed = stageAllowlist(run.stage, run.pass)
    const tools = ctx.tools.filter((t) => allowed.has(t.name))
    /* exactly one message at the stage boundary (AC-13) */
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: brief }]
    ctx.nudged = 0
    while (!ctx.done && !ctx.canceled() && !ctx.aborted && !ctx.stageChanged) {
      const res = await retryModelTurn(
        () =>
          ctx.model.run({
            maxTokens: 16_000,
            system: [{ text: ctx.system, cache: true }],
            tools,
            messages,
            signal: ctx.abort.signal,
          }),
        {
          isCanceled: ctx.canceled,
          onRetry: (attempt) =>
            console.warn(`[director] model connection interrupted run=${ctx.run.id} retry=${attempt}`),
        },
      )
      syncTokens(ctx, res.usage)
      messages.push({ role: 'assistant', content: res.content })
      const uses = res.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => (b as { type?: string }).type === 'tool_use',
      )
      if (uses.length === 0) {
        /* a bare-text turn asks to end the stage: pass the gate once, then
           force the advance rather than loop a silent model forever */
        const gate = gateFor(ctx)
        if (gate.pass || ctx.nudged >= 1) {
          await advanceStage(ctx, 'implicit')
          break
        }
        ctx.nudged++
        messages.push({
          role: 'user',
          content: `the ${run.stage} gate is not met:\n${gate.unmet.map((u) => `- ${u}`).join('\n')}\ncall end_stage when it is`,
        })
        continue
      }
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of uses) {
        /* a stage change mid-batch still answers every queued tool_use so
           the transcript never splits a use from its result */
        results.push(
          ctx.stageChanged || ctx.done || ctx.aborted
            ? failRes(block.id, 'the stage ended — this call did not run')
            : await wrappedCall(ctx, block),
        )
      }
      messages.push({ role: 'user', content: results })
      if (ctx.stageChanged || ctx.done) break
    }
    ctx.stageChanged = false
  }
}

/** harness path: one prompt, stage briefs arrive inside end_stage results */
async function harnessLoop(ctx: Ctx) {
  const prompt = `${ctx.pendingBrief}\n\nThe brief of each next stage arrives in the result of end_stage.`
  ctx.pendingBrief = undefined
  const result = await ctx.model.runHarness!({
    canvasId: ctx.canvasId,
    prompt,
    system: ctx.system,
    tools: ctx.tools,
    maxTurns: ctx.run.budgets.run + DIRECTOR_LIMITS.GRACE_CALLS + 10,
    isCanceled: () => ctx.canceled() || ctx.aborted,
    signal: ctx.abort.signal,
    execute: (block) => wrappedCall(ctx, block),
  })
  ctx.harnessText = result.text
  syncTokens(
    ctx,
    result.usage?.reduce(
      (a, u) => ({
        inputTokens: a.inputTokens + (u.inputTokens ?? 0),
        outputTokens: a.outputTokens + (u.outputTokens ?? 0),
        cacheReadTokens: a.cacheReadTokens + (u.cacheReadTokens ?? 0),
        cacheWriteTokens: a.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ),
  )
}

/* ---------------------------------------------------------------- */
/* finish — server only                                              */
/* ---------------------------------------------------------------- */

/** a later pass with more machine blockers restores the best earlier pass —
 *  only while the film's revision is still this run's own write (AC-12) */
async function restoreBestPass(ctx: Ctx) {
  const run = ctx.run
  const last = run.passes[run.passes.length - 1]
  if (!last) return
  let best = last
  for (const p of run.passes) if (p.blockers < best.blockers) best = p
  if (best === last || last.blockers <= best.blockers || best.revision === undefined) return
  const comp = compOf(ctx)
  if (!comp || run.lastWrittenRevision === undefined || comp.revision !== run.lastWrittenRevision) return
  const versions = await directorDeps.versions(ctx.canvasId, comp.id)
  const version = versions.find((v) => v.state.revision === best.revision)
  if (!version) return
  const got = await directorDeps.versionState(ctx.canvasId, version.id)
  if (!got) return
  const {
    id: _id,
    revision: _r,
    createdAt: _c,
    updatedAt: _u,
    updatedBy: _b,
    canvasId: _cv,
    pageId: _p,
    ...body
  } = got.state as Composition & { canvasId?: string; pageId?: string }
  actions.setComposition(ctx.canvasId, body, ctx.pageId, ctx.actor)
  const restored = compOf(ctx)
  if (restored) run.lastWrittenRevision = restored.revision
  pushIssue(ctx, 'finish', `restored pass ${best.index} — the last pass left more blockers`)
}

async function finishRun(ctx: Ctx): Promise<string> {
  const { run } = ctx
  run.stage = 'finish'
  /* a user stop posts nothing; the budget-ceiling abort still lands in
     finish and settles on the film's own verdict */
  const stoppedEarly = ctx.canceled()
  /* the machine rubric on the delivered film */
  const canvas = store.getCanvas(ctx.canvasId)
  const checked = canvas ? await directorDeps.checkScene(canvas, ctx.pageId, { pixels: false }) : undefined
  const lintErrors = checked?.ok
    ? (((checked.data as Record<string, unknown>).lint as { errors?: number })?.errors ?? 0)
    : 0
  if (!stoppedEarly) await restoreBestPass(ctx)
  const v = verdict({
    effectiveWrites: run.effectiveWrites,
    lintErrors,
    openIssues: run.openIssues,
    stopped: stoppedEarly,
  })
  run.status = v.status
  if (v.reason) run.reason = v.reason
  run.endSig = filmSig(ctx)
  run.endedAt = directorDeps.now()

  if (run.status === 'stopped') {
    touchDirectorRun(run, { force: true })
    return ''
  }

  /* one no-tools turn for the summary (API); the harness's closing text is
     the summary */
  let summary = ctx.harnessText ?? ''
  if (!ctx.model.runHarness) {
    try {
      const res = await retryModelTurn(
        () =>
          ctx.model.run({
            maxTokens: 4_000,
            system: [{ text: ctx.system, cache: true }],
            tools: [],
            messages: [{ role: 'user', content: composeBrief(ctx) }],
            signal: ctx.abort.signal,
          }),
        {
          isCanceled: ctx.canceled,
          onRetry: (attempt) =>
            console.warn(`[director] model connection interrupted run=${ctx.run.id} summary retry=${attempt}`),
        },
      )
      syncTokens(ctx, res.usage)
      summary = res.content
        .filter((b): b is Anthropic.TextBlockParam => (b as { type?: string }).type === 'text')
        .map((b) => b.text)
        .join('\n')
    } catch {
      summary = ''
    }
  }
  if (run.openIssues.length) {
    summary = `Open issues: ${run.openIssues.map((i) => i.text).join('; ')}.${summary ? `\n${summary}` : ''}`
  }
  if (!summary.trim()) summary = run.reason ?? 'The run ended without a summary.'
  if (run.status === 'failed') {
    actions.failCard(ctx.canvasId, ctx.card.id, run.reason ?? 'the director run failed')
  } else {
    actions.agentSummary(ctx.canvasId, ctx.actor, summary)
    actions.advanceCard(ctx.canvasId, ctx.card.id, ctx.actor)
  }
  touchDirectorRun(run, { force: true })
  return summary
}

/* ---------------------------------------------------------------- */
/* runDirector — the entry runAgent calls                            */
/* ---------------------------------------------------------------- */

export async function runDirector(opts: DirectorOptions): Promise<boolean> {
  const { canvasId, card, model, meter } = opts
  const req = card.animate ?? { pageId: '' }
  const pageId = req.pageId
  await store.load(canvasId)
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !canvasPages(canvas).some((p) => p.id === pageId)) {
    actions.failCard(canvasId, card.id, `page ${pageId} is not on this canvas`)
    return false
  }

  const vision = model.vision !== false
  /* a refine card on a page with no film runs as fresh */
  const compExists = !!store.getComposition(canvasId, pageId)
  const mode: 'fresh' | 'refine' = req.mode === 'refine' && compExists ? 'refine' : 'fresh'
  const shotCount = pageFrames(canvas, pageId).length
  const maxPasses = vision ? Math.min(Math.max(1, req.passes ?? 3), 5) : 1
  const budgets = stageBudgets(shotCount, maxPasses, req.freedom ?? 'balanced')

  const runState: RunState = {
    mutatedFrames: new Set(),
    sourceFrames: new Set(),
    verificationFrames: new Set(),
    verifiedFrames: new Set(),
    rewriteDrafts: new Map(),
    lintResults: new Map(),
    vision,
    ...(model.userId ? { payerId: model.userId } : {}),
    ...(card.queuedByUserId ? { askerId: card.queuedByUserId } : {}),
    imagesGenerated: 0,
    repliedThreads: new Set(),
    awaitingThreads: new Set(),
    tokenWrites: 0,
    arrangeWrites: 0,
  }

  const run: DirectorRun = {
    id: `dir-${nanoid(10)}`,
    canvasId,
    pageId,
    taskId: card.id,
    ownerId: opts.payer,
    ...(card.queuedByUserId ? { askerId: card.queuedByUserId } : {}),
    agent: opts.role.name,
    ...(card.runner ? { runner: card.runner } : {}),
    mode,
    status: 'running',
    stage: mode === 'refine' ? 'refine' : 'plan',
    pass: mode === 'refine' ? 1 : 0,
    maxPasses,
    budgets,
    spent: { calls: 0, inputTokens: 0, activeMs: 0, byStage: { plan: 0, build: 0, refine: [], finish: 0 } },
    passes: [],
    openIssues: [],
    startSig: 'none',
    effectiveWrites: 0,
    startedAt: directorDeps.now(),
    ledger: [],
  }

  const ctx: Ctx = {
    ...opts,
    req,
    pageId,
    run,
    runState,
    stageSpent: 0,
    boundaries: [],
    seen: new Map(),
    paid: new Map(),
    paidCount: 0,
    refusals: new Map(),
    jobWait: new Map(),
    stageChanged: false,
    done: false,
    ceiling: false,
    grace: 0,
    aborted: false,
    nudged: 0,
    passStartedAt: directorDeps.now(),
    shots: [],
    shotInfo: new Map(),
  }

  try {
    /* stage entry is server work — then the signature the film starts from */
    if (mode === 'refine') {
      ctx.passStartedAt = directorDeps.now()
      await enterRefine(ctx)
      ctx.boundaries.push(filmSig(ctx))
    } else {
      await enterPlan(ctx)
    }
    run.startSig = filmSig(ctx)
    ctx.pendingBrief = composeBrief(ctx)
    insertDirectorRun(run)
    registerAgentRun(meter.id, run)

    if (model.runHarness) await harnessLoop(ctx)
    else await apiLoop(ctx)

    await finishRun(ctx)
    return run.status === 'delivered' || run.status === 'delivered_with_issues'
  } catch (err) {
    /* a run that throws still settles: failed with the real reason */
    run.status = 'failed'
    run.reason = err instanceof Error ? err.message : 'the director run failed'
    run.endSig = filmSig(ctx)
    run.endedAt = directorDeps.now()
    if (!ctx.canceled()) actions.failCard(canvasId, card.id, run.reason)
    touchDirectorRun(run, { force: true })
    return false
  } finally {
    unregisterAgentRun(meter.id)
  }
}
