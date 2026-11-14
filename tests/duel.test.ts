import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveCanvas: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: () => {},
  saveDecision: () => {},
  deleteFrame: () => {},
  listFrameRunIds: async () => [],
}))
vi.mock('../server/db/index.ts', () => ({ db: {} }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const { duelProblem } = await import('../shared/duel.ts')
const { DUEL_FRAME, DuelInputError, duelDeps, duelView, pickDuel, pickLabel, startDuel } =
  await import('../server/duels.ts')
const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Duel',
  ownerId: 'o',
  createdAt: 0,
  updatedAt: 0,
  frames: [{ id: 'f0', canvasId: 'c1', name: 'Existing', html: '', x: 0, y: 40, width: 400, height: 300 } as never],
}
const human = actions.resolveActor({ name: 'Vera', kind: 'user' })
const gpt = { provider: 'openai-key' as const, model: 'gpt-5' }
const claude = { provider: 'anthropic-key' as const, model: 'claude-sonnet-4-6' }

afterEach(() => vi.restoreAllMocks())

describe('duelProblem', () => {
  it('takes 2 to 3 different picks and a brief', () => {
    expect(duelProblem('a pricing page', [gpt, claude])).toBeUndefined()
    expect(duelProblem('', [gpt, claude])).toMatch(/empty/)
    expect(duelProblem('x', [gpt])).toMatch(/2 to 3/)
    expect(duelProblem('x', [gpt, claude, { provider: 'openrouter-key' }, { provider: 'gemini-key' }])).toMatch(
      /2 to 3/,
    )
    expect(duelProblem('x', [gpt, { ...gpt }])).toMatch(/different/)
  })
})

describe('startDuel', () => {
  it('puts one empty frame per pick beside the page, each with its own scoped card', async () => {
    store.init([structuredClone(CANVAS)])
    const insert = vi.spyOn(duelDeps, 'insert').mockResolvedValue()
    const duel = await startDuel({
      canvasId: 'c1',
      brief: '  A pricing page  ',
      picks: [gpt, claude, { provider: 'nonsense' }],
      actor: human,
      userId: 'u1',
    })
    expect(duel.brief).toBe('A pricing page')
    expect(duel.entries.map((e) => e.label)).toEqual(['OpenAI · gpt-5', 'Claude API · claude-sonnet-4-6'])
    const frames = duel.entries.map((e) => store.getFrame(e.frameId)!)
    expect(frames.map((f) => f.name)).toEqual(['Duel A · OpenAI · gpt-5', 'Duel B · Claude API · claude-sonnet-4-6'])
    expect(frames.map((f) => [f.x, f.y, f.width])).toEqual([
      [560, 40, DUEL_FRAME.width],
      [560 + DUEL_FRAME.width + 80, 40, DUEL_FRAME.width],
    ])
    const cards = actions.getTasks('c1')
    for (const entry of duel.entries) {
      const card = cards.find((c) => c.id === entry.cardId)!
      expect(card.scope).toEqual({ frameId: entry.frameId })
      expect(card.runner).toEqual(entry.runner)
      expect(card.status).toContain('A pricing page')
    }
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('refuses a request that is no duel before touching the canvas', async () => {
    store.init([structuredClone(CANVAS)])
    await expect(
      startDuel({ canvasId: 'c1', brief: 'x', picks: [gpt], actor: human, userId: 'u1' }),
    ).rejects.toBeInstanceOf(DuelInputError)
    expect(store.getCanvas('c1')?.frames).toHaveLength(1)
  })

  it('labels a pick by its connection name', () => {
    expect(pickLabel({ provider: 'claude-local' })).toBe('Claude Plan')
  })
})

describe('duelView', () => {
  it('shows each entry with its card status, lint score and its run’s cost and time', async () => {
    store.init([structuredClone(CANVAS)])
    vi.spyOn(duelDeps, 'insert').mockResolvedValue()
    const duel = await startDuel({ canvasId: 'c1', brief: 'Hero', picks: [gpt, claude], actor: human, userId: 'u1' })
    const [a, b] = duel.entries
    store.getFrame(a!.frameId)!.lint = { score: 92, errors: 0, warnings: 1 } as never
    actions.failCard('c1', b!.cardId, 'model gone')
    vi.spyOn(duelDeps, 'frameRuns').mockImplementation(async (frameId) => (frameId === a!.frameId ? ['run-a'] : []))
    vi.spyOn(duelDeps, 'run').mockResolvedValue({
      costUsd: 0.12,
      costEstimated: true,
      startedAt: 1000,
      endedAt: 61_000,
    } as never)
    const view = await duelView(duel)
    expect(view.results[0]).toMatchObject({
      status: 'queued',
      exists: true,
      lintScore: 92,
      runId: 'run-a',
      costUsd: 0.12,
      costEstimated: true,
      durationMs: 60_000,
    })
    expect(view.results[1]).toMatchObject({ status: 'failed', exists: true })
    expect(view.results[1]!.runId).toBeUndefined()
  })
})

describe('pickDuel', () => {
  it('saves the kept entry as a canvas decision and archives the others', async () => {
    store.init([structuredClone(CANVAS)])
    let row: Record<string, unknown> = {}
    vi.spyOn(duelDeps, 'insert').mockImplementation(async (r) => {
      row = { pickedFrameId: null, decidedAt: null, ...r }
    })
    vi.spyOn(duelDeps, 'get').mockImplementation((async () => [row]) as never)
    const update = vi.spyOn(duelDeps, 'update').mockResolvedValue()
    const duel = await startDuel({ canvasId: 'c1', brief: 'Hero', picks: [gpt, claude], actor: human, userId: 'u1' })
    const [a, b] = duel.entries
    const view = await pickDuel('c1', duel.id, b!.frameId, human)
    expect(view?.pickedFrameId).toBe(b!.frameId)
    expect(update).toHaveBeenCalledWith(duel.id, expect.objectContaining({ pickedFrameId: b!.frameId }))
    const [decision] = actions.getDecisions('c1')
    expect(decision).toMatchObject({ source: 'duel', frameId: b!.frameId })
    expect(decision!.text).toContain('kept Claude API · claude-sonnet-4-6 over OpenAI · gpt-5')
    expect(store.getFrame(a!.frameId)).toMatchObject({ hidden: true, name: 'Duel A · OpenAI · gpt-5 (archived)' })
    expect(store.getFrame(b!.frameId)?.hidden).toBeFalsy()
    /* decided once */
    row = { ...row, pickedFrameId: b!.frameId }
    await expect(pickDuel('c1', duel.id, a!.frameId, human)).rejects.toBeInstanceOf(DuelInputError)
  })
})
