import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client, startServer, type Server } from './harness.ts'
import { pullLibrary } from '../scripts/pull-library.ts'

/* scripts/pull-library.ts between two real servers: 3 pages and 12 frames
   arrive as they were, an asset is copied and its URL rewritten, a rerun
   creates nothing, and the source only ever sees reads. */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let from: Server
let to: Server
let fromKey: string
let toKey: string
let toAgent: McpClient
let canvasId: string
let assetUrl: string
const stateDir = mkdtempSync(path.join(tmpdir(), 'pull-library-'))

async function agentKey(server: Server, email: string): Promise<{ key: string; agent: McpClient }> {
  const owner = await new Client(server).signUp(email, 'Owner')
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Puller' })).json()
  const agent = new McpClient({ name: 'pull-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return { key: secret as string, agent }
}

async function call<T>(agent: McpClient, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await agent.callTool({ name, arguments: { agent_name: 'Setup', ...args } })
  const out = (r.content as Array<{ text: string }>)[0]!.text
  if (r.isError) throw new Error(out)
  return JSON.parse(out) as T
}

beforeAll(async () => {
  ;[from, to] = await Promise.all([startServer(), startServer()])
  const source = await agentKey(from, 'pull-from@test.dev')
  fromKey = source.key
  const target = await agentKey(to, 'pull-to@test.dev')
  toKey = target.key
  toAgent = target.agent
  canvasId = (await call<{ id: string }>(source.agent, 'create_canvas', { name: 'Kit' })).id
  const first = (await call<{ pages: Array<{ id: string }> }>(source.agent, 'get_canvas', { canvas_id: canvasId }))
    .pages[0]!.id
  const pageIds = [first]
  for (const name of ['Forms', 'Navigation']) {
    pageIds.push(
      (await call<{ page: { id: string } }>(source.agent, 'create_canvas_page', { canvas_id: canvasId, name })).page.id,
    )
  }
  await call(source.agent, 'set_canvas_pages', {
    canvas_id: canvasId,
    expectedPages: (await call<{ pages: unknown[] }>(source.agent, 'get_canvas', { canvas_id: canvasId })).pages,
    pages: [
      { id: first, name: 'Buttons' },
      { id: pageIds[1], name: 'Forms' },
      { id: pageIds[2], name: 'Navigation' },
    ],
  })
  assetUrl = (await call<{ url: string }>(source.agent, 'upload_asset', { canvas_id: canvasId, data: PNG })).url
  for (let i = 0; i < 12; i++) {
    const img = i === 0 ? `<img src="${assetUrl}" alt="">` : ''
    await call(source.agent, 'create_frame', {
      canvas_id: canvasId,
      pageId: pageIds[i % 3],
      name: `cp.item-${i} — Item ${i}`,
      html: `<!doctype html><html><body><p>Item ${i}</p>${img}</body></html>`,
      x: i * 100,
      y: i * 10,
      width: 300 + i,
      height: 200 + i,
    })
  }
  await source.agent.close()
}, 180_000)

afterAll(async () => {
  await toAgent?.close()
  from?.stop()
  to?.stop()
})

const seen: Array<{ method: string; url: string; tool?: string }> = []
const logged: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(from.base)) {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { params?: { name?: string } }) : null
    seen.push({ method: init?.method ?? 'GET', url, ...(body?.params?.name ? { tool: body.params.name } : {}) })
  }
  return fetch(input, init)
}

const run = () =>
  pullLibrary({ from: from.base, to: to.base, canvas: canvasId, fromKey, toKey, stateDir, fetch: logged })

describe('pull-library', () => {
  it('copies 3 pages and 12 frames, with the asset, and a rerun creates nothing', async () => {
    const dry = await pullLibrary({
      from: from.base,
      to: to.base,
      canvas: canvasId,
      fromKey,
      toKey,
      stateDir,
      dryRun: true,
    })
    expect(dry).toMatchObject({ canvasId: null, created: { pages: 3, frames: 12, assets: 1 } })

    const report = await run()
    expect(report).toMatchObject({ pages: 3, frames: 12, assets: 1, created: { pages: 3, frames: 12, assets: 1 } })
    const copy = await call<{
      name: string
      pages: Array<{ id: string; name: string }>
      frames: Array<Record<string, unknown>>
    }>(toAgent, 'get_canvas', { canvas_id: report.canvasId })
    expect(copy.name).toBe('Kit')
    expect(copy.pages.map((p) => p.name)).toEqual(['Buttons', 'Forms', 'Navigation'])
    expect(copy.frames).toHaveLength(12)
    for (let i = 0; i < 12; i++) {
      const f = copy.frames.find((x) => x.name === `cp.item-${i} — Item ${i}`)!
      expect(f).toMatchObject({ x: i * 100, y: i * 10, width: 300 + i, height: 200 + i })
      expect(f.pageId).toBe(copy.pages[i % 3]!.id)
    }
    const withImage = copy.frames.find((x) => x.name === 'cp.item-0 — Item 0')!
    const html = (await call<{ html: string }>(toAgent, 'get_frame', { frame_id: withImage.id })).html
    expect(html).not.toContain(assetUrl)
    const rewritten = /<img src="([^"]+)"/.exec(html)![1]!
    expect(rewritten.startsWith(to.base)).toBe(true)
    expect((await fetch(rewritten)).status).toBe(200)

    const again = await run()
    expect(again.created).toEqual({ pages: 0, frames: 0, assets: 0 })
    expect(
      (await call<{ frames: unknown[] }>(toAgent, 'get_canvas', { canvas_id: report.canvasId })).frames,
    ).toHaveLength(12)
  }, 120_000)

  it('only read the source', () => {
    expect(seen.length).toBeGreaterThan(0)
    for (const r of seen) {
      if (r.method === 'GET') continue
      expect(r.method).toBe('POST')
      expect(new URL(r.url).pathname).toBe('/mcp')
      expect(['get_canvas', 'get_frame']).toContain(r.tool)
    }
  })
})
