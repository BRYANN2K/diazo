import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { CurationJobView, CurationPlanView } from '../shared/libraryCuration'

/**
 * AI library curation against the REAL server (see ./harness.ts), with the
 * owner's Claude key pointed at a stub of the Messages API (the SDK honours
 * ANTHROPIC_BASE_URL): the stub proposes a tree and files items by their
 * words, so the whole path (routes, job, model routing, apply) runs.
 */

let stub: HttpServer
let stubCalls = 0
let server: Server
let owner: Client
let stranger: Client
let bare: Client
let sourceA: string
let sourceB: string

const TREE = {
  categories: [
    { name: 'Heroes', children: [{ name: 'AI products' }] },
    { name: 'Sections', children: [{ name: 'Pricing' }, { name: 'FAQ' }] },
  ],
}

function answer(system: string, user: string): string {
  if (system.includes('Propose ONE category tree')) return JSON.stringify(TREE)
  const idOf = (path: string) => new RegExp(`^(c\\d+) ${path}$`, 'm').exec(system)?.[1] ?? 'none'
  const a: Record<string, string> = {}
  for (const line of user.split('\n')) {
    const [n, label = ''] = line.split('|')
    const l = label.toLowerCase()
    a[n!] = l.includes('hero')
      ? idOf('Heroes/AI products')
      : l.includes('pricing')
        ? idOf('Sections/Pricing')
        : idOf('Sections/FAQ')
  }
  return JSON.stringify({ a })
}

function sse(text: string): string {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-stub',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    value = await read()
  }
  return value
}

async function addFrame(client: Client, canvas: string, name: string, body: string, y: number) {
  const res = await client.post(`/api/canvases/${canvas}/frames`, {
    name,
    x: 0,
    y,
    width: 800,
    height: 400,
    html: `<!doctype html><html><body>${body}</body></html>`,
  })
  expect(res.status).toBe(200)
  return (await res.json()).id as string
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      stubCalls++
      const parsed = JSON.parse(body) as { system: { text: string }[]; messages: { content: string }[] }
      const text = answer(parsed.system.map((s) => s.text).join('\n'), String(parsed.messages[0]?.content ?? ''))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(text))
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as AddressInfo).port
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  })
  owner = await new Client(server).signUp('cur-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('cur-stranger@test.dev', 'Stranger')
  bare = await new Client(server).signUp('cur-bare@test.dev', 'Bare')
  expect((await owner.post('/api/model-account/anthropic-key', { apiKey: 'sk-ant-test-only-never-sent' })).status).toBe(
    200,
  )
  sourceA = (await (await owner.post('/api/canvases', { name: 'Design Library' })).json()).id
  sourceB = (await (await owner.post('/api/canvases', { name: 'Design Library · B Sections' })).json()).id
  await addFrame(owner, sourceA, 'hero.x-ai — AI hero', '<h1>Ship AI agents faster than ever</h1>', 0)
  await addFrame(owner, sourceA, 'bk.x-pricing — Pricing', '<h2>Simple pricing for every team size</h2>', 500)
  await addFrame(owner, sourceB, 'hero.x-ai — AI hero', '<h1>Ship AI agents faster than ever</h1>', 0)
  await addFrame(owner, sourceB, 'bk.x-faq — Questions', '<h2>Frequently asked questions about billing</h2>', 500)
}, 90_000)

afterAll(() => {
  server?.stop()
  stub?.close()
})

describe('curating through the API', () => {
  let jobId: string

  it('refuses a person without a model account, and sources the caller does not manage', async () => {
    const own = (await (await bare.post('/api/canvases', { name: 'Mine' })).json()).id as string
    const refused = await bare.post('/api/library-curations', { sourceIds: [own] })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toContain('model account')
    expect((await stranger.post('/api/library-curations', { sourceIds: [sourceA] })).status).toBe(404)
    expect((await owner.post('/api/library-curations', { sourceIds: [] })).status).toBe(400)
  })

  it('lists the canvases the caller may curate from', async () => {
    const { sources } = await (await owner.get('/api/library-curations/sources')).json()
    const ids = sources.map((s: { id: string }) => s.id)
    expect(ids).toEqual(expect.arrayContaining([sourceA, sourceB]))
    const theirs = await (await stranger.get('/api/library-curations/sources')).json()
    expect(theirs.sources.map((s: { id: string }) => s.id)).not.toContain(sourceA)
  })

  it('runs a curation on the owner account and proposes a plan', async () => {
    const started = await owner.post('/api/library-curations', { sourceIds: [sourceA, sourceB] })
    expect(started.status).toBe(201)
    const job = (await started.json()) as CurationJobView
    jobId = job.id
    expect(job.name).toBe('Design Library (curated)')
    const ready = await until(
      async () => (await (await owner.get(`/api/library-curations/${jobId}`)).json()) as CurationJobView,
      (j) => j.status === 'ready' || j.status === 'failed',
    )
    expect(ready).toMatchObject({ status: 'ready', error: null, calls: 2 })
    expect(ready.model).toContain('Claude API')
    expect(ready.usage[0]?.inputTokens).toBeGreaterThan(0)
    expect(stubCalls).toBe(2)
    const plan = (await (await owner.get(`/api/library-curations/${jobId}/plan`)).json()) as CurationPlanView
    expect(plan.tree.map((n) => n.name)).toEqual(['Heroes', 'Sections'])
    expect(plan.totals).toMatchObject({ entries: 3, duplicates: 1, unclassified: 0 })
    expect(plan.tree[0]!.children[0]).toMatchObject({ name: 'AI products', count: 1 })
    expect(plan.tree[0]!.children[0]!.samples[0]!.label).toBe('AI hero')
  })

  it('keeps a job to its owner', async () => {
    expect((await stranger.get(`/api/library-curations/${jobId}`)).status).toBe(404)
    expect((await stranger.get(`/api/library-curations/${jobId}/plan`)).status).toBe(404)
    expect(
      (await stranger.patch(`/api/library-curations/${jobId}/plan`, { edits: [{ op: 'delete', id: 'c1' }] })).status,
    ).toBe(404)
    expect((await (await stranger.get('/api/library-curations')).json()).curations).toEqual([])
  })

  it('edits the plan: rename, add, file items, merge; refuses a bad edit whole', async () => {
    const view = (await (await owner.get(`/api/library-curations/${jobId}/plan`)).json()) as CurationPlanView
    const sections = view.tree[1]!
    const [pricing, faq] = sections.children
    const renamed = await owner.patch(`/api/library-curations/${jobId}/plan`, {
      edits: [{ op: 'rename', id: sections.id, name: '21 Marketing sections · A–L' }],
    })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as CurationPlanView).tree[1]!.name).toBe('Marketing sections')
    const items = await (await owner.get(`/api/library-curations/${jobId}/items?category=${faq!.id}`)).json()
    expect(items.items.map((i: { label: string }) => i.label)).toEqual(['Questions'])
    const merged = await owner.patch(`/api/library-curations/${jobId}/plan`, {
      edits: [{ op: 'merge', from: faq!.id, into: pricing!.id }],
    })
    expect(((await merged.json()) as CurationPlanView).tree[1]!.children).toMatchObject([{ name: 'Pricing', count: 2 }])
    const bad = await owner.patch(`/api/library-curations/${jobId}/plan`, {
      edits: [
        { op: 'rename', id: pricing!.id, name: 'Offers' },
        { op: 'delete', id: 'nope' },
      ],
    })
    expect(bad.status).toBe(400)
    const after = (await (await owner.get(`/api/library-curations/${jobId}/plan`)).json()) as CurationPlanView
    expect(after.tree[1]!.children[0]!.name).toBe('Pricing')
    expect((await owner.patch(`/api/library-curations/${jobId}/plan`, { edits: [{ op: 'explode' }] })).status).toBe(400)
  })
})
