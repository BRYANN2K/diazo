/**
 * The HTTP layer. Agent keys authenticate the MCP endpoint (server/mcp.ts),
 * not the session-cookie REST API, so every command is one stateless
 * `tools/call` POST to `<server>/mcp`. The key only ever goes into the
 * Authorization header: no error message, log line or thrown value carries it.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface Connection {
  url: string
  key: string
  fetch?: FetchLike
  timeoutMs?: number
}

export class DoopError extends Error {}

interface RpcBody {
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  error?: { message?: string }
}

let nextId = 1

/** Calls one MCP tool and returns its JSON payload (or its text when the tool answers in prose). */
export async function callTool<T = unknown>(
  connection: Connection,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const endpoint = `${connection.url}/mcp`
  const doFetch = connection.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${connection.key}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(connection.timeoutMs ?? 60_000),
    })
  } catch {
    throw new DoopError(`cannot reach ${connection.url} (is the server up and Tailscale connected?)`)
  }
  if (response.status === 401) {
    throw new DoopError('the server refused the agent key (unknown or revoked); mint one in Settings -> Agent keys')
  }
  if (response.status === 403) throw new DoopError('this account is disabled on the server')
  let body: RpcBody
  try {
    body = (await response.json()) as RpcBody
  } catch {
    throw new DoopError(`the server answered ${response.status} without JSON; is ${connection.url} a doop server?`)
  }
  if (!response.ok || body.error) {
    throw new DoopError(body.error?.message ?? `the server answered ${response.status}`)
  }
  const first = body.result?.content?.find((block) => block.type === 'text')?.text ?? ''
  if (body.result?.isError) throw new DoopError(first.replace(/^Error:\s*/, '') || `${name} failed`)
  try {
    return JSON.parse(first) as T
  } catch {
    return first as T
  }
}
