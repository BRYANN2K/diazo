import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { db } from './db/index.ts'
import { scriptRuns } from './db/schema.ts'
import {
  summarizeRun,
  type ScriptEntityUndo,
  type ScriptRunRecord,
  type ScriptRunResult,
  type ScriptRunSummary,
} from '../shared/scriptRuns.ts'

export interface StoredScriptRun {
  record: ScriptRunRecord
  response?: ScriptRunResult
  /** only the entities a writing run changed; unset for queries, dry runs
   *  and runs that changed nothing — never whole-canvas snapshots */
  undo?: ScriptEntityUndo[]
}

/** Runs stay for audit long enough to be useful, then the sweep drops them. */
export const SCRIPT_RUN_KEEP_DAYS = 30
/** A busy canvas keeps its most recent runs even inside the window. */
export const SCRIPT_RUN_KEEP_PER_CANVAS = 500

/** Durable audit and replay. Tests replace the repository, never production persistence. */
export const scriptRunDeps = {
  save: async (run: StoredScriptRun) => {
    await db
      .insert(scriptRuns)
      .values({
        id: run.record.id,
        canvasId: run.record.canvasId,
        ownerId: run.record.ownerId,
        idempotencyKey: run.record.idempotencyKey,
        createdAt: run.record.createdAt,
        record: run.record,
        response: run.response ?? null,
        undo: run.undo ?? null,
      })
      .onConflictDoUpdate({
        target: scriptRuns.id,
        set: { record: run.record, response: run.response ?? null, undo: run.undo ?? null },
      })
  },
  get: async (id: string): Promise<StoredScriptRun | undefined> => {
    const [row] = await db.select().from(scriptRuns).where(eq(scriptRuns.id, id)).limit(1)
    return row
      ? {
          record: row.record,
          ...(row.response ? { response: row.response } : {}),
          ...(row.undo ? { undo: row.undo } : {}),
        }
      : undefined
  },
  byKey: async (canvasId: string, key: string): Promise<StoredScriptRun | undefined> => {
    const [row] = await db
      .select()
      .from(scriptRuns)
      .where(and(eq(scriptRuns.canvasId, canvasId), eq(scriptRuns.idempotencyKey, key)))
      .limit(1)
    return row
      ? {
          record: row.record,
          ...(row.response ? { response: row.response } : {}),
          ...(row.undo ? { undo: row.undo } : {}),
        }
      : undefined
  },
  list: async (canvasId: string): Promise<ScriptRunSummary[]> => {
    const rows = await db
      .select({ record: scriptRuns.record })
      .from(scriptRuns)
      .where(eq(scriptRuns.canvasId, canvasId))
      .orderBy(desc(scriptRuns.createdAt))
      .limit(100)
    return rows.map((row) => summarizeRun(row.record))
  },
  /** The full record — source, result payload and undo state — only for
   *  callers that explicitly ask for one run. */
  record: async (id: string): Promise<ScriptRunRecord | undefined> => {
    const [row] = await db.select({ record: scriptRuns.record }).from(scriptRuns).where(eq(scriptRuns.id, id)).limit(1)
    return row?.record
  },
  /** Free a run's idempotency key — called when the final audit save is
   *  refused, so the key cannot replay-lock a retry against a dead row. */
  release: async (id: string) => {
    await db.update(scriptRuns).set({ idempotencyKey: null }).where(eq(scriptRuns.id, id))
  },
}

/** Retention: drop runs older than the keep window, then trim every canvas
 *  to its most recent keep count. Returns the number of rows removed. */
export async function pruneScriptRuns(now = Date.now()): Promise<number> {
  let removed = 0
  const cutoff = now - SCRIPT_RUN_KEEP_DAYS * 24 * 60 * 60 * 1000
  removed += (await db.delete(scriptRuns).where(lt(scriptRuns.createdAt, cutoff)).returning({ id: scriptRuns.id }))
    .length
  const crowded = await db.select({ canvasId: scriptRuns.canvasId }).from(scriptRuns).groupBy(scriptRuns.canvasId)
  for (const { canvasId } of crowded) {
    const ids = await db
      .select({ id: scriptRuns.id })
      .from(scriptRuns)
      .where(eq(scriptRuns.canvasId, canvasId))
      .orderBy(desc(scriptRuns.createdAt))
      .offset(SCRIPT_RUN_KEEP_PER_CANVAS)
    if (ids.length) {
      removed += (
        await db
          .delete(scriptRuns)
          .where(
            inArray(
              scriptRuns.id,
              ids.map((r) => r.id),
            ),
          )
          .returning({ id: scriptRuns.id })
      ).length
    }
  }
  return removed
}
