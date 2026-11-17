import { nanoid } from 'nanoid'
import { desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { db } from './db/index.ts'
import { toolCalls } from './db/schema.ts'
import { imageSize } from './imageSize.ts'
import type { ToolCallRecord, ToolCallTotals } from '../shared/toolCalls.ts'

/* The per-call ledger (change agent-cost, spec AC-1): one tool_calls row per
 * tool call an agent makes, over MCP (toolLoads.ts's wrapper) or inside a
 * resident run (resident.ts's execTool). A row records what the conversation
 * pays to carry the call: the argument bytes, the result bytes and the image
 * pixels. Writes are fire-and-forget — metering never fails the call it
 * describes. */

/** How many records the Usage tab and get_usage read back per canvas. */
export const TOOL_CALL_LIMIT = 500

export const toolCallDeps = {
  now: () => Date.now(),
  insert: async (row: typeof toolCalls.$inferInsert) => {
    await db.insert(toolCalls).values(row)
  },
  select: (canvasId: string, limit: number) =>
    db.select().from(toolCalls).where(eq(toolCalls.canvasId, canvasId)).orderBy(desc(toolCalls.at)).limit(limit),
}

interface ContentItem {
  type?: string
  data?: string
  mimeType?: string
}

/** Pixels of every image in a tool result's content (w×h each), best-effort
 *  from the headers — the point is the context weight, not fidelity. */
export function imagePixelsOf(result: unknown): number {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return 0
  let pixels = 0
  for (const item of content as ContentItem[]) {
    if (item?.type !== 'image' || typeof item.data !== 'string') continue
    try {
      const size = imageSize(Buffer.from(item.data, 'base64'), item.mimeType ?? 'image/png')
      pixels += size.width * size.height
    } catch {
      /* an undecodable image still cost its bytes — resultBytes has it */
    }
  }
  return pixels
}

/** JSON.stringify size with a floor of 0 — undefined and throws count as nothing. */
export function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

function toRecord(row: typeof toolCalls.$inferSelect): ToolCallRecord {
  return {
    id: row.id,
    canvasId: row.canvasId,
    source: row.source === 'resident' ? 'resident' : 'mcp',
    tool: row.tool,
    actorName: row.actorName,
    actorKind: row.actorKind === 'user' ? 'user' : 'agent',
    ownerId: row.ownerId,
    runId: row.runId,
    inputBytes: row.inputBytes,
    resultBytes: row.resultBytes,
    imagePixels: row.imagePixels,
    ms: row.ms,
    failed: row.failed,
    at: row.at,
  }
}

/** Append one call to the ledger. Never throws, never awaited by the caller. */
export function recordToolCall(rec: Omit<ToolCallRecord, 'id'>): void {
  const at = rec.at || toolCallDeps.now()
  void toolCallDeps
    .insert({ ...rec, id: nanoid(), at })
    .catch((error: unknown) => console.error('[tool-calls] could not record the call', error))
}

export async function listToolCalls(canvasId: string, limit = TOOL_CALL_LIMIT): Promise<ToolCallRecord[]> {
  const rows = await toolCallDeps.select(canvasId, limit)
  return rows.map(toRecord)
}

export function toolCallTotals(calls: readonly ToolCallRecord[]): ToolCallTotals {
  const totals: ToolCallTotals = {
    calls: calls.length,
    inputBytes: 0,
    resultBytes: 0,
    imagePixels: 0,
    ms: 0,
    failed: 0,
    byTool: {},
  }
  for (const call of calls) {
    totals.inputBytes += call.inputBytes
    totals.resultBytes += call.resultBytes
    totals.imagePixels += call.imagePixels
    totals.ms += call.ms
    if (call.failed) totals.failed += 1
    const per = (totals.byTool[call.tool] ??= { calls: 0, resultBytes: 0, imagePixels: 0 })
    per.calls += 1
    per.resultBytes += call.resultBytes
    per.imagePixels += call.imagePixels
  }
  return totals
}

/** The ledger section get_usage and the Usage tab show. */
export async function toolCallReport(
  canvasId: string,
  limit = TOOL_CALL_LIMIT,
): Promise<{ totals: ToolCallTotals; calls: ToolCallRecord[] }> {
  const calls = await listToolCalls(canvasId, limit)
  return { totals: toolCallTotals(calls), calls }
}

/** Ledger rows stay long enough for the Usage tab to be useful, then the
 *  sweep drops them — same retention shape as script_runs. */
export const TOOL_CALL_KEEP_DAYS = 30
/** A busy canvas keeps its most recent calls even inside the window. */
export const TOOL_CALL_KEEP_PER_CANVAS = 2_000

/** Retention: drop calls older than the keep window, then trim every canvas
 *  to its most recent keep count. Returns the number of rows removed. */
export async function pruneToolCalls(now = Date.now()): Promise<number> {
  let removed = 0
  const cutoff = now - TOOL_CALL_KEEP_DAYS * 24 * 60 * 60 * 1000
  removed += (await db.delete(toolCalls).where(lt(toolCalls.at, cutoff)).returning({ id: toolCalls.id })).length
  const crowded = await db.select({ canvasId: toolCalls.canvasId }).from(toolCalls).groupBy(toolCalls.canvasId)
  for (const { canvasId } of crowded) {
    const ids = await db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(canvasId === null ? isNull(toolCalls.canvasId) : eq(toolCalls.canvasId, canvasId))
      .orderBy(desc(toolCalls.at))
      .offset(TOOL_CALL_KEEP_PER_CANVAS)
    if (ids.length) {
      removed += (
        await db
          .delete(toolCalls)
          .where(
            inArray(
              toolCalls.id,
              ids.map((r) => r.id),
            ),
          )
          .returning({ id: toolCalls.id })
      ).length
    }
  }
  return removed
}
