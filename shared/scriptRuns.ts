/**
 * One `run_script` / `query_script` execution (change `agent-cost`, spec
 * AC-12): the audit row (`script_runs` table) and the result the tools
 * answer with. The Usage tab renders runs from the same records; revert is
 * `revert_script_run`.
 */

/** What one `diazo.*` call inside a run did. */
export interface ScriptCallRecord {
  /** e.g. `frames.edit`, `checks.measure` */
  fn: string
  /** the id it worked on, when it names one (frame, page, component, item) */
  target?: string
  ms: number
  ok: boolean
  /** failure message when !ok */
  error?: string
}

/** What one write changed, for the audit and the undo. */
export interface ScriptWriteRecord {
  /** e.g. `frames.create`, `tokens.set`, `compositions.patch` */
  fn: string
  target: string
  /** short human description for the activity line */
  detail?: string
}

export type ScriptRunOutcome = 'ok' | 'error' | 'limit' | 'reverted' | 'reverted_partial' | 'dry_run'

/** One entity a writing run touched, stored for undo. `before`/`after` hold
 *  the entity's design fields (derived data like a frame's lint and checks
 *  is not part of the payload and is never compared). Absent `before` means
 *  the run created the entity; absent `after` means it deleted it. */
export interface ScriptEntityUndo {
  kind: 'frame' | 'token' | 'component' | 'composition' | 'tokenThemes' | 'page'
  /** frame id / token name / component id / page id / composition pageId; '' for tokenThemes */
  id: string
  before?: unknown
  after?: unknown
}

/** What a revert reports back: which entities were restored, which it left
 *  alone because a later edit moved them past the recorded state. */
export interface ScriptUndoReport {
  restored: string[]
  unreverted: string[]
}

export interface ScriptRunRecord {
  id: string
  canvasId: string
  actorName: string
  actorKind: 'user' | 'agent'
  ownerId: string | null
  /** 'mcp' | 'resident' — who drove the call */
  source: 'mcp' | 'resident'
  /** the transport the run arrived on: an idempotency key replays only
   *  inside the mode it was used in */
  mode?: 'query' | 'write'
  /** the resident run that contained it, when it was one */
  agentRunId: string | null
  /** sha256 of the script source */
  hash: string
  /** the effective limits the request ran under — part of the idempotency
   *  fingerprint: the same key with a different result cap or timeout is a
   *  different request, not a replay */
  resultCap?: number
  timeoutMs?: number
  /** the script as received (bounded by the runner's script-size limit) */
  sourceScript: string
  /** every SDK call the run made, in order */
  calls: ScriptCallRecord[]
  writes: ScriptWriteRecord[]
  outcome: ScriptRunOutcome
  /** the thrown error's message, or the limit name on 'limit' */
  error?: string
  /** the run's returned value (the script's `return`), JSON */
  result?: unknown
  /** result was cut at the cap; `resultBytes` keeps the full size */
  truncated: boolean
  resultBytes: number
  ms: number
  idempotencyKey: string | null
  dryRun: boolean
  createdAt: number
}

/** What `run_script` and `query_script` answer with. */
export interface ScriptRunResult {
  run_id: string
  ok: boolean
  /** the script's returned value */
  result?: unknown
  /** error message / limit name when !ok */
  error?: string
  code?: 'permission' | 'not_found' | 'invalid' | 'conflict' | 'unavailable' | 'refused' | 'limit' | 'failed'
  writes: ScriptWriteRecord[]
  /** per touched frame, the `checks.review` the write produced */
  checks: Record<string, unknown>
  ms: number
  truncated: boolean
  /** served from the idempotency record rather than executed */
  deduplicated?: boolean
  /** planned writes/checks, nothing applied */
  dry_run?: boolean
  /** after a failed run's automatic rollback: entities that could not be
   *  restored because a later edit changed them (empty = clean rollback) */
  unreverted?: string[]
}

/** The summary get_usage and the Usage tab list: everything about a run
 *  except its source, result payload and undo state, which are served only
 *  on explicit request (a run's record can carry the full script). */
export interface ScriptRunSummary {
  id: string
  hash: string
  outcome: ScriptRunOutcome
  source: 'mcp' | 'resident'
  agentRunId: string | null
  actorName: string
  actorKind: 'user' | 'agent'
  calls: number
  writes: number
  ms: number
  dryRun: boolean
  truncated: boolean
  resultBytes: number
  createdAt: number
}

export function summarizeRun(record: ScriptRunRecord): ScriptRunSummary {
  return {
    id: record.id,
    hash: record.hash,
    outcome: record.outcome,
    source: record.source,
    agentRunId: record.agentRunId,
    actorName: record.actorName,
    actorKind: record.actorKind,
    calls: record.calls.length,
    writes: record.writes.length,
    ms: record.ms,
    dryRun: record.dryRun,
    truncated: record.truncated,
    resultBytes: record.resultBytes,
    createdAt: record.createdAt,
  }
}
