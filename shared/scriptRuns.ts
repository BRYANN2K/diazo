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

export type ScriptRunOutcome = 'ok' | 'error' | 'limit' | 'reverted' | 'dry_run'

export interface ScriptRunRecord {
  id: string
  canvasId: string
  actorName: string
  actorKind: 'user' | 'agent'
  ownerId: string | null
  /** 'mcp' | 'resident' — who drove the call */
  source: 'mcp' | 'resident'
  /** the resident run that contained it, when it was one */
  agentRunId: string | null
  /** sha256 of the script source */
  hash: string
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
}
