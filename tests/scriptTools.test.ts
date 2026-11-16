import { SCRIPT_TOOL_COVERAGE } from '../shared/scriptToolCoverage.ts'
import { sdkPaths } from '../server/scriptSdk.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))
import { buildMcpServer } from '../server/mcp.ts'
import { reloadEnv } from '../server/env.ts'
import { getSdkDocs } from '../server/scriptTools.ts'
import { guideTopic } from '../server/guide.ts'
async function connect(profile?: 'code') {
  const server = buildMcpServer('Owner', 'owner', undefined, profile)
  const client = new Client({ name: 'scripts-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
afterEach(() => {
  vi.unstubAllEnvs()
  reloadEnv()
})
it('serves five compact code tools and keeps the full default profile', async () => {
  const code = await connect('code')
  const full = await connect()
  try {
    const { tools } = await code.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_frame_screenshot',
      'get_guide',
      'get_sdk_docs',
      'query_script',
      'run_script',
    ])
    expect(JSON.stringify(tools).length).toBeLessThan(12000)
    expect((await full.client.listTools()).tools.length).toBeGreaterThan(85)
  } finally {
    await code.close()
    await full.close()
  }
})
it('removes disabled execution tools and refuses direct execution calls', async () => {
  vi.stubEnv('DOOP_AGENT_SCRIPTS', 'false')
  reloadEnv()
  const { client, close } = await connect()
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('run_script')
    const response = await client.callTool({ name: 'run_script', arguments: { canvas_id: 'x', script: 'return 1' } })
    expect(response.isError).toBe(true)
  } finally {
    await close()
  }
})
it('serves namespace docs and a bounded core guide with a final screenshot rule', () => {
  for (const ns of ['canvas', 'frames', 'tokens', 'components', 'libraries', 'checks', 'compositions', 'search']) {
    const docs = getSdkDocs(ns)
    expect(docs.typings).toContain('diazo.' + ns)
    expect(docs.methods.length).toBeGreaterThan(0)
    expect(docs.examples).toHaveLength(2)
  }
  expect(guideTopic('diazo-instructions').length).toBeLessThan(10000)
  expect(guideTopic('scripts')).toContain('full-resolution screenshot')
})

it('accounts for every MCP tool and every named SDK mirror', async () => {
  const { client, close } = await connect()
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(Object.keys(SCRIPT_TOOL_COVERAGE).sort()).toEqual(names)
    const paths = new Set(sdkPaths().map((p) => p.path))
    for (const entry of Object.values(SCRIPT_TOOL_COVERAGE)) {
      if ('sdk' in entry) expect(paths.has(entry.sdk)).toBe(true)
      else expect(entry.excluded.length).toBeGreaterThan(20)
    }
  } finally {
    await close()
  }
})
