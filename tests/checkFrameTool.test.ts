import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { checkOutcomeForAgent } from '../server/frameChecks.ts'
import { RESIDENT_TOOL_NAMES } from '../server/resident.ts'
import { scoreFrameChecks } from '../shared/frameChecks.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'check-frame-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    return await fn(client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('check_frame', () => {
  it('is an MCP tool with a force flag, and a resident tool too', async () => {
    const tool = await withClient(async (c) => (await c.listTools()).tools.find((t) => t.name === 'check_frame'))
    expect(tool).toBeDefined()
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['frame_id', 'force']),
    )
    expect(RESIDENT_TOOL_NAMES).toContain('check_frame')
  })

  it('answers an unknown frame without rendering anything', async () => {
    const result = await withClient((c) =>
      c.callTool({ name: 'check_frame', arguments: { frame_id: 'nope', agent_name: 'Tester' } }),
    )
    const body = JSON.stringify(result.content)
    expect(body).toMatch(/not found|no frame/i)
  })
})

describe('checkOutcomeForAgent', () => {
  it('explains a missing renderer', () => {
    const out = checkOutcomeForAgent({ ok: false, reason: 'no_renderer' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('renderer')
  })

  it('flattens the issues for agents', () => {
    const checks = scoreFrameChecks({
      viewports: [
        {
          width: 375,
          clientWidth: 375,
          scrollWidth: 375,
          elements: [
            {
              selector: '#b',
              elementId: 'b',
              tag: 'button',
              rect: { x: 0, y: 0, w: 20, h: 20 },
              tap: { w: 20, h: 20 },
            },
          ],
        },
      ],
      focus: null,
      htmlHash: 'h',
    })
    const out = checkOutcomeForAgent({ ok: true, checks, reused: false }) as {
      checks: { issues: Record<string, unknown>[] }
    }
    expect(out.checks.issues[0]).toMatchObject({ rule: 'FC-TAP', widths: [375], element: 'b', selector: '#b' })
  })
})
