import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The director run on a scripted model: persist is stubbed, the model's
   turns are queued blocks, and execTool runs the real write path. Each test
   drives runDirector the way resident.ts does after takeAnimateCard. */

const mocks = vi.hoisted(() => ({
  saveDirectorRun: vi.fn(),
}))

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
  deleteComposition: () => {},
  loadFrameHtml: async () => [],
  saveDirectorRun: mocks.saveDirectorRun,
  listCompositionVersions: async () => [],
  getCompositionVersion: async () => undefined,
}))
/* contact sheets never hit disk */
vi.mock('../server/assets.ts', () => ({ storeAsset: async () => ({ id: 'sheet-1' }) }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool, TOOLS } = await import('../server/resident.ts')
const { runDirector, waitForJob, directorDeps } = await import('../server/directorLoop.ts')
const { initDirectorRuns, getDirectorRun, listDirectorRuns, insertDirectorRun, directorRunForTask } =
  await import('../server/directorRuns.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { DEFAULT_ROLE_ID, roleById, roleName } = await import('../shared/agents.ts')
const { DIRECTOR } = await import('../server/guide.ts')

import type Anthropic from '@anthropic-ai/sdk'
import type { AgentModel } from '../server/agentModel.ts'
import type { MeteredRun } from '../server/agentRuns.ts'
import type { Actor, AgentTask } from '../shared/types.ts'
import type { DirectorRun } from '../shared/director.ts'

const AGENT = roleName(DEFAULT_ROLE_ID)
const ROLE = roleById(DEFAULT_ROLE_ID)!

/* a shot frame with pre-stamped element ids — the plan entry reads them as
   animatable targets and nothing needs stamping */
const SHOT = `<!doctype html><html><body>
  <div class="shot">
    <h1 data-doop-id="el-h1">Title</h1>
    <img data-doop-id="el-img" src="a.png" alt="a"/>
  </div>
</body></html>`

const OTHER = `<!doctype html><html><body>
  <div class="shot"><h1 data-doop-id="el-b1">Plan 2</h1></div>
</body></html>`

type Turn = { tools?: { name: string; input?: Record<string, unknown> }[]; text?: string }

/** an API-path model: each call pops one turn; `requests` records the
 *  messages of every model call for the AC-13 assertions */
function scriptedModel(turns: Turn[], requests: Anthropic.MessageParam[][]) {
  let n = 0
  const model: AgentModel = {
    provider: 'test-provider' as never,
    label: 'scripted',
    async run(req) {
      n++
      /* the loop mutates the array between turns — record a snapshot */
      requests.push(structuredClone(req.messages))
      const turn = turns.shift()
      if (!turn || turn.text !== undefined) {
        return {
          content: [{ type: 'text' as const, text: turn?.text ?? 'done' }],
          stop_reason: 'end_turn' as const,
        }
      }
      return {
        content: (turn.tools ?? []).map((t, i) => ({
          type: 'tool_use' as const,
          id: `u-${n}-${i}`,
          name: t.name,
          input: t.input ?? {},
        })),
        stop_reason: 'tool_use' as const,
      }
    },
  }
  return model
}

/** a harness-path model running the same tool list flat through execute() */
function harnessModel(turns: Turn[], calls: { count: number }) {
  const model: AgentModel = {
    provider: 'test-provider' as never,
    label: 'scripted-harness',
    async run() {
      throw new Error('harness models do not take API turns')
    },
    async runHarness(req) {
      let i = 0
      for (const turn of turns) {
        for (const t of turn.tools ?? []) {
          if (req.isCanceled?.()) return { success: false, text: 'stopped' }
          calls.count++
          await req.execute({
            type: 'tool_use',
            id: `h-${i++}`,
            name: t.name,
            input: t.input ?? {},
          } as Anthropic.ToolUseBlockParam)
        }
      }
      return { success: true, text: 'the film is done' }
    },
  }
  return model
}

function meterFor(model: AgentModel): MeteredRun {
  return {
    id: `meter-${Math.random().toString(36).slice(2, 8)}`,
    model,
    usage: () => [],
    finish: async () => ({}) as never,
  }
}

interface RunFixture {
  canvasId: string
  pageId: string
  frameId: string
  frame2: string
  actor: Actor
}

let fx: RunFixture

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  const canvas = store.createCanvas('director-test', 'kevin')
  const actor = actions.resolveActor({ name: AGENT, kind: 'agent' })
  const pageId = canvasPages(canvas)[0]!.id
  const frameId = actions.createFrame(
    canvas.id,
    { name: 'Shot 1', width: 1000, height: 600, html: SHOT, x: 0, y: 0 },
    actor,
    { reveal: false },
  )!.id
  const frame2 = actions.createFrame(
    canvas.id,
    { name: 'Shot 2', width: 1000, height: 600, html: OTHER, x: 1200, y: 0 },
    actor,
    { reveal: false },
  )!.id
  fx = { canvasId: canvas.id, pageId, frameId, frame2, actor }
})

/** queue + claim the animate card the way runAgent does */
function animateCard(req: import('../shared/director.ts').AnimateRequest, title = 'animate the board'): AgentTask {
  const card = actions.addQueuedCard(
    fx.canvasId,
    title,
    'kevin',
    [DEFAULT_ROLE_ID],
    [],
    'u-kevin',
    undefined,
    undefined,
    undefined,
    'animate',
    req,
  )!
  const claimed = actions.takeAnimateCard(fx.canvasId, card.id, AGENT)!
  expect(claimed, 'the animate card claims').toBeTruthy()
  return claimed
}

async function direct(card: AgentTask, model: AgentModel, opts?: { canceled?: () => boolean; exec?: typeof execTool }) {
  const abort = new AbortController()
  const meter = meterFor(model)
  fx.actor.runId = meter.id
  const delivered = await runDirector({
    canvasId: fx.canvasId,
    card,
    role: ROLE,
    payer: 'u-kevin',
    model,
    meter,
    actor: fx.actor,
    canceled: opts?.canceled ?? (() => false),
    abort,
    exec: opts?.exec ?? execTool,
    tools: TOOLS,
    system: DIRECTOR.system,
  })
  const run = listDirectorRuns(fx.canvasId, fx.pageId, 1)[0]
  return { delivered, run, abort }
}

const direction = {
  treatment: 'a slow readable film',
  beats: [
    { seconds: 3, note: 'open on shot one', transition: 'cut' },
    { seconds: 3, note: 'then shot two', transition: 'cut' },
  ],
}

/** one element track per shot frame — the build gate's coverage */
const shotTracks = (frameIds: string[], elements: string[]) =>
  frameIds.map((frameId, i) => ({
    op: 'add_track' as const,
    track: {
      id: `t-${i}`,
      kind: 'element' as const,
      frameId,
      elementId: elements[i],
      keyframes: [
        { id: `k-${i}-a`, property: 'x', t: i * 3, value: 0, easing: { type: 'linear' } },
        { id: `k-${i}-b`, property: 'x', t: i * 3 + 1, value: 40, easing: { type: 'linear' } },
      ],
    },
  }))

describe('runDirector — staged fresh run', () => {
  it('delivers a film through plan → build → refine → finish (AC-13: one message per boundary)', async () => {
    const requests: Anthropic.MessageParam[][] = []
    const model = scriptedModel(
      [
        { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
        { tools: [{ name: 'end_stage' }] },
        {
          tools: [
            {
              name: 'set_composition',
              input: { page_id: fx.pageId, ops: shotTracks([fx.frameId, fx.frame2], ['el-h1', 'el-b1']) },
            },
          ],
        },
        { tools: [{ name: 'end_stage' }] },
        { tools: [{ name: 'end_stage' }] },
      ],
      requests,
    )
    const card = animateCard({ pageId: fx.pageId })
    const { delivered, run } = await direct(card, model)
    expect(run?.status).toBe('delivered')
    expect(delivered).toBe(true)
    /* every stage's first model request carries exactly one message */
    expect(requests[0]!.length).toBe(1)
    const singles = requests.filter((m) => m.length === 1).length
    /* plan brief + build brief + refine brief + the finish summary turn */
    expect(singles).toBe(4)
    /* the ledger saw the effective writes; the card advanced */
    const internal = directorRunForTask(card.id)!
    expect(internal.effectiveWrites).toBeGreaterThan(0)
    expect(store.getComposition(fx.canvasId, fx.pageId)?.direction?.treatment).toBe('a slow readable film')
    expect(card.endedAt).toBeTruthy()
  })

  it('25 identical animate_storyboard calls execute once (AC-3)', async () => {
    const executions = { storyboard: 0 }
    const countingExec: typeof execTool = async (block, canvasId, actor, runState) => {
      if (block.name === 'animate_storyboard') executions.storyboard++
      return execTool(block, canvasId, actor, runState)
    }
    const requests: Anthropic.MessageParam[][] = []
    const turns: Turn[] = [
      { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
      { tools: [{ name: 'end_stage' }] },
      /* build: the server already wrote the storyboard at entry — 25 more
         identical calls must each replay its result */
      ...Array.from({ length: 25 }, () => ({
        tools: [{ name: 'animate_storyboard', input: { page_id: fx.pageId, shot_seconds: 3 } }],
      })),
      { tools: [{ name: 'end_stage' }] },
      { tools: [{ name: 'end_stage' }] },
    ]
    const card = animateCard({ pageId: fx.pageId })
    await direct(card, scriptedModel(turns, requests), { exec: countingExec })
    expect(executions.storyboard).toBe(1)
    /* every repeat is a charged, refused-as-repeat ledger row */
    const internal = directorRunForTask(card.id)!
    const repeats = internal.ledger.filter((e) => e.refused === 'repeat')
    expect(repeats.length).toBe(24)
    const storyboardCalls = internal.ledger.filter((e) => e.tool === 'animate_storyboard')
    expect(storyboardCalls.length).toBe(25 + 1) /* 25 model calls + the build-entry write */
  })

  it('a no-op film save makes no effective write — the run fails (AC-4)', async () => {
    /* a film already exists, and the card is a refine — the run's own stage
       writes are only the storyboard at build entry, which a refine skips */
    actions.setComposition(
      fx.canvasId,
      {
        duration: 6,
        fps: 30,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: 't-clip',
            kind: 'clip',
            clips: [{ id: 'c1', start: 0, duration: 3, source: { type: 'frame', frameId: fx.frameId } }],
          },
        ],
      } as never,
      fx.pageId,
      fx.actor,
    )
    /* an exec that answers ok but never writes anything — the model's save
       leaves the film exactly as it was */
    const noopExec: typeof execTool = async (block) => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify({ ok: true }),
    })
    const requests: Anthropic.MessageParam[][] = []
    const turns: Turn[] = [
      { tools: [{ name: 'set_composition', input: { ops: [] } }] },
      { tools: [{ name: 'end_stage' }] },
    ]
    const card = animateCard({ pageId: fx.pageId, mode: 'refine' })
    const { delivered, run } = await direct(card, scriptedModel(turns, requests), { exec: noopExec })
    expect(delivered).toBe(false)
    expect(run?.status).toBe('failed')
    expect(run?.reason).toContain('no effective write')
    expect(card.failedAt).toBeTruthy()
  })

  it('an A/B toggle loop ends inside the stage budgets (AC-2)', async () => {
    /* the model flips the film's duration back and forth from its first
       call and never plans — the stage budgets, not a watchdog, end it */
    const requests: Anthropic.MessageParam[][] = []
    const turns: Turn[] = Array.from({ length: 80 }, (_, i) => ({
      tools: [
        {
          name: 'set_composition',
          input: { page_id: fx.pageId, ops: [{ op: 'set_meta', duration: i % 2 ? 7 : 6 }] },
        },
      ],
    }))
    const card = animateCard({ pageId: fx.pageId, passes: 1 })
    const { run } = await direct(card, scriptedModel(turns, requests))
    const internal = directorRunForTask(card.id)!
    expect(run && internal.status !== 'running').toBe(true)
    /* plan 10 + build 28 + one refine 18 on two shots — never a turn-200 path */
    expect(internal.spent.calls).toBeLessThanOrEqual(10 + 28 + 18 + 1)
  })

  it('30 distinct effective writes on five shots in build are never refused (AC-6)', async () => {
    const extra = [3, 4, 5].map(
      (i) =>
        actions.createFrame(
          fx.canvasId,
          {
            name: `Shot ${i}`,
            width: 1000,
            height: 600,
            html: `<!doctype html><html><body><h1 data-doop-id="el-s${i}">S${i}</h1></body></html>`,
            x: i * 1200,
            y: 0,
          },
          fx.actor,
          { reveal: false },
        )!.id,
    )
    const frames = [fx.frameId, fx.frame2, ...extra]
    const requests: Anthropic.MessageParam[][] = []
    const turns: Turn[] = [
      { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
      { tools: [{ name: 'end_stage' }] },
      /* 30 distinct writes: one coverage write + 29 distinct durations,
         all beyond the film's span so none truncates its keyframes.
         The build budget on five shots is 52 — none may be refused */
      {
        tools: [
          {
            name: 'set_composition',
            input: {
              page_id: fx.pageId,
              ops: shotTracks(frames, ['el-h1', 'el-b1', 'el-s3', 'el-s4', 'el-s5']),
            },
          },
        ],
      },
      ...Array.from({ length: 29 }, (_, i) => ({
        tools: [
          {
            name: 'set_composition',
            input: { page_id: fx.pageId, ops: [{ op: 'set_meta', duration: 60 + i }] },
          },
        ],
      })),
      { tools: [{ name: 'end_stage' }] },
      { tools: [{ name: 'end_stage' }] },
      { tools: [{ name: 'end_stage' }] },
    ]
    const card = animateCard({ pageId: fx.pageId })
    await direct(card, scriptedModel(turns, requests))
    const internal = directorRunForTask(card.id)!
    const writes = internal.ledger.filter((e) => e.tool === 'set_composition')
    expect(writes.filter((e) => e.refused)).toEqual([])
    expect(writes.filter((e) => e.effective).length).toBe(30)
    expect(internal.effectiveWrites).toBeGreaterThanOrEqual(30)
  })

  it('a stage budget spent with a valid film delivers with issues named first (AC-7)', async () => {
    const summaries: string[] = []
    const spy = vi.spyOn(actions, 'agentSummary').mockImplementation((_c, _a, text) => {
      summaries.push(text)
      return undefined as never
    })
    try {
      const requests: Anthropic.MessageParam[][] = []
      const turns: Turn[] = [
        /* plan: the model reads forever and never sets a Direction — the
           plan budget spends out and the unmet gate items file as issues */
        ...Array.from({ length: 14 }, () => ({ tools: [{ name: 'get_composition', input: { page_id: fx.pageId } }] })),
        /* build: the coverage write, then close the stage */
        {
          tools: [
            {
              name: 'set_composition',
              input: { page_id: fx.pageId, ops: shotTracks([fx.frameId, fx.frame2], ['el-h1', 'el-b1']) },
            },
          ],
        },
        { tools: [{ name: 'end_stage' }] },
        { tools: [{ name: 'end_stage' }] },
      ]
      const card = animateCard({ pageId: fx.pageId })
      const { run } = await direct(card, scriptedModel(turns, requests))
      expect(run?.status).toBe('delivered_with_issues')
      expect(run?.openIssues.length).toBeGreaterThan(0)
      expect(card.endedAt).toBeTruthy()
      expect(summaries[0]?.startsWith('Open issues:')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('equivalent voice-over filings dedupe on the normalized recipe (AC-8)', async () => {
    const filings = { count: 0 }
    const countingExec: typeof execTool = async (block, canvasId, actor, runState) => {
      if (block.name === 'generate_voiceover') {
        filings.count++
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: JSON.stringify({ job: { id: `job-${filings.count}` } }),
        }
      }
      return execTool(block, canvasId, actor, runState)
    }
    const requests: Anthropic.MessageParam[][] = []
    const vo = (extra: Record<string, unknown>) => ({
      tools: [
        { name: 'generate_voiceover', input: { page_id: fx.pageId, voice: 'v1', text: 'Hello world', ...extra } },
      ],
    })
    const turns: Turn[] = [
      { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
      { tools: [{ name: 'end_stage' }] },
      vo({}) /* `at` omitted → default 0 after the schema */,
      vo({ at: 0 }) /* identical recipe → replay, not a second filing */,
      vo({ text: '  Hello world  ' }) /* trimmed to the same recipe */,
      vo({ at: 2 }) /* a different placement files a second job */,
      { tools: [{ name: 'end_stage' }] },
      { tools: [{ name: 'end_stage' }] },
    ]
    const card = animateCard({ pageId: fx.pageId, paid: { enabled: true } })
    await direct(card, scriptedModel(turns, requests), { exec: countingExec })
    expect(filings.count).toBe(2)
    const internal = directorRunForTask(card.id)!
    expect(internal.ledger.filter((e) => e.refused === 'paid').length).toBe(2)
  })

  it('a stopped run returns at once and posts nothing (AC-11)', async () => {
    let stopped = false
    const requests: Anthropic.MessageParam[][] = []
    const turns: Turn[] = [
      { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
      { tools: [{ name: 'end_stage' }] },
      { tools: [{ name: 'set_composition', input: { ops: [] } }] },
    ]
    const card = animateCard({ pageId: fx.pageId })
    const { run } = await direct(card, scriptedModel(turns, requests), {
      canceled: () => {
        /* the stop lands after the first turn — the route's path */
        if (requests.length >= 2 && !stopped) {
          stopped = true
          actions.stopCard(fx.canvasId, card.id, 'kevin')
        }
        return stopped
      },
    })
    expect(run?.status).toBe('stopped')
    expect(card.endedAt).toBeUndefined()
    expect(card.failedAt).toBeTruthy() /* stopCard marks the card */
  })
})

describe('queue isolation (AC-1, AC-10)', () => {
  it('an animate card never joins the ordinary batch; a second one waits on a busy page', () => {
    const ordinary = actions.addQueuedCard(fx.canvasId, 'make it blue', 'kevin', [DEFAULT_ROLE_ID], [], 'u-kevin')!
    const anim = actions.addQueuedCard(
      fx.canvasId,
      'animate it',
      'kevin',
      [DEFAULT_ROLE_ID],
      [],
      'u-kevin',
      undefined,
      undefined,
      undefined,
      'animate',
      { pageId: fx.pageId },
    )!
    /* takeQueuedCardsFor never hands the animate card to an ordinary run */
    const batch = actions.takeQueuedCardsFor(fx.canvasId, AGENT, 'u-kevin', '')
    expect(batch.map((c) => c.id)).toEqual([ordinary.id])
    /* a card that only names animate_storyboard in its text is ordinary */
    const namedOnly = actions.addQueuedCard(
      fx.canvasId,
      'please run animate_storyboard',
      'kevin',
      [DEFAULT_ROLE_ID],
      [],
      'u-kevin',
    )!
    expect(actions.takeQueuedCardsFor(fx.canvasId, AGENT, 'u-kevin', '').map((c) => c.id)).toEqual([namedOnly.id])
    /* the animate card claims only through takeAnimateCard */
    const claimed = actions.takeAnimateCard(fx.canvasId, anim.id, AGENT)!
    expect(claimed.id).toBe(anim.id)
    /* a second animate card on the same page waits while a run is live */
    const anim2 = actions.addQueuedCard(
      fx.canvasId,
      'animate again',
      'kevin',
      [DEFAULT_ROLE_ID],
      [],
      'u-kevin',
      undefined,
      undefined,
      undefined,
      'animate',
      { pageId: fx.pageId },
    )!
    const live = insertDirectorRun({
      id: 'dir-busy',
      canvasId: fx.canvasId,
      pageId: fx.pageId,
      taskId: anim.id,
      ownerId: 'u-kevin',
      agent: AGENT,
      mode: 'fresh',
      status: 'running',
      stage: 'build',
      pass: 0,
      maxPasses: 3,
      budgets: { plan: 10, build: 20, refine: 10, run: 70 },
      spent: { calls: 0, inputTokens: 0, activeMs: 0, byStage: { plan: 0, build: 0, refine: [], finish: 0 } },
      passes: [],
      openIssues: [],
      startSig: 'none',
      effectiveWrites: 0,
      startedAt: Date.now(),
      ledger: [],
    } as DirectorRun)
    expect(actions.takeAnimateCard(fx.canvasId, anim2.id, AGENT)).toBeUndefined()
    /* the page frees when the run ends */
    live.status = 'delivered'
    expect(actions.takeAnimateCard(fx.canvasId, anim2.id, AGENT)?.id).toBe(anim2.id)
  })

  it('a booted running row becomes interrupted and its card fails with the retry reason (AC-11)', async () => {
    const card = animateCard({ pageId: fx.pageId })
    initDirectorRuns([
      {
        id: 'dir-orphan',
        canvasId: fx.canvasId,
        pageId: fx.pageId,
        taskId: card.id,
        ownerId: 'u-kevin',
        agent: AGENT,
        mode: 'fresh',
        status: 'running',
        stage: 'build',
        pass: 0,
        maxPasses: 3,
        budgets: { plan: 10, build: 20, refine: 10, run: 70 },
        spent: { calls: 0, inputTokens: 0, activeMs: 0, byStage: { plan: 0, build: 0, refine: [], finish: 0 } },
        passes: [],
        openIssues: [],
        startSig: 'none',
        effectiveWrites: 0,
        startedAt: Date.now(),
        ledger: [],
      } as DirectorRun,
    ])
    expect(getDirectorRun('dir-orphan')?.status).toBe('interrupted')
    /* failCard lands through a dynamic import — let it settle */
    await new Promise((r) => setTimeout(r, 20))
    expect(card.failedAt).toBeTruthy()
  })
})

describe('wait_for_job', () => {
  it('a running job waits and past the job budget says to go on (AC-5)', async () => {
    let now = 0
    const deps = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
      jobState: async (_kind: string, jobId: string) =>
        jobId === 'job-1' ? { found: true, state: 'running' as const } : { found: false, state: '' },
    }
    /* nine minutes inside one job — six 90 s calls, all "still running" */
    for (let i = 0; i < 6; i++) {
      const out = await waitForJob('render', 'job-1', fx.canvasId, 90_000, deps)
      expect(out.text).toContain('still running')
    }
    expect(now).toBeGreaterThanOrEqual(540_000)
    /* a finished state surfaces at once */
    const done = await waitForJob('render', 'job-1', fx.canvasId, 90_000, {
      ...deps,
      jobState: async () => ({ found: true, state: 'done' as const }),
    })
    expect(done.text).toContain('done')
    const missing = await waitForJob('render', 'nope', fx.canvasId, 90_000, deps)
    expect(missing.text).toContain('no render job')
  })
})

describe('run ceiling (AC-9)', () => {
  it('API and harness paths charge the same calls; the harness is aborted GRACE_CALLS later', async () => {
    /* tiny run: 1 shot + 1 pass → budget = plan 9 + build 20 + refine 14 = 43 */
    const spam: Turn[] = [
      { tools: [{ name: 'end_stage' }] }, // plan out (gate unmet → issues)
      /* build: distinct effective writes — never refused for budget below the cap (AC-6) */
      ...Array.from({ length: 60 }, (_, i) => ({
        tools: [{ name: 'set_composition', input: { ops: [{ op: 'set_meta', duration: i + 1 }] } }],
      })),
    ]
    const apiRequests: Anthropic.MessageParam[][] = []
    const card1 = animateCard({ pageId: fx.pageId, passes: 1 })
    const { run: apiRun } = await direct(
      card1,
      scriptedModel(
        spam.map((t) => ({ ...t })),
        apiRequests,
      ),
    )
    expect(apiRun?.spent.calls).toBeLessThanOrEqual(apiRun!.budgets.run)

    /* same script on the harness */
    const calls = { count: 0 }
    const card2 = animateCard({ pageId: fx.pageId, passes: 1 })
    const { run: harnessRun, abort } = await direct(
      card2,
      harnessModel(
        spam.map((t) => ({ ...t })),
        calls,
      ),
    )
    expect(harnessRun?.spent.calls).toBe(apiRun?.spent.calls)
    /* the harness kept calling past the ceiling until the abort fired */
    expect(calls.count).toBeGreaterThan(harnessRun!.budgets.run)
    expect(abort.signal.aborted).toBe(true)
  })
})

describe('composition regression restore (AC-12)', () => {
  it('restores the best pass when the last pass left more blockers on the run’s own revision', async () => {
    /* a film already exists — a refine card would take one pass, so drive a
       fresh-mode card instead and script two passes */
    actions.setComposition(
      fx.canvasId,
      {
        duration: 6,
        fps: 30,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: 't-clip',
            kind: 'clip',
            clips: [
              { id: 'c1', start: 0, duration: 3, source: { type: 'frame', frameId: fx.frameId } },
              { id: 'c2', start: 3, duration: 3, source: { type: 'frame', frameId: fx.frame2 } },
            ],
          },
        ],
      } as never,
      fx.pageId,
      fx.actor,
    )
    /* checkScene stub: blockers per call — pass-end calls are #2, #4, #6;
       the finish call (#7) reports clean. pass ends land blockers 0, 2, 1
       → pass 1 is best, pass 3 is last → restore pass 1. */
    let checks = 0
    const lintSeq = [0, 0, 0, 2, 0, 1, 0]
    const realCheck = directorDeps.checkScene
    directorDeps.checkScene = async () => ({
      ok: true as const,
      data: {
        lint: { errors: lintSeq[Math.min(checks++, lintSeq.length - 1)] ?? 0, warnings: 0 },
        pacing: { dead_beats: [], shot_seconds: { min: 3, max: 3, variance: 0 } },
        legibility: {},
        safe_zones: {},
        effects: { over_budget: false, unsupported: [] },
      },
    })
    const realVersions = directorDeps.versions
    const realVersionState = directorDeps.versionState
    directorDeps.versions = async () =>
      Array.from({ length: 200 }, (_, i) => ({ id: `v-${i}`, state: { revision: i } }) as never)
    directorDeps.versionState = async () =>
      ({
        id: 'v-best',
        state: {
          duration: 7,
          fps: 30,
          width: 1920,
          height: 1080,
          tracks: [
            {
              id: 't-clip',
              kind: 'clip',
              clips: [
                { id: 'c1', start: 0, duration: 3, source: { type: 'frame', frameId: fx.frameId } },
                { id: 'c2', start: 3, duration: 3, source: { type: 'frame', frameId: fx.frame2 } },
              ],
            },
          ],
        },
      }) as never
    try {
      const requests: Anthropic.MessageParam[][] = []
      const turns: Turn[] = [
        { tools: [{ name: 'set_direction', input: { page_id: fx.pageId, direction } }] },
        { tools: [{ name: 'end_stage' }] },
        {
          tools: [
            {
              name: 'set_composition',
              input: { page_id: fx.pageId, ops: shotTracks([fx.frameId, fx.frame2], ['el-h1', 'el-b1']) },
            },
          ],
        },
        { tools: [{ name: 'end_stage' }] },
        /* refine 1: an effective write then end_stage — pass recorded with 0 blockers */
        { tools: [{ name: 'set_composition', input: { page_id: fx.pageId, ops: [{ op: 'set_meta', duration: 7 }] } }] },
        { tools: [{ name: 'end_stage' }] },
        /* refine 2 */
        { tools: [{ name: 'set_composition', input: { page_id: fx.pageId, ops: [{ op: 'set_meta', duration: 8 }] } }] },
        { tools: [{ name: 'end_stage' }] },
        /* refine 3 (maxPasses default 3 → passes used) */
        { tools: [{ name: 'set_composition', input: { page_id: fx.pageId, ops: [{ op: 'set_meta', duration: 9 }] } }] },
        { tools: [{ name: 'end_stage' }] },
      ]
      const card = animateCard({ pageId: fx.pageId })
      const { run } = await direct(card, scriptedModel(turns, requests))
      /* duration 7 = the best pass's body */
      expect(store.getComposition(fx.canvasId, fx.pageId)?.duration).toBe(7)
      expect(run?.openIssues.some((i) => i.text.includes('restored pass 1'))).toBe(true)
    } finally {
      directorDeps.checkScene = realCheck
      directorDeps.versions = realVersions
      directorDeps.versionState = realVersionState
    }
  })
})
