/**
 * The per-call ledger (change `agent-cost`, spec AC-1): one record per tool
 * call an agent makes — over MCP or inside a Diazo Agent run — with what it
 * cost to carry through the conversation. Editors read them in the canvas's
 * Usage tab and through `get_usage`; they are stored in the `tool_calls`
 * table (server/db/schema.ts) and surfaced by `usageReport`
 * (server/agentRuns.ts).
 */

/** Where the call was made. */
export type ToolCallSource = 'mcp' | 'resident'

export interface ToolCallRecord {
  id: string
  canvasId: string | null
  /** the canvas that paid, when the call names several — the first */
  source: ToolCallSource
  /** tool name, e.g. `edit_frame_html` or `run_script` */
  tool: string
  /** actor name, kind and owning account as resolveActor produced them */
  actorName: string
  actorKind: 'user' | 'agent'
  /** the account behind the call (OAuth user / resident payer), when known */
  ownerId: string | null
  /** the resident run the call belongs to, when it was one */
  runId: string | null
  /** JSON.stringify of the arguments, in bytes */
  inputBytes: number
  /** JSON.stringify of the result content, in bytes */
  resultBytes: number
  /** pixels of every image in the result (w×h summed), 0 when none */
  imagePixels: number
  /** wall time of the call itself */
  ms: number
  /** the call returned is_error / threw */
  failed: boolean
  at: number
}

/** Rollups the Usage tab shows above the list. */
export interface ToolCallTotals {
  calls: number
  inputBytes: number
  resultBytes: number
  imagePixels: number
  ms: number
  failed: number
  /** per tool name */
  byTool: Record<string, { calls: number; resultBytes: number; imagePixels: number }>
}
