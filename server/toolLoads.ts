import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { store } from './store.ts'
import { byteSize, imagePixelsOf, recordToolCall } from './toolCalls.ts'

/** The canvases a tool call names: `canvas_id`, and the canvases of
 *  `frame_id` / `frame_ids`. */
function argsCanvases(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const { canvas_id, frame_id, frame_ids } = args as Record<string, unknown>
  const ids = new Set<string>()
  if (typeof canvas_id === 'string') ids.add(canvas_id)
  for (const id of [frame_id, ...(Array.isArray(frame_ids) ? frame_ids : [])]) {
    const canvasId = typeof id === 'string' ? store.getFrame(id)?.canvasId : undefined
    if (canvasId) ids.add(canvasId)
  }
  return [...ids]
}

/** Load the canvases a tool call names and hold them while `run` works, so
 *  tools keep reading the store synchronously and a slow one (an import
 *  waiting on another service) keeps its canvas (store.load, store.hold). */
export async function withArgsCanvases<T>(args: unknown, run: () => T | Promise<T>): Promise<T> {
  const canvasIds = argsCanvases(args)
  await Promise.all(canvasIds.map((id) => store.load(id)))
  const releases = canvasIds.map((id) => store.hold(id))
  try {
    return await run()
  } finally {
    for (const release of releases) release()
  }
}

/** Who a recorded call belongs to, from the server's own scope (the OAuth
 *  account behind an MCP connection); the actor's display name rides on the
 *  call's `agent_name` argument like everywhere else. */
export interface ToolCallContext {
  ownerId?: string
  ownerName?: string
}

/** The per-call ledger (shared/toolCalls.ts): wraps one tool callback so its
 *  sizes, image pixels and duration land in `tool_calls`. Metering never
 *  changes or delays the answer. */
function meter<T>(name: string, args: unknown, ctx: ToolCallContext | undefined, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  const record = (result: unknown, failed: boolean) => {
    try {
      recordToolCall({
        canvasId: argsCanvases(args)[0] ?? null,
        source: 'mcp',
        tool: name,
        actorName:
          (args && typeof args === 'object' && typeof (args as Record<string, unknown>).agent_name === 'string'
            ? ((args as Record<string, unknown>).agent_name as string)
            : undefined) ??
          ctx?.ownerName ??
          'agent',
        actorKind: 'agent',
        ownerId: ctx?.ownerId ?? null,
        runId: null,
        inputBytes: byteSize(args),
        resultBytes: byteSize(result),
        imagePixels: imagePixelsOf(result),
        ms: Date.now() - startedAt,
        failed,
        at: startedAt,
      })
    } catch {
      /* the ledger never breaks the call it measures */
    }
  }
  return run().then(
    (result) => {
      record(result, !!(result as { isError?: boolean } | null)?.isError)
      return result
    },
    (error: unknown) => {
      record(undefined, true)
      throw error
    },
  )
}

/** Every tool registered on `server` from here on loads and holds its
 *  canvases, and is recorded in the per-call ledger. A tool with an input
 *  schema is called with (args, extra), one without with (extra) alone. */
export function loadToolTargets(server: McpServer, ctx?: () => ToolCallContext): void {
  type Register = typeof server.registerTool
  type Callback = Parameters<Register>[2]
  const register: Register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: Parameters<Register>[1], callback: Callback) =>
    register(name, config, (async (...params: unknown[]) => {
      /* with an input schema the call is (args, extra); without, (extra) —
        only the first kind carries arguments worth measuring */
      const args = params.length > 1 ? params[0] : undefined
      const forward = async () =>
        meter(name, args, ctx?.(), () => Promise.resolve((callback as (...forwarded: unknown[]) => unknown)(...params)))
      return params.length > 1 ? withArgsCanvases(params[0], forward) : forward()
    }) as unknown as Callback)) as Register
}
