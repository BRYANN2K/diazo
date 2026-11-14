import { nanoid } from 'nanoid'
import { desc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { agentRuns } from './db/schema.ts'
import type { AgentModel } from './agentModel.ts'
import { priceRun } from '../shared/modelPrices.ts'
import { addUsage, tokenUsageListSchema, type TokenUsage } from '../shared/usage.ts'
import {
  runTotals,
  summarizeUsage,
  type AgentRunKind,
  type AgentRunOutcome,
  type AgentRunRecord,
  type UsageReport,
} from '../shared/agentRuns.ts'

/* The usage meter's ledger: one agent_runs row per resident run, with what
 * every model call in it consumed (shared/usage.ts) and its cost, priced
 * when the run ends (shared/modelPrices.ts). Rows are written once and never
 * updated, so a later price-table edit does not rewrite history. */

/** How many runs the panel and get_usage read back per canvas. */
export const USAGE_RUN_LIMIT = 200

export interface RunContext {
  canvasId: string
  kind: AgentRunKind
  agent: string
}

/** A resident run being metered: `model` is the run's model with every
 *  call's usage counted on the way out. */
export interface MeteredRun {
  id: string
  model: AgentModel
  usage(): TokenUsage[]
  finish(outcome: AgentRunOutcome): Promise<AgentRunRecord>
}

export const agentRunDeps = {
  now: () => Date.now(),
  insert: async (row: typeof agentRuns.$inferInsert) => {
    await db.insert(agentRuns).values(row)
  },
  select: (canvasId: string, limit: number) =>
    db.select().from(agentRuns).where(eq(agentRuns.canvasId, canvasId)).orderBy(desc(agentRuns.startedAt)).limit(limit),
}

export function startRun(model: AgentModel, context: RunContext): MeteredRun {
  const id = nanoid()
  const startedAt = agentRunDeps.now()
  let totals: TokenUsage[] = []
  let finished: AgentRunRecord | undefined
  const count = (usage: readonly TokenUsage[] | undefined) => {
    for (const u of usage ?? []) totals = addUsage(totals, u)
  }
  const { runHarness } = model
  const metered: AgentModel = {
    ...model,
    async run(req) {
      const result = await model.run(req)
      count(result.usage ? [result.usage] : undefined)
      return result
    },
    ...(runHarness
      ? {
          async runHarness(req) {
            const result = await runHarness(req)
            count(result.usage)
            return result
          },
        }
      : {}),
  }
  return {
    id,
    model: metered,
    usage: () => totals,
    async finish(outcome) {
      if (finished) return finished
      const priced = priceRun(totals)
      const record: AgentRunRecord = {
        id,
        canvasId: context.canvasId,
        kind: context.kind,
        agent: context.agent,
        label: model.label,
        provider: model.provider,
        models: totals,
        ...runTotals(totals),
        ...(priced.costUsd !== undefined ? { costUsd: priced.costUsd } : {}),
        costEstimated: priced.estimated,
        outcome,
        startedAt,
        endedAt: agentRunDeps.now(),
      }
      finished = record
      /* the ledger must never fail the run it describes */
      await agentRunDeps
        .insert({
          id,
          canvasId: record.canvasId,
          kind: record.kind,
          agent: record.agent,
          label: record.label,
          provider: record.provider,
          payerId: model.userId ?? null,
          models: record.models,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens,
          costUsd: record.costUsd ?? null,
          costEstimated: record.costEstimated,
          outcome,
          startedAt,
          endedAt: record.endedAt,
        })
        .catch((err: unknown) => console.error('[usage] could not record the run', err))
      return record
    },
  }
}

function toRecord(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  const models = tokenUsageListSchema.safeParse(row.models)
  return {
    id: row.id,
    canvasId: row.canvasId,
    kind: row.kind === 'chat' ? 'chat' : 'design',
    agent: row.agent,
    label: row.label,
    provider: row.provider,
    models: models.success ? models.data : [],
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    ...(row.costUsd !== null ? { costUsd: row.costUsd } : {}),
    costEstimated: row.costEstimated,
    outcome: row.outcome === 'done' || row.outcome === 'stopped' ? row.outcome : 'failed',
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  }
}

export async function listRuns(canvasId: string, limit = USAGE_RUN_LIMIT): Promise<AgentRunRecord[]> {
  const rows = await agentRunDeps.select(canvasId, limit)
  return rows.map(toRecord)
}

export async function usageReport(canvasId: string): Promise<UsageReport> {
  return summarizeUsage(await listRuns(canvasId))
}
