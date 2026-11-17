import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * The turn a person's connected Anthropic key pays for must carry their key
 * alone. A server holding Anthropic credentials of its own —
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_CUSTOM_HEADERS, which the SDK folds
 * into every client — must let none of them ride along to the API (or to
 * whatever ANTHROPIC_BASE_URL the operator pointed it at): a server
 * credential beside the person's would leave who bills ambiguous. The turn
 * goes through pickModel to the real SDK and a loopback endpoint, so the
 * wire headers are the assertion, not a constructor's arguments.
 */
const mocks = vi.hoisted(() => ({ accounts: vi.fn(), stored: vi.fn((): { provider: string }[] => []) }))
vi.mock('../server/db/index.ts', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.stored() }) }) },
}))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: async () => ({ enabled: false }) }))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/modelAccounts.ts')>()),
  getAccounts: mocks.accounts,
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { online: vi.fn(), start: vi.fn() } }))
import { pickModel } from '../server/agentModel.ts'

let endpoint: http.Server
let base = ''
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = []

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/* one complete streamed message ending in end_turn, as the Messages API
   streams it; the SDK only needs the event sequence to resolve finalMessage */
const reply = (res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  )
  res.write(
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  )
  res.write(
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  )
  res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
  )
  res.write(sse('message_stop', { type: 'message_stop' }))
  res.end()
}

beforeAll(async () => {
  endpoint = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      reply(res)
    })
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => endpoint.close(() => resolve())))
afterEach(() => {
  unstubAllEnvs()
  seen.length = 0
  vi.clearAllMocks()
})

it('runs a turn on the connected key alone, the server’s own credentials aside', async () => {
  /* the machine the server runs on has Claude configured for its own use:
     a bearer and custom headers that would bill the person’s calls to it */
  stubEnv('ANTHROPIC_BASE_URL', base)
  stubEnv('ANTHROPIC_AUTH_TOKEN', 'server-oauth-token')
  stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Api-Key: sk-server-hdr\nAuthorization: Bearer server-env-token')
  mocks.accounts.mockResolvedValue([
    {
      kind: 'anthropic-key',
      userId: 'alice',
      apiKey: 'sk-ant-alice',
      model: 'claude-opus-5',
      enabled: true,
      connectedAt: 1,
    },
  ])
  const model = await pickModel('alice')
  expect(model?.provider).toBe('anthropic-key')
  await model!.run({
    system: [{ text: 'Design' }],
    tools: [],
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 1024,
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]!.url).toBe('/v1/messages')
  expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-alice')
  expect(seen[0]!.headers.authorization).toBeUndefined()
})
