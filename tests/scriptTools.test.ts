import { SCRIPT_TOOL_COVERAGE } from '../shared/scriptToolCoverage.ts'
import { SCRIPT_TOOL_NAMES } from '../server/scriptTools.ts'
import { sdkPaths } from '../server/scriptSdk.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveComposition: () => {},
  deleteComposition: () => {},
  saveCompositionVersion: () => {},
  saveFrameNow: async () => {},
  loadFrameHtml: async () => [],
}))
import { buildMcpServer } from '../server/mcp.ts'
import { reloadEnv } from '../server/env.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { scriptRunDeps, type StoredScriptRun } from '../server/scriptRuns.ts'
import { getSdkDocs } from '../server/scriptTools.ts'
import { DOOP_GUIDE, guideTopic } from '../server/guide.ts'
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
it('serves six compact code tools and keeps the full default profile', async () => {
  const code = await connect('code')
  const full = await connect()
  try {
    const { tools } = await code.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_frame_screenshot',
      'get_guide',
      'get_sdk_docs',
      'query_script',
      'revert_script_run',
      'run_script',
    ])
    expect(JSON.stringify(tools).length).toBeLessThan(12000)
    const defaultTools = (await full.client.listTools()).tools
    expect(defaultTools.length).toBeGreaterThan(85)
    /* script tools stay opt-in: no default-profile client ever sees them */
    for (const name of SCRIPT_TOOL_NAMES) expect(defaultTools.map((t) => t.name)).not.toContain(name)
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
  for (const ns of ['canvas', 'frames', 'tokens', 'components', 'libraries', 'checks', 'compositions']) {
    const docs = getSdkDocs(ns)
    expect(docs.typings).toContain('diazo.' + ns)
    expect(docs.methods.length).toBeGreaterThan(0)
    expect(docs.examples).toHaveLength(2)
  }
  /* tool-mode agents get the whole guide back — no script-era excerpt */
  expect(guideTopic('diazo-instructions')).toBe(DOOP_GUIDE)
  expect(guideTopic('scripts')).toContain('full-resolution screenshot')
})

it('a failed undo audit save reaches the MCP caller without the stored payloads', async () => {
  /* the refused row bound source, response and undo images — a raw storage
     error can carry any of them, so the transport must get the sanitized
     applied-but-unrecorded outcome only */
  const canvas = store.createCanvas('McpUndo', 'owner')
  const frame = actions.createFrame(
    canvas.id,
    { name: 'F', html: '<html><body><h1 data-doop-id="t">A</h1></body></html>', width: 100, height: 100 },
    { kind: 'user', name: 'Owner', color: '#000' },
  )!
  const rows = new Map<string, StoredScriptRun>()
  vi.spyOn(scriptRunDeps, 'save').mockImplementation(async (r) => {
    rows.set(r.record.id, structuredClone(r))
  })
  vi.spyOn(scriptRunDeps, 'get').mockImplementation(async (id) => structuredClone(rows.get(id)))
  vi.spyOn(scriptRunDeps, 'byKey').mockImplementation(async (c, k) =>
    structuredClone([...rows.values()].find((r) => r.record.canvasId === c && r.record.idempotencyKey === k)),
  )
  const { client, close } = await connect('code')
  try {
    const ran = await client.callTool({
      name: 'run_script',
      arguments: {
        canvas_id: canvas.id,
        script: `await diazo.frames.edit(${JSON.stringify(frame.id)}, [{op:'text',element:'t',text:'B'}]); return 1`,
      },
    })
    expect(ran.isError).toBeFalsy()
    const runId = (JSON.parse((ran.content as { text: string }[])[0]!.text) as { run_id: string }).run_id
    vi.spyOn(scriptRunDeps, 'save').mockRejectedValueOnce(
      new Error('update script_runs — parameters: ["SECRET-MARKER-42","<html>SECRET-MARKER-42</html>"]'),
    )
    const out = await client.callTool({
      name: 'revert_script_run',
      arguments: { canvas_id: canvas.id, run_id: runId },
    })
    expect(out.isError).toBeFalsy()
    const text = (out.content as { text: string }[])[0]!.text
    expect(text).not.toContain('SECRET-MARKER-42')
    const res = JSON.parse(text) as { audited?: boolean; restored?: string[] }
    expect(res.audited).toBe(false)
    expect(res.restored).toContain(`frame:${frame.id}`)
  } finally {
    await close()
    vi.restoreAllMocks()
  }
})

it('accounts for every MCP tool and every named SDK mirror', async () => {
  const { client, close } = await connect()
  try {
    /* the coverage map names every tool any profile can expose: the default
       set plus the script tools only the code profile adds */
    const names = (await client.listTools()).tools.map((t) => t.name)
    const anyProfile = new Set([...names, ...SCRIPT_TOOL_NAMES])
    expect(Object.keys(SCRIPT_TOOL_COVERAGE).sort()).toEqual([...anyProfile].sort())
    const paths = new Set(sdkPaths().map((p) => p.path))
    for (const entry of Object.values(SCRIPT_TOOL_COVERAGE)) {
      if ('sdk' in entry) expect(paths.has(entry.sdk)).toBe(true)
      else expect(entry.excluded.length).toBeGreaterThan(20)
    }
  } finally {
    await close()
  }
})
