import { createHash, randomUUID } from 'node:crypto'
import { env } from './env.ts'
import { store } from './store.ts'
import { canvasRole } from './access.ts'
import { roleAllows } from '../shared/canvasRole.ts'
import type { Actor } from '../shared/types.ts'
import type { ScriptRunRecord, ScriptRunResult } from '../shared/scriptRuns.ts'
import { dispatchScriptCall, finishScriptReviews, sdkPaths, SdkError, type ScriptRunContext } from './scriptSdk.ts'
import { runInSandbox, stripTypes, SCRIPT_LIMITS } from './scriptSandbox.ts'
import { scriptRunDeps, type StoredScriptRun } from './scriptRuns.ts'
import { logActivity, restoreScriptState, scriptActivityRuns } from './actions.ts'

export interface ScriptInput {
  script: string
  idempotency_key?: string
  dry_run?: boolean
  result_cap?: number
  timeout_ms?: number
}
export interface ScriptCaller {
  canvasId: string
  userId?: string
  actor: Actor
  source: 'mcp' | 'resident'
}

export async function executeScript(
  input: ScriptInput,
  caller: ScriptCaller,
  write: boolean,
): Promise<ScriptRunResult> {
  if (!env.DOOP_AGENT_SCRIPTS) throw new SdkError('refused', 'agent scripts are disabled')
  await store.load(caller.canvasId)
  const release = store.hold(caller.canvasId)
  try {
    return await serializeScript(caller.canvasId, async () => {
      if (!env.DOOP_AGENT_SCRIPTS) throw new SdkError('refused', 'agent scripts are disabled')
      const canvas = store.getCanvas(caller.canvasId)
      if (!canvas) throw new SdkError('not_found', 'the canvas is gone')
      if (!roleAllows(canvasRole(caller.userId, canvas), write ? 'edit' : 'view'))
        throw new SdkError('permission', 'canvas access refused')
      if (input.idempotency_key && input.idempotency_key.length > 200)
        throw new SdkError('invalid', 'idempotency_key exceeds 200 characters')
      if (
        input.result_cap !== undefined &&
        (!Number.isInteger(input.result_cap) || input.result_cap < 1 || input.result_cap > SCRIPT_LIMITS.resultBytesMax)
      )
        throw new SdkError('invalid', `result_cap must be 1..${SCRIPT_LIMITS.resultBytesMax}`)
      if (
        input.timeout_ms !== undefined &&
        (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > SCRIPT_LIMITS.wallMsMax)
      )
        throw new SdkError('invalid', `timeout_ms must be 1..${SCRIPT_LIMITS.wallMsMax}`)
      return execute(input, caller, write)
    })
  } finally {
    release()
  }
}

/** Per-canvas serialization includes queries and undo. A rejected run cannot poison the queue. */
const queues = new Map<string, Promise<unknown>>()
export async function serializeScript<T>(canvasId: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(canvasId) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(fn)
  queues.set(canvasId, next)
  try {
    return await next
  } finally {
    if (queues.get(canvasId) === next) queues.delete(canvasId)
  }
}

function gate(caller: ScriptCaller, write: boolean): void {
  if (!env.DOOP_AGENT_SCRIPTS) throw new SdkError('refused', 'agent scripts are disabled')
  const canvas = store.getCanvas(caller.canvasId)
  if (!canvas) throw new SdkError('not_found', 'the canvas is gone')
  if (!roleAllows(canvasRole(caller.userId, canvas), write ? 'edit' : 'view'))
    throw new SdkError('permission', 'insufficient canvas access')
}

async function execute(input: ScriptInput, caller: ScriptCaller, write: boolean): Promise<ScriptRunResult> {
  if (input.idempotency_key) {
    const prior = await scriptRunDeps.byKey(caller.canvasId, input.idempotency_key)
    if (prior?.response) return { ...prior.response, deduplicated: true }
    if (prior)
      throw new SdkError('conflict', 'the previous run was interrupted; inspect its audit record before retrying')
  }
  const started = Date.now()
  const id = randomUUID()
  /* script calls inherit the caller's resident runId when one exists — a
     resident replay or rollback then sees the writes its script made — and
     carry this run's id in scriptRunId so activity is summarized, not flooded */
  const actor = { ...caller.actor, scriptRunId: id }
  const record: ScriptRunRecord = {
    id,
    canvasId: caller.canvasId,
    actorName: actor.name,
    actorKind: actor.kind === 'user' ? 'user' : 'agent',
    ownerId: caller.userId ?? null,
    source: caller.source,
    agentRunId: caller.actor.runId ?? null,
    hash: createHash('sha256').update(input.script).digest('hex'),
    sourceScript: input.script.slice(0, SCRIPT_LIMITS.scriptBytes),
    calls: [],
    writes: [],
    outcome: 'error',
    error: 'execution interrupted before completion',
    truncated: false,
    resultBytes: 0,
    ms: 0,
    idempotencyKey: input.idempotency_key ?? null,
    dryRun: !!input.dry_run,
    createdAt: started,
  }
  const saved: StoredScriptRun = { record }
  await scriptRunDeps.save(saved)
  const ctx: ScriptRunContext = {
    canvasId: caller.canvasId,
    userId: caller.userId,
    actor,
    write,
    active: true,
    dryRun: !!input.dry_run,
    runId: id,
    budgets: { frameWrites: SCRIPT_LIMITS.frameWrites },
    snapshots: new Map(),
    writes: [],
    changedFrames: new Set(),
  }
  const checks: Record<string, unknown> = {}
  let pending = Promise.resolve()
  scriptActivityRuns.add(id)
  let result: ScriptRunResult
  try {
    if (Buffer.byteLength(input.script) > SCRIPT_LIMITS.scriptBytes)
      throw new SdkError('limit', 'script_size limit reached', 'script_size')
    // Transform a function body so top-level return and await are valid TypeScript.
    const wrapped = stripTypes(`async function __script__() {\n${input.script}\n}`)
    const source = wrapped + '\nreturn await __script__()'
    const outcome = await runInSandbox({
      source,
      timeoutMs: input.timeout_ms,
      paths: sdkPaths()
        .filter((p) => write || !p.write)
        .map((p) => p.path),
      runInfo: { runId: id, canvasId: caller.canvasId, dryRun: ctx.dryRun },
      onClose: () => {
        ctx.active = false
      },
      call: (path, args) => {
        const work = pending.then(async () => {
          if (!ctx.active) throw new SdkError('limit', 'wall limit reached', 'wall')
          const out = await dispatchScriptCall(ctx, path, args)
          if (out && typeof out === 'object' && 'review' in out) {
            const target = path === 'frames.create' && 'id' in out ? String(out.id) : String(args[0])
            checks[target] = out.review
          }
          return out
        })
        pending = work.then(
          () => {},
          () => {},
        )
        return work
      },
    })
    await pending
    record.calls = outcome.calls.map((c) => ({ fn: c.path, target: c.target, ms: c.ms, ok: c.ok }))
    if (!outcome.ok) throw new SdkError(outcome.limit ? 'limit' : 'failed', outcome.error, outcome.limit)
    ctx.active = false
    /* the rendered pass happens now: one review per changed frame, outside
       the guest's wall budget */
    Object.assign(checks, ctx.checks, await finishScriptReviews(ctx))
    const json = JSON.stringify(outcome.value ?? null)
    record.resultBytes = Buffer.byteLength(json)
    record.truncated = record.resultBytes > (input.result_cap ?? SCRIPT_LIMITS.resultBytes)
    const value = record.truncated
      ? {
          preview: Buffer.from(json)
            .subarray(0, input.result_cap ?? SCRIPT_LIMITS.resultBytes)
            .toString('utf8'),
          fullBytes: record.resultBytes,
        }
      : outcome.value
    record.outcome = ctx.dryRun ? 'dry_run' : 'ok'
    record.error = undefined
    record.result = value
    result = {
      run_id: id,
      ok: true,
      result: value,
      writes: [],
      checks,
      ms: Date.now() - started,
      truncated: record.truncated,
      ...(ctx.dryRun ? { dry_run: true } : {}),
    }
  } catch (error) {
    ctx.active = false
    await pending
    let unreverted: string[] = []
    if (!ctx.dryRun && ctx.undo?.size) {
      /* roll back what the failed run wrote, entity by entity — whatever a
         collaborator moved in the meantime is reported, not clobbered */
      const report = restoreScriptState([...ctx.undo.values()], caller.canvasId, actor)
      unreverted = report.unreverted
    }
    record.outcome = error instanceof SdkError && error.code === 'limit' ? 'limit' : 'error'
    record.error = error instanceof Error ? error.message : String(error)
    result = {
      run_id: id,
      ok: false,
      error: record.error,
      code: error instanceof SdkError ? error.code : 'failed',
      writes: [],
      checks: {},
      ms: Date.now() - started,
      truncated: false,
      ...(unreverted.length ? { unreverted } : {}),
    }
  } finally {
    ctx.active = false
    scriptActivityRuns.delete(id)
  }
  record.writes = ctx.writes.map((w) => ({ fn: w.path, target: w.frameId ?? caller.canvasId }))
  record.ms = Date.now() - started
  result.writes = record.writes
  result.ms = record.ms
  /* persist the entities the run changed — nothing for queries, dry runs
     or runs that wrote but landed back where they started */
  if (!ctx.dryRun && ctx.undo?.size) {
    const entries = [...ctx.undo.values()].filter(
      (e) => JSON.stringify(e.before ?? null) !== JSON.stringify(e.after ?? null),
    )
    if (entries.length) saved.undo = entries
  }
  saved.response = result
  await scriptRunDeps.save(saved)
  logActivity(caller.canvasId, actor, `script ${id}: ${record.outcome} (${record.writes.length} writes)`)
  return result
}

export async function revertScriptRun(
  runId: string,
  caller: ScriptCaller,
): Promise<{ ok: true; run_id: string; restored: string[]; unreverted: string[] }> {
  gate(caller, true)
  return serializeScript(caller.canvasId, async () => {
    if (!roleAllows(canvasRole(caller.userId, store.getCanvas(caller.canvasId)!), 'edit'))
      throw new SdkError('permission', 'edit access required')
    const saved = await scriptRunDeps.get(runId)
    if (!saved || saved.record.canvasId !== caller.canvasId)
      throw new SdkError('not_found', 'no script run on this canvas')
    if (saved.record.outcome === 'reverted' || saved.record.outcome === 'reverted_partial')
      return { ok: true, run_id: runId, restored: [], unreverted: [] }
    if (saved.record.outcome !== 'ok' || !saved.undo?.length)
      throw new SdkError('invalid', 'only successful writes can be reverted')
    const report = restoreScriptState(saved.undo, caller.canvasId, caller.actor)
    saved.record.outcome = report.unreverted.length ? 'reverted_partial' : 'reverted'
    await scriptRunDeps.save(saved)
    logActivity(
      caller.canvasId,
      caller.actor,
      report.unreverted.length
        ? `reverted script ${runId} except ${report.unreverted.length} entit${
            report.unreverted.length === 1 ? 'y' : 'ies'
          }`
        : `reverted script ${runId}`,
    )
    return { ok: true, run_id: runId, restored: report.restored, unreverted: report.unreverted }
  })
}
