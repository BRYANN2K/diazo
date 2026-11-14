import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { LibrarySearchResult } from '../shared/library'
import { FIXTURE_FRAMES, fixture } from './libraryFixtures'

/**
 * Public libraries against the REAL server with DOOP_PUBLIC_LIBRARIES on:
 * a stranger searches and inserts from one, and still cannot open the
 * canvas, join its room or read its frames over MCP.
 */

let server: Server
let owner: Client
let stranger: Client
let libraryId: string
let strangerKey: string

async function mcpCall(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = (await res.json()) as { result: { isError?: boolean; content: { text?: string }[] } }
  return { isError: !!body.result.isError, text: body.result.content.map((b) => b.text ?? '').join('\n') }
}

beforeAll(async () => {
  server = await startServer({ DOOP_PUBLIC_LIBRARIES: 'true' })
  owner = await new Client(server).signUp('pub-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('pub-stranger@test.dev', 'Stranger')
  libraryId = (await (await owner.post('/api/canvases', { name: 'Public library' })).json()).id
  const { name, width, height } = FIXTURE_FRAMES['sheet-static']
  await owner.post(`/api/canvases/${libraryId}/frames`, { name, width, height, html: fixture('sheet-static') })
  expect((await owner.post('/api/libraries', { canvasId: libraryId })).status).toBe(201)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const lib = (await (await owner.get(`/api/canvases/${libraryId}`)).json()).library
    if (lib?.index?.status === 'done') break
    await new Promise((r) => setTimeout(r, 100))
  }
  strangerKey = (await (await stranger.post('/api/agent-keys', { name: 'stranger-agent' })).json()).secret
}, 90_000)

afterAll(() => server?.stop())

describe('a public library', () => {
  it('is private until its manager makes it public', async () => {
    expect((await stranger.get(`/api/libraries/search?q=login&lib=${libraryId}`)).status).toBe(200)
    const before = (await (
      await stranger.get(`/api/libraries/search?q=login&lib=${libraryId}`)
    ).json()) as LibrarySearchResult
    expect(before.hits).toEqual([])
    expect((await owner.patch(`/api/libraries/${libraryId}`, { visibility: 'public' })).status).toBe(200)
  })

  it('lets a stranger search, browse the shelf and insert into their own frame', async () => {
    const found = (await (
      await stranger.get(`/api/libraries/search?q=login&lib=${libraryId}`)
    ).json()) as LibrarySearchResult
    expect(found.hits[0]?.item.id).toBe('bk.scb-login')
    const shelf = await (await stranger.get('/api/libraries/public')).json()
    expect(shelf.libraries.map((l: { id: string }) => l.id)).toContain(libraryId)
    const mine = (await (await stranger.post('/api/canvases', { name: 'Mine' })).json()).id
    const frame = await (
      await stranger.post(`/api/canvases/${mine}/frames`, {
        name: 'Login',
        html: '<!doctype html><html><body></body></html>',
      })
    ).json()
    const res = await stranger.post(`/api/libraries/${libraryId}/items/bk.scb-login-minimal-email-password/insert`, {
      frameId: frame.id,
    })
    expect(res.status).toBe(200)
  })

  it('never opens the canvas to the stranger', async () => {
    expect((await stranger.get(`/api/canvases/${libraryId}`)).status).not.toBe(200)
    expect(await stranger.joinWs(libraryId)).toMatchObject({ kind: 'closed' })
    const canvas = await (await owner.get(`/api/canvases/${libraryId}`)).json()
    const out = await mcpCall(strangerKey, 'get_frame', { canvas_id: libraryId, frame_id: canvas.frames[0].id })
    expect(out.isError).toBe(true)
  })

  it('refuses public with the flag off', async () => {
    const off = await startServer()
    try {
      const o = await new Client(off).signUp('pub-off@test.dev', 'Off')
      const id = (await (await o.post('/api/canvases', { name: 'Lib' })).json()).id
      await o.post('/api/libraries', { canvasId: id })
      const res = await o.patch(`/api/libraries/${id}`, { visibility: 'public' })
      expect(res.status).toBe(400)
    } finally {
      off.stop()
    }
  }, 90_000)
})
