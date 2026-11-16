import { and, desc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { scriptRuns } from './db/schema.ts'
import type { Canvas } from '../shared/types.ts'
import type { ScriptRunRecord, ScriptRunResult } from '../shared/scriptRuns.ts'

export interface StoredScriptRun {
  record: ScriptRunRecord
  response?: ScriptRunResult
  before?: Canvas
  after?: Canvas
}

/** Durable audit and replay. Tests replace the repository, never production persistence. */
export const scriptRunDeps = {
  save: async (run: StoredScriptRun) => {
    await db
      .insert(scriptRuns)
      .values({
        id: run.record.id,
        canvasId: run.record.canvasId,
        idempotencyKey: run.record.idempotencyKey,
        createdAt: run.record.createdAt,
        data: run,
      })
      .onConflictDoUpdate({ target: scriptRuns.id, set: { data: run } })
  },
  get: async (id: string): Promise<StoredScriptRun | undefined> => {
    const [row] = await db.select().from(scriptRuns).where(eq(scriptRuns.id, id)).limit(1)
    return row?.data
  },
  byKey: async (canvasId: string, key: string): Promise<StoredScriptRun | undefined> => {
    const [row] = await db
      .select()
      .from(scriptRuns)
      .where(and(eq(scriptRuns.canvasId, canvasId), eq(scriptRuns.idempotencyKey, key)))
      .limit(1)
    return row?.data
  },
  list: async (canvasId: string) => {
    const rows = await db
      .select()
      .from(scriptRuns)
      .where(eq(scriptRuns.canvasId, canvasId))
      .orderBy(desc(scriptRuns.createdAt))
      .limit(100)
    return rows.map((row) => row.data.record)
  },
}
