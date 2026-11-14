import { priceUsage } from './modelPrices.ts'
import type { TokenUsage } from './usage.ts'

/** What kind of resident work a run was: a design pass over cards, comments
 *  and feedback, or a plan-only chat answer. */
export type AgentRunKind = 'design' | 'chat'
export type AgentRunOutcome = 'done' | 'failed' | 'stopped'

/** One resident run in the usage ledger (the agent_runs table). */
export interface AgentRunRecord {
  id: string
  canvasId: string
  kind: AgentRunKind
  /** the resident role that ran, e.g. "Doop" */
  agent: string
  /** the model line the canvas showed, e.g. "ChatGPT (gpt-5, high effort)" */
  label: string
  provider: string
  /** per model, as the transports reported it */
  models: TokenUsage[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** undefined = some model had no provider figure and no price row */
  costUsd?: number
  /** true = some of the cost is the price table's estimate */
  costEstimated: boolean
  outcome: AgentRunOutcome
  startedAt: number
  endedAt: number
}

export interface ModelUsageTotal {
  model: string
  runs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** the priced part of this model's usage */
  costUsd: number
  /** true = some of this model's usage had no price at all */
  unpriced: boolean
  costEstimated: boolean
}

export interface UsageReport {
  /** newest first */
  runs: AgentRunRecord[]
  byModel: ModelUsageTotal[]
  total: {
    runs: number
    inputTokens: number
    outputTokens: number
    durationMs: number
    costUsd: number
    unpricedRuns: number
    costEstimated: boolean
  }
}

/** Per-run token totals over all of the run's models. */
export function runTotals(models: readonly TokenUsage[]) {
  return models.reduce(
    (sum, u) => ({
      inputTokens: sum.inputTokens + u.inputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + u.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
}

/** The canvas usage panel and `get_usage`: runs plus totals per model. */
export function summarizeUsage(runs: readonly AgentRunRecord[]): UsageReport {
  const byModel = new Map<string, ModelUsageTotal>()
  for (const run of runs) {
    for (const usage of run.models) {
      const prev = byModel.get(usage.model)
      const priced = priceUsage(usage)
      const base: ModelUsageTotal = prev ?? {
        model: usage.model,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpriced: false,
        costEstimated: false,
      }
      byModel.set(usage.model, {
        model: base.model,
        runs: base.runs + 1,
        inputTokens: base.inputTokens + usage.inputTokens,
        outputTokens: base.outputTokens + usage.outputTokens,
        cacheReadTokens: base.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + usage.cacheWriteTokens,
        costUsd: base.costUsd + (priced.costUsd ?? 0),
        unpriced: base.unpriced || priced.costUsd === undefined,
        costEstimated: base.costEstimated || priced.estimated,
      })
    }
  }
  const ordered = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  return {
    runs: ordered,
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens),
    total: {
      runs: runs.length,
      inputTokens: runs.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
      outputTokens: runs.reduce((n, r) => n + r.outputTokens, 0),
      durationMs: runs.reduce((n, r) => n + Math.max(0, r.endedAt - r.startedAt), 0),
      costUsd: runs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      unpricedRuns: runs.filter((r) => r.costUsd === undefined).length,
      costEstimated: runs.some((r) => r.costEstimated),
    },
  }
}

/** "$0.042", "<$0.001", "—" for unknown. */
export function formatCost(costUsd: number | undefined): string {
  if (costUsd === undefined) return '—'
  if (costUsd === 0) return '$0'
  if (costUsd < 0.001) return '<$0.001'
  return costUsd < 1 ? `$${costUsd.toFixed(3)}` : `$${costUsd.toFixed(2)}`
}

/** "12.3k", "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}
