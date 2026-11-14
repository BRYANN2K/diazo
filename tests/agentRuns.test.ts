import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/index.ts', () => ({ db: {} }))

const { agentRunDeps, startRun } = await import('../server/agentRuns.ts')
const { priceFor, priceRun, priceUsage } = await import('../shared/modelPrices.ts')
const { summarizeUsage, formatCost } = await import('../shared/agentRuns.ts')
import type { AgentModel } from '../server/agentModel.ts'
import type { AgentRunRecord } from '../shared/agentRuns.ts'

const usage = (model: string, inputTokens: number, outputTokens: number, costUsd?: number) => ({
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...(costUsd !== undefined ? { costUsd } : {}),
})

afterEach(() => vi.restoreAllMocks())

describe('the price table', () => {
  it('finds a family from a dated snapshot or a provider route, longest prefix first', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(priceFor('claude-haiku-4-5'))
    expect(priceFor('anthropic/claude-sonnet-4-6')?.input).toBe(3)
    expect(priceFor('claude-opus-5-5')?.input).toBe(4)
    expect(priceFor('claude-opus-5')?.input).toBe(5)
    expect(priceFor('gpt-5-mini-2025-08-07')?.input).toBe(0.25)
    expect(priceFor('some-local-model')).toBeUndefined()
  })

  it('prices fresh input, output and the cache at their own rates', () => {
    const priced = priceUsage({
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    expect(priced.estimated).toBe(true)
    expect(priced.costUsd).toBeCloseTo(3 + 15 + 0.3 + 3.75)
  })

  it('takes the provider’s own figure over the table, and refuses a partial run total', () => {
    expect(priceUsage(usage('claude-sonnet-4-6', 10, 10, 0.5))).toEqual({ costUsd: 0.5, estimated: false })
    expect(priceRun([usage('claude-sonnet-4-6', 10, 10), usage('mystery', 1, 1)])).toEqual({ estimated: false })
    expect(priceRun([])).toEqual({ estimated: false })
  })
})

describe('a metered run', () => {
  function fakeModel(results: { usage?: ReturnType<typeof usage> }[]): AgentModel {
    let call = 0
    return {
      provider: 'anthropic',
      label: 'Doop (claude-sonnet-4-6)',
      userId: 'u1',
      run: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', ...results[call++] }),
    }
  }

  it('sums every call per model and writes one priced ledger row when it ends', async () => {
    const insert = vi.spyOn(agentRunDeps, 'insert').mockResolvedValue()
    let clock = 1000
    vi.spyOn(agentRunDeps, 'now').mockImplementation(() => clock)
    const run = startRun(
      fakeModel([{ usage: usage('claude-sonnet-4-6', 100, 10) }, {}, { usage: usage('claude-sonnet-4-6', 50, 5) }]),
      { canvasId: 'c1', kind: 'design', agent: 'Doop' },
    )
    const req = { system: [], tools: [], messages: [], maxTokens: 10 }
    await run.model.run(req)
    await run.model.run(req)
    await run.model.run(req)
    clock = 4000
    const record = await run.finish('done')
    expect(record).toMatchObject({
      canvasId: 'c1',
      kind: 'design',
      agent: 'Doop',
      label: 'Doop (claude-sonnet-4-6)',
      inputTokens: 150,
      outputTokens: 15,
      costEstimated: true,
      outcome: 'done',
      startedAt: 1000,
      endedAt: 4000,
    })
    expect(record.costUsd).toBeCloseTo((150 * 3 + 15 * 15) / 1_000_000)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0]![0]).toMatchObject({ id: run.id, payerId: 'u1', outcome: 'done' })
    /* a second finish is a no-op */
    await run.finish('failed')
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('meters a harness run (Claude or Gemini CLI) from the usage it returns', async () => {
    vi.spyOn(agentRunDeps, 'insert').mockResolvedValue()
    const model: AgentModel = {
      ...fakeModel([]),
      runHarness: async () => ({ success: true, text: 'done', usage: [usage('claude-opus-4-8', 7, 3, 0.02)] }),
    }
    const run = startRun(model, { canvasId: 'c1', kind: 'design', agent: 'Doop' })
    await run.model.runHarness!({
      canvasId: 'c1',
      prompt: 'p',
      system: 's',
      tools: [],
      maxTurns: 1,
      execute: async () => ({ type: 'tool_result', tool_use_id: 'x', content: 'ok' }),
    })
    const record = await run.finish('done')
    expect(record).toMatchObject({ inputTokens: 7, outputTokens: 3, costUsd: 0.02, costEstimated: false })
  })

  it('never fails the run when the ledger write fails', async () => {
    vi.spyOn(agentRunDeps, 'insert').mockRejectedValue(new Error('db down'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = startRun(fakeModel([]), { canvasId: 'c1', kind: 'chat', agent: 'Doop' })
    await expect(run.finish('stopped')).resolves.toMatchObject({ outcome: 'stopped', inputTokens: 0 })
    expect(log).toHaveBeenCalled()
  })
})

describe('summarizeUsage', () => {
  const run = (
    id: string,
    startedAt: number,
    models: ReturnType<typeof usage>[],
    costUsd?: number,
  ): AgentRunRecord => ({
    id,
    canvasId: 'c1',
    kind: 'design',
    agent: 'Doop',
    label: 'x',
    provider: 'anthropic',
    models,
    inputTokens: models.reduce((n, m) => n + m.inputTokens, 0),
    outputTokens: models.reduce((n, m) => n + m.outputTokens, 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costEstimated: false,
    outcome: 'done',
    startedAt,
    endedAt: startedAt + 2000,
  })

  it('totals per model and per canvas, newest run first, and counts unpriced runs', () => {
    const report = summarizeUsage([
      run('a', 1, [usage('gpt-5', 1_000_000, 0, 1.25)], 1.25),
      run('b', 2, [usage('gpt-5', 0, 100_000), usage('mystery', 5, 5)]),
    ])
    expect(report.runs.map((r) => r.id)).toEqual(['b', 'a'])
    const gpt = report.byModel.find((m) => m.model === 'gpt-5')!
    expect(gpt).toMatchObject({ runs: 2, inputTokens: 1_000_000, outputTokens: 100_000, unpriced: false })
    expect(gpt.costUsd).toBeCloseTo(1.25 + 1)
    expect(report.byModel.find((m) => m.model === 'mystery')).toMatchObject({ unpriced: true, costUsd: 0 })
    expect(report.total).toMatchObject({ runs: 2, unpricedRuns: 1, durationMs: 4000, costUsd: 1.25 })
  })

  it('formats costs for the panel', () => {
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(0.0004)).toBe('<$0.001')
    expect(formatCost(0.0421)).toBe('$0.042')
    expect(formatCost(12.3)).toBe('$12.30')
  })
})
