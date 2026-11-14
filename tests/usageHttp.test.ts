import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { UsageReport } from '../shared/agentRuns'
import { Client, startServer, type Server } from './harness.ts'

/* The usage meter end to end on a real server: the agent_runs migration
   applies, the Usage tab's route answers editors only, and get_usage reads
   the same report over MCP. */

let server: Server
let owner: Client
let stranger: Client
let agent: McpClient
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('usage-owner@test.dev', 'Usage Owner')
  stranger = await new Client(server).signUp('usage-stranger@test.dev', 'Usage Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Metered' })).json()).id
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Usage agent' })).json()
  agent = new McpClient({ name: 'usage-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

it('reports an empty ledger to the canvas editor and nothing to a stranger', async () => {
  const res = await owner.get(`/api/canvases/${canvasId}/usage`)
  expect(res.status).toBe(200)
  const report: UsageReport = await res.json()
  expect(report.runs).toEqual([])
  expect(report.total).toMatchObject({ runs: 0, costUsd: 0, unpricedRuns: 0 })
  expect((await stranger.get(`/api/canvases/${canvasId}/usage`)).ok).toBe(false)
})

it('answers get_usage over MCP with the same report', async () => {
  const result = await agent.callTool({ name: 'get_usage', arguments: { canvas_id: canvasId, agent_name: 'Tester' } })
  expect(result.isError).toBeFalsy()
  const [first] = result.content as { type: string; text: string }[]
  const report = JSON.parse(first!.text) as UsageReport
  expect(report).toMatchObject({ runs: [], byModel: [], total: { runs: 0 } })
})

it('answers 404 for a run that left nothing on the canvas, after querying the run tables', async () => {
  expect((await owner.get(`/api/canvases/${canvasId}/runs/no-such-run`)).status).toBe(404)
  expect((await stranger.get(`/api/canvases/${canvasId}/runs/no-such-run`)).ok).toBe(false)
})
