import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../shared/types.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'

/* A run's turn budget: an "Animate storyboard" card directs a whole film, so
   it gets the same 40 turns a redesign does — not a plain card's 24. The
   sweep knows one because its prompt names the animate_storyboard tool in
   every locale; the real prompts are imported here so a reworded string
   that drops the name fails this test, not the budget. */

const mocks = vi.hoisted(() => ({ pickModel: vi.fn() }))

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))

const actions = await import('../server/actions.ts')
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

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  mocks.pickModel.mockReset()
})

describe('a run’s turn budget', () => {
  it('gives an animate storyboard card 40 turns, in both shipped locales', async () => {
    seed('canvas-animate-en', [card('c1', animatePrompt(en.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-en')).toBe(40)

    seed('canvas-animate-pt', [card('c1', animatePrompt(pt.animatePrompt))])
    expect(await maxTurnsFor('canvas-animate-pt')).toBe(40)
  })

  it('keeps a redesign card at 40 and an ordinary card at 24', async () => {
    seed('canvas-redesign', [card('c1', 'redesign the landing page like acme.com')])
    expect(await maxTurnsFor('canvas-redesign')).toBe(40)

    seed('canvas-plain', [card('c1', 'make the button bigger')])
    expect(await maxTurnsFor('canvas-plain')).toBe(24)
  })
})
