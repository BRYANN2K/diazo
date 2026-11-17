import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTask } from '../shared/types.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'
import type { AgentModel, AgentTurnRequest, AgentTurnResult } from '../server/agentModel.ts'

/* A run's room to work: an "Animate storyboard" card directs a whole film
   and gets NO turn budget — only a high safety backstop so a broken loop
   cannot run forever, plus a no-progress stop that ends it when turns in a
   row change nothing on the canvas. The sweep knows an animate card
   because its prompt names the animate_storyboard tool in every locale;
   the real prompts are imported here so a reworded string that drops the
   name fails this test, not the budget. */

const mocks = vi.hoisted(() => ({ pickModel: vi.fn() }))

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { motion: en } = await import('../src/lib/i18n/en/motion.ts')
const { motion: pt } = await import('../src/lib/i18n/pt-BR/motion.ts')

function card(id: string, status: string): AgentTask {
  return {
    id,
    agentName: '',
    color: '#000',
    status,
    startedAt: 1000,
    queuedBy: 'Ann',
    queuedByUserId: 'ann',
    stage: 0,
  }
}

function seed(canvasId: string, tasks: AgentTask[]) {
  actions.hydrateLogs({
    tasks: new Map([[canvasId, tasks]]),
    feedback: new Map(),
    comments: new Map(),
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
/* a turn that moves nothing: a read on a page that does not exist fails
   without changing the canvas — the flat line the watch counts */
const flatTurn = () => toolUse('get_composition', { page_id: 'nope' })
/* a turn that moves something: every rename counts as an arrangement write */
const progressTurn = (frameId: string, n: number) => toolUse('update_frame', { frame_id: frameId, name: `s${n}` })
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
})

describe('a run’s turn budget', () => {
  it('hands an animate storyboard card only the safety backstop, in both shipped locales', async () => {
    seed('canvas-animate-en', [card('c1', animatePrompt(en.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-en')).toBe(200)

    seed('canvas-animate-pt', [card('c1', animatePrompt(pt.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-pt')).toBe(200)
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

  beforeEach(() => {
    canvasId = store.createCanvas('animate room', 'ann').id
    frameId = store.createFrame(canvasId, { name: 'shot', html: '<p>shot</p>' }, 'ann')!.id
    seed(canvasId, [card('c1', animatePrompt(en.animatePrompt))])
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
    expect(run).toHaveBeenCalledTimes(8)
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/without a change on the canvas/i)
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
    expect(cardById(canvasId, 'c1').failureReason).toMatch(/without a change on the canvas/i)
  })

  it('tells a harness run to wrap up after 8 tool calls that change nothing', async () => {
    const results: Anthropic.ToolResultBlockParam[] = []
    const runHarness = vi.fn(async (req: LocalHarnessRequest) => {
      for (let i = 0; i < 10; i++) {
        results.push(
          await req.execute({ type: 'tool_use', id: `t${i}`, name: 'get_composition', input: { page_id: 'nope' } }),
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
    await vi.waitFor(() =>
      expect(cardById(canvasId, 'c1').failedAt ?? cardById(canvasId, 'c1').endedAt).toBeTypeOf('number'),
    )
    /* the ninth call still ran; from the tenth the run only hears "wrap up" */
    expect(results).toHaveLength(10)
    expect(String(results.at(-1)!.content)).toMatch(/the run is ending/i)
  })
})
