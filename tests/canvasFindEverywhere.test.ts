import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CanvasFindResult } from '../shared/canvasFind.ts'
import { Client, startServer, type Server } from './harness.ts'

/* ⌘F everywhere answers a library from its index: after a restart, a search
   finds items of the library and text of a project canvas, and only the
   project canvas has its frame HTML loaded for it. */

let server: Server
let owner: Client
let libraryId: string
let projectId: string

beforeAll(async () => {
  const first = await startServer()
  owner = await new Client(first).signUp('find-everywhere@test.dev', 'Owner')
  libraryId = (await (await owner.post('/api/canvases', { name: 'Kit' })).json()).id
  for (const [i, name] of ['cp.otp-input — OTP input', 'cp.otp-sheet — OTP sheet'].entries()) {
    const res = await owner.post(`/api/canvases/${libraryId}/frames`, {
      name,
      x: i * 900,
      width: 800,
      height: 600,
      html: `<!doctype html><html><body><p>${name}</p></body></html>`,
    })
    expect(res.status).toBe(200)
  }
  expect((await owner.post('/api/libraries', { canvasId: libraryId, preset: 'sheets' })).status).toBe(201)
  projectId = (await (await owner.post('/api/canvases', { name: 'App' })).json()).id
  await owner.post(`/api/canvases/${projectId}/frames`, {
    name: 'Login',
    html: '<!doctype html><html><body><p>Enter the OTP code</p></body></html>',
  })
  /* the library's items are written before the restart */
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const lib = (await (await owner.get(`/api/libraries/${libraryId}`)).json()) as { library?: { items?: number } }
    if (lib.library?.items === 2) break
    await new Promise((r) => setTimeout(r, 200))
  }
  first.stop({ keepData: true })
  await first.stopped
  server = await startServer({}, first.dataDir)
  owner = new Client(server)
  const signIn = await owner.post('/api/auth/sign-in/email', {
    email: 'find-everywhere@test.dev',
    password: 'password12345',
  })
  expect(signIn.status).toBe(200)
}, 120_000)

afterAll(() => server?.stop())

async function loaded(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
}

describe('find everywhere', () => {
  it('answers a library from its index, without loading it', async () => {
    const before = await loaded()
    const result = (await (await owner.get('/api/find?q=otp')).json()) as CanvasFindResult
    const fromLibrary = result.hits.filter((h) => h.canvasId === libraryId)
    expect(fromLibrary.map((h) => h.item?.id).sort()).toEqual(['cp.otp-input', 'cp.otp-sheet'])
    expect(fromLibrary.every((h) => h.where === 'name' && h.frameId && h.pageName)).toBe(true)
    expect(result.hits.some((h) => h.canvasId === projectId && h.where === 'text')).toBe(true)
    expect(await loaded()).toBe(before + 1)
  })

  it('does the same for find_in_canvas without a canvas', async () => {
    const { secret } = await (await owner.post('/api/agent-keys', { name: 'Finder' })).json()
    const agent = new McpClient({ name: 'find-client', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    try {
      const r = await agent.callTool({ name: 'find_in_canvas', arguments: { query: 'otp' } })
      expect(r.isError).toBeFalsy()
      const body = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as {
        hits: Array<{ canvas_id: string; item_id?: string }>
      }
      expect(body.hits.filter((h) => h.canvas_id === libraryId).map((h) => h.item_id)).toContain('cp.otp-input')
    } finally {
      await agent.close()
    }
  })
})
