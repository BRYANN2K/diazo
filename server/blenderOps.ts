/** server/blenderOps.ts — the Blender op relay (phase 4, ADR 0011).
 *  An agent submits an op; the desktop shell claims it through the poll,
 *  runs the allowlisted blender-mcp tool and finishes it. Ops are rows,
 *  not a queue runner — like render jobs and speech jobs. */

import { nanoid } from 'nanoid'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import { blenderOps } from './db/schema.ts'
import { BLENDER_OP_CLASS, BLENDER_OP_TOOLS, type BlenderOp, type BlenderOpTool } from '../shared/blender.ts'

/** a claimed op whose heartbeat stopped is failed on next read */
const CLAIM_TTL_MS = 10 * 60_000
/** a requester may have this many un-finished ops before a 429 */
const MAX_ACTIVE_OPS = 8
/** tool arguments are small JSON; a bigger blob is refused up front */
const MAX_ARGS_CHARS = 64_000

export class BlenderError extends Error {}

function rowToOp(r: typeof blenderOps.$inferSelect): BlenderOp {
  return {
    id: r.id,
    canvasId: r.canvasId,
    tool: r.tool as BlenderOpTool,
    klass: r.klass as BlenderOp['klass'],
    ...(r.args != null ? { args: r.args as Record<string, unknown> } : {}),
    state: r.state as BlenderOp['state'],
    ...(r.result != null ? { result: r.result } : {}),
    ...(r.error != null ? { error: r.error } : {}),
    ...(r.deviceId != null ? { deviceId: r.deviceId } : {}),
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

async function getOp(id: string, fresh = false): Promise<BlenderOp | undefined> {
  const [row] = await db.select().from(blenderOps).where(eq(blenderOps.id, id))
  if (!row) return undefined
  const op = rowToOp(row)
  if (op.state === 'running' && !fresh && Date.now() - op.updatedAt > CLAIM_TTL_MS) {
    await db
      .update(blenderOps)
      .set({ state: 'failed', error: 'the desktop claim went away — resubmit the op', updatedAt: Date.now() })
      .where(eq(blenderOps.id, id))
    return { ...op, state: 'failed', error: 'the desktop claim went away — resubmit the op' }
  }
  return op
}

export const getBlenderOp = getOp

export async function listBlenderOps(userId: string, canvasId: string): Promise<BlenderOp[]> {
  const rows = await db
    .select()
    .from(blenderOps)
    .where(and(eq(blenderOps.requestedBy, userId), eq(blenderOps.canvasId, canvasId)))
  return Promise.all(rows.map((r) => getOp(r.id))).then((ops) => ops.filter((o): o is BlenderOp => o != null))
}

export async function submitBlenderOp(
  userId: string,
  canvasId: string,
  input: { tool: string; args?: unknown },
): Promise<BlenderOp> {
  if (!BLENDER_OP_TOOLS.includes(input.tool as BlenderOpTool)) {
    throw new BlenderError(`tool must be one of ${BLENDER_OP_TOOLS.join(', ')}`)
  }
  let args: Record<string, unknown> | undefined
  if (input.args !== undefined) {
    if (typeof input.args !== 'object' || input.args === null || Array.isArray(input.args)) {
      throw new BlenderError('args must be a JSON object')
    }
    if (JSON.stringify(input.args).length > MAX_ARGS_CHARS) {
      throw new BlenderError(`args are over ${MAX_ARGS_CHARS / 1000}k of JSON`)
    }
    args = input.args as Record<string, unknown>
  }
  const active = await db
    .select({ id: blenderOps.id })
    .from(blenderOps)
    .where(and(eq(blenderOps.requestedBy, userId), inArray(blenderOps.state, ['queued', 'running'])))
  if (active.length >= MAX_ACTIVE_OPS) {
    throw new BlenderError(`at most ${MAX_ACTIVE_OPS} open Blender ops — finish or wait for one first`)
  }
  const tool = input.tool as BlenderOpTool
  const now = Date.now()
  const op: BlenderOp = {
    id: nanoid(12),
    canvasId,
    tool,
    klass: BLENDER_OP_CLASS[tool],
    ...(args !== undefined ? { args } : {}),
    state: 'queued',
    requestedBy: userId,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(blenderOps).values({
    id: op.id,
    canvasId,
    tool: op.tool,
    klass: op.klass,
    args: args ?? null,
    state: op.state,
    requestedBy: userId,
    createdAt: now,
    updatedAt: now,
  })
  return op
}

/** the desktop's poll: claim this person's queued ops, oldest first */
export async function pollBlenderOps(deviceId: string, userId: string, limit = 4): Promise<BlenderOp[]> {
  const queued = await db
    .select()
    .from(blenderOps)
    .where(and(eq(blenderOps.requestedBy, userId), eq(blenderOps.state, 'queued')))
  const claimed: BlenderOp[] = []
  for (const row of queued.slice(0, limit)) {
    const now = Date.now()
    const res = await db
      .update(blenderOps)
      .set({ state: 'running', deviceId, updatedAt: now })
      .where(and(eq(blenderOps.id, row.id), eq(blenderOps.state, 'queued')))
      .returning()
    if (res.length === 1) claimed.push(rowToOp(res[0]!))
  }
  return claimed
}

/** the claiming device's report: a terminal state, or a no-op otherwise */
export async function finishBlenderOp(
  op: BlenderOp,
  input: { state: 'done' | 'failed'; result?: unknown; error?: string },
): Promise<BlenderOp> {
  const now = Date.now()
  const patch =
    input.state === 'done'
      ? { state: 'done' as const, result: (input.result ?? null) as never, error: null, updatedAt: now }
      : { state: 'failed' as const, error: input.error ?? 'blender op failed', updatedAt: now }
  await db.update(blenderOps).set(patch).where(eq(blenderOps.id, op.id))
  const done: BlenderOp = { ...op, state: patch.state, updatedAt: now }
  if (input.state === 'done') {
    done.result = input.result
    delete done.error
  } else {
    done.error = input.error ?? 'blender op failed'
    delete done.result
  }
  return done
}

/** boot: ops left running by a dead desktop fail — a queued op waits */
export async function recoverBlenderOps(): Promise<void> {
  await db
    .update(blenderOps)
    .set({ state: 'failed', error: 'the desktop claim went away — resubmit the op', updatedAt: Date.now() })
    .where(eq(blenderOps.state, 'running'))
}
