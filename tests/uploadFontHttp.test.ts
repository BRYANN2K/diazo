import { request } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CustomFont } from '../shared/fonts.ts'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff2 } from './fontFiles.ts'

/* upload_font against the REAL server: a face lands in the library the
   canvas (or the named workspace) designs with, through the same pipeline as
   Settings → Fonts, for whoever may change that library and nobody else. */

let server: Server
let owner: Client
let mate: Client
let ownerAgent: McpClient
let mateAgent: McpClient
let workspaceId: string

interface Uploaded {
  family?: string
  weight?: string
  style?: string
  css?: string
  upload_url?: string
  library?: unknown
}

async function agentFor(client: Client): Promise<McpClient> {
  const { secret } = await (await client.post('/api/agent-keys', { name: 'Font agent' })).json()
  const agent = new McpClient({ name: 'font-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return agent
}

async function uploadFont(
  agent: McpClient,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; raw: string; json: Uploaded }> {
  const result = await agent.callTool({ name: 'upload_font', arguments: { agent_name: 'Typesetter', ...args } })
  const blocks = result.content as Array<{ type: string; text?: string }>
  const raw = blocks.find((block) => block.type === 'text')?.text ?? ''
  return { isError: result.isError === true, raw, json: result.isError ? {} : JSON.parse(raw) }
}

async function canvasFonts(client: Client, canvasId: string): Promise<CustomFont[]> {
  return (await client.get(`/api/canvases/${canvasId}/fonts`)).json()
}

async function newCanvas(client: Client, body: Record<string, unknown>): Promise<string> {
  return (await (await client.post('/api/canvases', body)).json()).id
}

/** A PUT that only announces its size: the server answers from the header,
 *  without the test racing the body it refuses to read. */
function announce(url: string, bytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'PUT', headers: { 'content-length': String(bytes) } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.flushHeaders()
  })
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('upfont-owner@test.dev', 'Font Owner')
  mate = await new Client(server).signUp('upfont-mate@test.dev', 'Font Mate')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Type Co' })).json()).id
  await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'upfont-mate@test.dev' })
  ownerAgent = await agentFor(owner)
  mateAgent = await agentFor(mate)
}, 70_000)

afterAll(async () => {
  await ownerAgent?.close()
  await mateAgent?.close()
  server?.stop()
})

it('adds a base64 face to the canvas owner’s library and says how to use it', async () => {
  const canvasId = await newCanvas(owner, { name: 'Personal' })
  const { isError, json } = await uploadFont(ownerAgent, {
    canvas_id: canvasId,
    data: woff2({ family: 'Agent Serif', weight: 700, italic: true }).toString('base64'),
  })
  expect(isError).toBe(false)
  expect(json).toMatchObject({
    family: 'Agent Serif',
    weight: '700',
    style: 'italic',
    library: 'personal',
    css: 'font-family: "Agent Serif", sans-serif;',
  })
  expect((await canvasFonts(owner, canvasId)).map((f) => f.family)).toContain('Agent Serif')
})

it('hands out a ticket whose upload lands in the workspace library', async () => {
  const canvasId = await newCanvas(owner, { name: 'Team', workspaceId })
  const ticket = await uploadFont(mateAgent, { canvas_id: canvasId, local_file: true, file_name: 'Ticket.ttf' })
  expect(ticket.json.upload_url).toBeDefined()
  expect(await canvasFonts(owner, canvasId)).toHaveLength(0)

  const sent = await fetch(ticket.json.upload_url!, {
    method: 'PUT',
    body: new Uint8Array(ttf({ family: 'Ticket Grotesk' })),
  })
  expect(sent.status).toBe(200)
  expect(await sent.json()).toMatchObject({
    family: 'Ticket Grotesk',
    weight: '400',
    library: { workspace_id: workspaceId },
  })
  const fonts = await canvasFonts(owner, canvasId)
  expect(fonts.map((f) => [f.family, f.fileName])).toEqual([['Ticket Grotesk', 'Ticket.ttf']])
  /* single use */
  expect(
    (await fetch(ticket.json.upload_url!, { method: 'PUT', body: new Uint8Array(ttf({ family: 'Again' })) })).status,
  ).toBe(410)
})

it('takes workspace_id for a member, and refuses a non-member', async () => {
  const added = await uploadFont(mateAgent, {
    workspace_id: workspaceId,
    data: ttf({ family: 'Named WS' }).toString('base64'),
  })
  expect(added.json).toMatchObject({ family: 'Named WS', library: { workspace_id: workspaceId } })
  const other = (await (await mate.post('/api/workspaces', { name: 'Mate only' })).json()).id
  const refused = await uploadFont(ownerAgent, {
    workspace_id: other,
    data: ttf({ family: 'Nope' }).toString('base64'),
  })
  expect(refused.isError).toBe(true)
  expect(refused.raw).toContain('member')
})

it('refuses a personal canvas library to anyone but its owner', async () => {
  const canvasId = await newCanvas(owner, { name: 'Shared personal' })
  await owner.post(`/api/canvases/${canvasId}/members`, { email: 'upfont-mate@test.dev' })
  const refused = await uploadFont(mateAgent, {
    canvas_id: canvasId,
    data: ttf({ family: 'Intruder' }).toString('base64'),
  })
  expect(refused.isError).toBe(true)
  expect(refused.raw).toContain('only its owner')
  expect((await canvasFonts(owner, canvasId)).map((f) => f.family)).not.toContain('Intruder')
})

it('refuses what is not a font, a missing library, two inputs and a private URL', async () => {
  const canvasId = await newCanvas(owner, { name: 'Refusals' })
  /* a personal canvas shows its owner's whole library: count what is added */
  const before = (await canvasFonts(owner, canvasId)).length
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const notFont = await uploadFont(ownerAgent, { canvas_id: canvasId, data: png.toString('base64') })
  expect(notFont.isError).toBe(true)

  const noLibrary = await uploadFont(ownerAgent, { data: ttf({ family: 'X' }).toString('base64') })
  expect(noLibrary.raw).toContain('name the library')
  const both = await uploadFont(ownerAgent, { canvas_id: canvasId, local_file: true, data: 'AAAA' })
  expect(both.raw).toContain('exactly one')
  const local = await uploadFont(ownerAgent, { canvas_id: canvasId, source_url: 'http://127.0.0.1:1/font.ttf' })
  expect(local.isError).toBe(true)
  expect(await canvasFonts(owner, canvasId)).toHaveLength(before)
})

it('caps a ticketed font at 10 MB, above the 5 MB image limit', async () => {
  const canvasId = await newCanvas(owner, { name: 'Big' })
  const ticket = await uploadFont(ownerAgent, { canvas_id: canvasId, local_file: true })
  const big = await announce(ticket.json.upload_url!, 10 * 1024 * 1024 + 1)
  expect(big.status).toBe(413)
  expect(big.body).toContain('10 MB')
  /* a 6 MB file is no font, but it gets past the size check to the reader */
  const retry = await uploadFont(ownerAgent, { canvas_id: canvasId, local_file: true })
  const mid = await fetch(retry.json.upload_url!, { method: 'PUT', body: new Uint8Array(6 * 1024 * 1024) })
  expect(mid.status).toBe(400)
})
