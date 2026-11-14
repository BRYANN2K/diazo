import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client, startServer, type Server } from './harness.ts'

/* The component ↔ file mapping over the REAL server: reading is view work,
   writing is edit work, a mapping needs a target that exists, and a path
   that leaves the repo never gets stored. */

let server: Server
let owner: Client
let stranger: Client
let canvasId: string
let frameId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('codelink-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('codelink-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Mapping' })).json()).id
  frameId = (await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Pricing', html: '<p>x</p>' })).json())
    .id
}, 70_000)

afterAll(() => server?.stop())

describe('/api/canvases/:id/code-links', () => {
  it('requires a session and canvas access', async () => {
    expect((await new Client(server).get(`/api/canvases/${canvasId}/code-links`)).status).toBe(401)
    expect((await stranger.get(`/api/canvases/${canvasId}/code-links`)).status).toBe(403)
    const put = await stranger.put(`/api/canvases/${canvasId}/code-links`, {
      targetKind: 'frame',
      targetId: frameId,
      path: 'src/Pricing.tsx',
    })
    expect(put.status).toBe(403)
  })

  it('stores, replaces and clears a frame mapping', async () => {
    expect(await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()).toEqual({ links: [] })
    const first = await owner.put(`/api/canvases/${canvasId}/code-links`, {
      targetKind: 'frame',
      targetId: frameId,
      path: './src/pages//Pricing.astro',
    })
    expect(first.status).toBe(200)
    expect((await first.json()).link).toMatchObject({
      targetKind: 'frame',
      targetId: frameId,
      path: 'src/pages/Pricing.astro',
      exportName: null,
      source: 'manual',
      updatedBy: 'Owner',
    })
    const second = await owner.put(`/api/canvases/${canvasId}/code-links`, {
      targetKind: 'frame',
      targetId: frameId,
      path: 'src/routes/pricing.tsx',
      exportName: 'PricingPage',
      source: 'suggested',
    })
    expect((await second.json()).link).toMatchObject({ path: 'src/routes/pricing.tsx', exportName: 'PricingPage' })
    const { links } = await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()
    expect(links).toHaveLength(1)
    expect(links[0].source).toBe('suggested')
    expect((await owner.delete(`/api/canvases/${canvasId}/code-links/frame/${frameId}`)).status).toBe(200)
    expect((await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()).links).toEqual([])
  })

  it('refuses unsafe paths, bad export names and missing targets', async () => {
    const put = (body: Record<string, unknown>) =>
      owner.put(`/api/canvases/${canvasId}/code-links`, { targetKind: 'frame', targetId: frameId, ...body })
    expect((await put({ path: '../secrets.ts' })).status).toBe(400)
    expect((await put({ path: '/etc/passwd' })).status).toBe(400)
    expect((await put({ path: 'src/a.ts', exportName: 'not-an-identifier' })).status).toBe(400)
    expect((await put({ path: 'src/a.ts', targetKind: 'page' })).status).toBe(400)
    expect((await put({ path: 'src/a.ts', targetId: 'missing-frame' })).status).toBe(404)
    expect((await put({ path: 'src/a.ts', targetKind: 'component', targetId: 'nope' })).status).toBe(404)
    expect((await owner.delete(`/api/canvases/${canvasId}/code-links/page/${frameId}`)).status).toBe(400)
  })

  it('drops the mapping of a deleted frame from the list', async () => {
    const doomed = (
      await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Doomed', html: '<p/>' })).json()
    ).id
    await owner.put(`/api/canvases/${canvasId}/code-links`, {
      targetKind: 'frame',
      targetId: doomed,
      path: 'src/D.tsx',
    })
    expect((await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()).links).toHaveLength(1)
    expect((await owner.delete(`/api/frames/${doomed}`)).status).toBeLessThan(300)
    expect((await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()).links).toEqual([])
  })

  it('lets an MCP agent set and clear a mapping with set_code_link', async () => {
    const { secret } = await (await owner.post('/api/agent-keys', { name: 'Mapper' })).json()
    const agent = new McpClient({ name: 'mapper', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    try {
      const set = await agent.callTool({
        name: 'set_code_link',
        arguments: { canvas_id: canvasId, frame_id: frameId, path: 'src/Pricing.tsx', export_name: 'Pricing' },
      })
      expect(set.isError, JSON.stringify(set.content)).toBeFalsy()
      expect(JSON.stringify(set.content)).toContain('src/Pricing.tsx')
      const both = await agent.callTool({
        name: 'set_code_link',
        arguments: { canvas_id: canvasId, frame_id: frameId, component: 'Button', path: 'src/a.ts' },
      })
      expect(both.isError).toBe(true)
      const { links } = await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()
      expect(links).toEqual([expect.objectContaining({ targetId: frameId, exportName: 'Pricing' })])
      const clear = await agent.callTool({
        name: 'set_code_link',
        arguments: { canvas_id: canvasId, frame_id: frameId, path: null },
      })
      expect(clear.isError).toBeFalsy()
      expect((await (await owner.get(`/api/canvases/${canvasId}/code-links`)).json()).links).toEqual([])
    } finally {
      await agent.close()
    }
  })
})
