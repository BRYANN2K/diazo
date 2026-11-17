import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTask, ElementComment, TaskFeedback } from '../shared/types.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'
import type { AgentModel, AgentTurnRequest, AgentTurnResult } from '../server/agentModel.ts'

/* A run's room to work: an "Animate storyboard" card directs a whole film
   and gets NO turn budget — only a high safety backstop so a broken loop
   cannot run forever, plus a no-progress stop that ends it after 8
   consecutive turns that neither change the canvas nor read something new
   (24 tool calls on a local harness, which shows calls rather than turns).
   The sweep knows an animate card by its `kind` — never by its text, so a
   card or comment that merely names animate_storyboard keeps the ordinary
   budget. The real prompts are imported here so the negative case runs on
   the shipped wording. */

const mocks = vi.hoisted(() => ({ pickModel: vi.fn(), runSpeechTool: vi.fn(), runBlenderTool: vi.fn() }))

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameVersion: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))
/* the runners stand in for speech jobs and Blender ops — the desktop and
   engines they reach for do not exist in a test */
vi.mock('../server/speechTools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/speechTools.ts')>()),
  runSpeechTool: mocks.runSpeechTool,
}))
vi.mock('../server/blenderTools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/blenderTools.ts')>()),
  runBlenderTool: mocks.runBlenderTool,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { motion: en } = await import('../src/lib/i18n/en/motion.ts')
const { motion: pt } = await import('../src/lib/i18n/pt-BR/motion.ts')

function card(id: string, status: string, kind?: AgentTask['kind']): AgentTask {
  return {
    id,
    agentName: '',
    color: '#000',
    status,
    startedAt: 1000,
    queuedBy: 'Ann',
    queuedByUserId: 'ann',
    stage: 0,
    ...(kind ? { kind } : {}),
  }
}

function seed(
  canvasId: string,
  tasks: AgentTask[],
  extras?: { feedback?: TaskFeedback[]; comments?: ElementComment[] },
) {
  actions.hydrateLogs({
    tasks: new Map([[canvasId, tasks]]),
    feedback: new Map(extras?.feedback ? [[canvasId, extras.feedback]] : []),
    comments: new Map(extras?.comments ? [[canvasId, extras.comments]] : []),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
}

/* the prompt template filled the way MotionTimeline fills it */
const animatePrompt = (template: string) =>
  template.replace('{page}', 'Home').replace('{pageId}', 'p1').replace('{duration}', '12')

/* the turn cap the sweep hands the harness for the canvas's one open card */
async function maxTurnsFor(canvasId: string): Promise<number> {
  const runHarness = vi.fn(async (_req: LocalHarnessRequest) => ({ success: true, text: 'done' }))
  mocks.pickModel.mockResolvedValue({
    provider: 'claude-local',
    label: 'Test',
    userId: 'ann',
    runHarness,
    run: vi.fn(),
  })
  const resident = await import('../server/resident.ts')
  resident.onFeedback(canvasId)
  await vi.waitFor(() => expect(runHarness).toHaveBeenCalled())
  /* a run that changed nothing settles its card failed — a clean barrier
     before the next canvas's turn */
  const card = () => actions.getTasks(canvasId).find((t) => t.queuedBy)!
  await vi.waitFor(() => expect(card().failedAt).toBeTypeOf('number'))
  return runHarness.mock.calls[0]![0].maxTurns
}

const cardById = (canvasId: string, id: string) => actions.getTasks(canvasId).find((t) => t.id === id)!

const toolUse = (name: string, input: Record<string, unknown>): AgentTurnResult => ({
  content: [{ type: 'tool_use', id: Math.random().toString(36).slice(2), name, input }],
  stop_reason: 'tool_use',
})
/* one turn can carry several calls — the watch must still count it once */
const toolUseTurn = (calls: [string, Record<string, unknown>][]): AgentTurnResult => ({
  content: calls.map(([name, input]) => ({
    type: 'tool_use' as const,
    id: Math.random().toString(36).slice(2),
    name,
    input,
  })),
  stop_reason: 'tool_use',
})
/* a call that moves nothing: a read on a page that does not exist fails
   without changing the canvas — the flat line the watch counts */
const flatCall: [string, Record<string, unknown>] = ['get_composition', { page_id: 'nope' }]
const flatTurn = () => toolUse(flatCall[0], flatCall[1])
/* a turn that moves something: every rename counts as an arrangement write */
const progressTurn = (frameId: string, n: number) => toolUse('update_frame', { frame_id: frameId, name: `s${n}` })
/* a whole-body timeline write — identical bodies are the write loop the
   watch exists for, a different duration is real work */
const compositionTurn = (pageId: string, duration: number) =>
  toolUse('set_composition', {
    page_id: pageId,
    composition: { duration, fps: 30, width: 1280, height: 720, tracks: [] },
  })
const doneTurn: AgentTurnResult = { content: [{ type: 'text', text: 'the film is directed' }], stop_reason: 'end_turn' }

/* a scripted API-loop model: each call pops the next scripted turn and a
   drained script ends like a model that stopped calling tools */
function scriptedModel(steps: AgentTurnResult[]): { model: AgentModel; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_req: AgentTurnRequest) => steps.shift() ?? doneTurn)
  return {
    model: { provider: 'anthropic', label: 'Test', userId: 'ann', run },
    run,
  }
}

async function runSweep(canvasId: string) {
  const resident = await import('../server/resident.ts')
  resident.onFeedback(canvasId)
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  mocks.pickModel.mockReset()
  mocks.runSpeechTool.mockReset()
  mocks.runBlenderTool.mockReset()
})

describe('a run’s turn budget', () => {
  it('hands an animate-flagged card only the safety backstop, whatever its text says', async () => {
    seed('canvas-animate', [card('c1', 'make the button bigger', 'animate')])
    expect(await maxTurnsFor('canvas-animate')).toBe(200)
  })

  it('keeps a card that merely names animate_storyboard at 24, in both shipped locales', async () => {
    seed('canvas-animate-en', [card('c1', animatePrompt(en.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-en')).toBe(24)

    seed('canvas-animate-pt', [card('c1', animatePrompt(pt.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-pt')).toBe(24)
  })

  it('keeps a run with a comment naming animate_storyboard at 24', async () => {
    const canvasId = 'canvas-animate-comment'
    seed(canvasId, [card('c1', 'make the button bigger')], {
      feedback: [
        {
          id: 'fb1',
          taskId: 'c1',
          canvasId,
          agentName: '',
          from: 'Ann',
          fromUserId: 'ann',
          text: 'have you tried animate_storyboard for this?',
          at: 1,
        },
      ],
      comments: [
        {
          id: 'cm1',
          canvasId,
          pageId: `${canvasId}:page1`,
          x: 0,
          y: 0,
          snippet: '',
          from: 'Ann',
          fromUserId: 'ann',
          text: '@doop run animate_storyboard here',
          at: 2,
          forAgent: true,
        },
      ],
    })
    expect(await maxTurnsFor(canvasId)).toBe(24)
  })

  it('keeps a redesign card at 40 and an ordinary card at 24', async () => {
    seed('canvas-redesign', [card('c1', 'redesign the landing page like acme.com')])
    expect(await maxTurnsFor('canvas-redesign')).toBe(40)

    seed('canvas-plain', [card('c1', 'make the button bigger')])
    expect(await maxTurnsFor('canvas-plain')).toBe(24)
  })
})

describe('an animate run’s room to work', () => {
  let canvasId: string
  let frameId: string
  let pageId: string

  beforeEach(() => {
    canvasId = store.createCanvas('animate room', 'ann').id
    frameId = store.createFrame(canvasId, { name: 'shot', html: '<p>shot</p>' }, 'ann')!.id
    pageId = canvasPages(store.getCanvas(canvasId)!)[0]!.id
    seed(canvasId, [card('c1', 'animate the storyboard', 'animate')])
  })

  it('goes on past 40 turns while it keeps making progress', async () => {
    const { model, run } = scriptedModel(Array.from({ length: 45 }, (_, i) => progressTurn(frameId, i)))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').endedAt).toBeTypeOf('number'), { timeout: 10_000 })
    /* it was not cut at the old 40: the card ended on the run's own words */
    expect(run.mock.calls.length).toBeGreaterThan(40)
    expect(cardById(canvasId, 'c1').failureReason).toBeUndefined()
  })

  it('stops at the safety backstop when it never stops making progress', async () => {
    let n = 0
    const { model, run } = scriptedModel([])
    run.mockImplementation(async () => progressTurn(frameId, ++n))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'), { timeout: 15_000 })
    expect(run).toHaveBeenCalledTimes(200)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/ran out of turns/i)
    /* and it still wrote its closing summary, not "ran out of turns" alone */
    expect(
      actions
        .getActivity(canvasId)
        .map((a) => a.message)
        .join('\n'),
    ).toMatch(/safety backstop/)
  }, 30_000)

  it('stops after 8 consecutive turns that change nothing, and says why', async () => {
    const { model, run } = scriptedModel(Array.from({ length: 30 }, flatTurn))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* nine calls: the first turn always moves, then eight that land nothing */
    expect(run).toHaveBeenCalledTimes(9)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
    expect(
      actions
        .getActivity(canvasId)
        .map((a) => a.message)
        .join('\n'),
    ).toMatch(/changed nothing/i)
  })

  it('restarts the count when a turn lands work again', async () => {
    const { model, run } = scriptedModel([
      ...Array.from({ length: 5 }, flatTurn),
      progressTurn(frameId, 1),
      ...Array.from({ length: 30 }, flatTurn),
    ])
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* five flat turns, one working turn, then eight flat ones again */
    expect(run).toHaveBeenCalledTimes(14)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('counts turns, not tool calls: one turn of many flat calls is still one turn', async () => {
    const { model, run } = scriptedModel(
      Array.from({ length: 30 }, () => toolUseTurn(Array.from({ length: 10 }, () => flatCall))),
    )
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* 9 turns of 10 calls each — counting calls would have stopped the run
       during its third turn */
    expect(run).toHaveBeenCalledTimes(9)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/the last 8 turns/i)
  })

  it('lets reading move the watch: a new target counts, a repeat does not', async () => {
    const frames = Array.from(
      { length: 9 },
      (_, i) => store.createFrame(canvasId, { name: `shot ${i}`, html: `<p>${i}</p>` }, 'ann')!.id,
    )
    const { model, run } = scriptedModel([
      /* nine turns each reading a frame the run had not read */
      ...frames.map((id) => toolUse('get_frame_html', { frame_id: id })),
      /* then the same read again and again — now it is time, not work */
      ...Array.from({ length: 30 }, () => toolUse('get_frame_html', { frame_id: frames[0]! })),
    ])
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* the survey went well past 8 turns; the repeats then stalled it:
       9 new reads + 8 turns of re-reading the same frame */
    expect(run).toHaveBeenCalledTimes(17)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('treats a write loop that rewrites the same timeline as no progress', async () => {
    const { model, run } = scriptedModel(Array.from({ length: 30 }, () => compositionTurn(pageId, 6)))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* the first write lands the film; the 8 identical rewrites stall it —
       the revision bump is not progress */
    expect(run).toHaveBeenCalledTimes(9)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('keeps going while the timeline itself keeps changing', async () => {
    const { model, run } = scriptedModel(Array.from({ length: 30 }, (_, i) => compositionTurn(pageId, 6 + i)))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    /* a run that only ever wrote compositions has nothing deliverable, so
       the card fails on no-mutation — but only after all 30 turns ran, the
       no-mutation nudge and the final word */
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'), { timeout: 15_000 })
    expect(run).toHaveBeenCalledTimes(32)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/without changing a frame or a token/i)
  })

  it('ends a write loop that only toggles the same frame back and forth', async () => {
    const shot = store.createFrame(canvasId, { name: 'toggle', html: '<p>alpha</p>' }, 'ann')!
    const doc = (word: string) =>
      `<html><body><main><p>${word}</p><p>padding padding padding padding</p></main></body></html>`
    const { model, run } = scriptedModel(
      Array.from({ length: 30 }, (_, i) =>
        toolUse('set_frame_html', { frame_id: shot.id, html: doc(i % 2 ? 'beta' : 'alpha') }),
      ),
    )
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* each document ran once as new ground; the A/B loop that follows
       rewrites nothing the canvas has not already shown */
    expect(run).toHaveBeenCalledTimes(10)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('keeps waiting on a job while the job itself is moving', async () => {
    /* the tool descriptions tell the model to poll get_transcript: each
       poll that sees the job move is progress — the wait ends eight polls
       after the job stops */
    let polls = 0
    mocks.runSpeechTool.mockImplementation(async () => {
      polls += 1
      const state = polls < 3 ? 'queued' : polls < 6 ? 'running' : 'done'
      const stamp = state === 'queued' ? 10 : state === 'running' ? 20 : 30
      return { job: { id: 'j1', state, progress: state === 'done' ? 1 : 0, updatedAt: stamp } }
    })
    const { model, run } = scriptedModel(Array.from({ length: 30 }, () => toolUse('get_transcript', { job_id: 'j1' })))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* queued → running → done each moved the watch once; the frozen
       'done' job then stalled the run like any other poll */
    expect(run).toHaveBeenCalledTimes(14)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('ends the wait when the polled job never moves', async () => {
    mocks.runSpeechTool.mockResolvedValue({ job: { id: 'j1', state: 'queued', progress: 0, updatedAt: 1 } })
    const { model, run } = scriptedModel(Array.from({ length: 30 }, () => toolUse('get_transcript', { job_id: 'j1' })))
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* a dead job is still time: one first look, then eight repeats */
    expect(run).toHaveBeenCalledTimes(9)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('counts a first try at each distinct call as movement — a repeat is still time', async () => {
    /* the Blender scene is not canvas state: each new light moves on its
       key alone, and looping one back is still */
    mocks.runBlenderTool.mockResolvedValue({ op: { id: 'op1', state: 'queued', updatedAt: 1 } })
    const { model, run } = scriptedModel([
      ...Array.from({ length: 12 }, (_, i) => toolUse('blender_add_light', { light_type: 'POINT', name: `L${i}` })),
      ...Array.from({ length: 30 }, () => toolUse('blender_add_light', { light_type: 'POINT', name: 'L0' })),
    ])
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* 12 first tries, then 8 repeats of L0 */
    expect(run).toHaveBeenCalledTimes(20)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('closes a stalled run with the stop reason, then the last narration', async () => {
    const { model, run } = scriptedModel([
      ...Array.from({ length: 3 }, flatTurn),
      /* the last words it had before the stall — one turn's narration */
      {
        content: [
          { type: 'text', text: 'checking the third shot before the cut' },
          { type: 'tool_use', id: 't1', name: 'get_composition', input: { page_id: 'nope' } },
        ],
        stop_reason: 'tool_use',
      },
      ...Array.from({ length: 29 }, flatTurn),
    ])
    mocks.pickModel.mockResolvedValue(model)
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* the narration rode turn 4; the flat turns then stall the run at 9 */
    expect(run).toHaveBeenCalledTimes(9)
    const activity = actions
      .getActivity(canvasId)
      .map((a) => a.message)
      .join('\n')
    expect(activity).toMatch(/Stopped: the last 8 turns changed nothing on the canvas and read nothing new/)
    expect(activity).toMatch(/checking the third shot before the cut/)
    /* and the card itself carries the reason, not a bare "hit a snag" */
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/stopped: the last 8 turns/i)
  })

  it('gives a local harness a wider call window — and fails a stalled card instead of delivering it', async () => {
    const results: Anthropic.ToolResultBlockParam[] = []
    const runHarness = vi.fn(async (req: LocalHarnessRequest) => {
      expect(req.maxTurns).toBe(200)
      for (let i = 0; i < 30; i++) {
        results.push(await req.execute({ type: 'tool_use', id: `t${i}`, name: flatCall[0], input: flatCall[1] }))
      }
      return { success: true, text: 'wrapping up' }
    })
    mocks.pickModel.mockResolvedValue({
      provider: 'claude-local',
      label: 'Test',
      userId: 'ann',
      runHarness,
      run: vi.fn(),
    })
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* 24 still calls are the window: call 25 lands the verdict, from call
       26 the run only hears "wrap up" */
    expect(results).toHaveLength(30)
    expect(results.slice(0, 25).every((r) => !/the run is ending/i.test(String(r.content)))).toBe(true)
    expect(String(results[25]!.content)).toMatch(/the run is ending/i)
    /* a stalled run is a failed card — not a delivered one */
    expect(cardById(canvasId, 'c1').endedAt).toBeUndefined()
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/changed nothing on the canvas/i)
  })

  it('never stalls a harness run that keeps finding new ground to read', async () => {
    const results: Anthropic.ToolResultBlockParam[] = []
    const runHarness = vi.fn(async (req: LocalHarnessRequest) => {
      for (let i = 0; i < 30; i++) {
        results.push(
          await req.execute({ type: 'tool_use', id: `t${i}`, name: 'find_in_canvas', input: { query: `shot ${i}` } }),
        )
      }
      return { success: true, text: 'wrapping up' }
    })
    mocks.pickModel.mockResolvedValue({
      provider: 'claude-local',
      label: 'Test',
      userId: 'ann',
      runHarness,
      run: vi.fn(),
    })
    await runSweep(canvasId)
    await vi.waitFor(() => expect(cardById(canvasId, 'c1').failedAt).toBeTypeOf('number'))
    /* every call was a first read — no wrap-up, no stall */
    expect(results).toHaveLength(30)
    expect(results.every((r) => !/the run is ending/i.test(String(r.content)))).toBe(true)
    /* the card still fails — on no deliverable, not on a stall */
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/without changing a frame or a token/i)
  })
})
