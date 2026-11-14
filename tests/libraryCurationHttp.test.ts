import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { CurationJobView, CurationPlanView } from '../shared/libraryCuration'
import type { Canvas } from '../shared/types'

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
  if (system.includes('NEW, empty design library'))
    return JSON.stringify({ categories: [{ name: 'Components', children: [{ name: 'Buttons' }] }, { name: 'Heroes' }] })
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
  it('applies the plan to a new canvas and library, leaving the sources as they were', async () => {
    const before = await Promise.all(
      [sourceA, sourceB].map(async (id) => (await (await owner.get(`/api/canvases/${id}`)).json()) as Canvas),
    )
    expect((await stranger.post(`/api/library-curations/${jobId}/apply`, {})).status).toBe(404)
    const started = await owner.post(`/api/library-curations/${jobId}/apply`, {})
    expect(started.status).toBe(202)
    const done = await until(
      async () => (await (await owner.get(`/api/library-curations/${jobId}`)).json()) as CurationJobView,
      (j) => j.status === 'applied' || j.status === 'failed',
    )
    expect(done).toMatchObject({ status: 'applied', error: null })
    const canvas = (await (await owner.get(`/api/canvases/${done.canvasId}`)).json()) as Canvas
    expect(canvas.name).toBe('Design Library (curated)')
    expect(canvas.pages!.map((p) => p.name)).toEqual(['Heroes/AI products', 'Marketing sections/Pricing'])
    expect(canvas.frames.map((f) => f.name).sort()).toEqual([
      'bk.x-faq — Questions',
      'bk.x-pricing — Pricing',
      'hero.x-ai — AI hero',
    ])
    const library = await until(
      async () => (await (await owner.get(`/api/canvases/${done.canvasId}`)).json()).library,
      (l) => l?.index?.status === 'done',
    )
    expect(library).toMatchObject({ items: 3 })
    const search = await (
      await owner.get(`/api/libraries/${done.canvasId}/items?category=Marketing%20sections/Pricing`)
    ).json()
    expect(search.total).toBe(2)
    const after = await Promise.all(
      [sourceA, sourceB].map(async (id) => (await (await owner.get(`/api/canvases/${id}`)).json()) as Canvas),
    )
    const shape = (cs: Canvas[]) =>
      cs.map((c) => ({ pages: c.pages, frames: c.frames.map((f) => [f.id, f.name, f.updatedAt, f.html]) }))
    expect(shape(after)).toEqual(shape(before))
    expect(after.every((c) => !c.library)).toBe(true)
  })
})

describe('a library from scratch', () => {
  it('suggests starting categories on the owner account, and refuses without one', async () => {
    const r = await owner.post('/api/libraries/suggest-categories', { brief: 'Marketing sites for AI start-ups' })
    expect(r.status).toBe(200)
    expect((await r.json()).categories).toEqual(['Components', 'Components/Buttons', 'Heroes'])
    expect((await bare.post('/api/libraries/suggest-categories', { brief: 'x' })).status).toBe(409)
    expect((await owner.post('/api/libraries/suggest-categories', {})).status).toBe(400)
  })

  it('creates an empty library that indexes, lists and searches, then takes a frame into a category', async () => {
    expect((await owner.post('/api/libraries/new', { name: '  ' })).status).toBe(400)
    const created = await owner.post('/api/libraries/new', {
      name: 'Fresh library',
      description: 'For AI start-ups',
      categories: ['Components/Buttons', '01 Heroes'],
    })
    expect(created.status).toBe(201)
    const id = (await created.json()).id as string
    const library = await until(
      async () => (await (await owner.get(`/api/canvases/${id}`)).json()).library,
      (l) => l?.index?.status === 'done',
    )
    expect(library).toMatchObject({ items: 0, variants: 0, description: 'For AI start-ups' })
    const detail = await (await owner.get(`/api/libraries/${id}`)).json()
    expect(detail.taxonomy.categories.map((c: { path: string }) => c.path)).toEqual([
      'Components',
      'Components/Buttons',
      'Heroes',
    ])
    const list = await (await owner.get('/api/libraries')).json()
    expect(list.libraries.map((l: { id: string }) => l.id)).toContain(id)
    expect((await (await owner.get(`/api/libraries/${id}/items`)).json()).total).toBe(0)
    expect((await stranger.get(`/api/libraries/${id}`)).status).toBe(404)
    /* Add to library… from a frame of another canvas, into a chosen category */
    const other = (await (await owner.post('/api/canvases', { name: 'Work' })).json()).id as string
    const frameId = await addFrame(owner, other, 'Buy button', '<button>Buy now</button>', 0)
    const imported = await owner.post(`/api/libraries/${id}/import`, {
      frameIds: [frameId],
      category: 'Components/Buttons',
    })
    expect(imported.status).toBe(200)
    const items = await until(
      async () =>
        (await (await owner.get(`/api/libraries/${id}/items`)).json()) as {
          total: number
          hits: { item: { category: string } }[]
        },
      (r) => r.total === 1,
    )
    expect(items.hits[0]!.item.category).toBe('Components/Buttons')
  })
})

describe('duplicates on import', () => {
  it('says a frame is already in a library, imports it only when forced, and the check reads every library', async () => {
    const { curations } = await (await owner.get('/api/library-curations')).json()
    const curated = curations.find((c: CurationJobView) => c.status === 'applied').canvasId as string
    await until(
      async () => (await (await owner.get(`/api/canvases/${curated}`)).json()).library,
      (l) => l?.index?.status === 'done',
    )
    const source = (await (await owner.get(`/api/canvases/${sourceA}`)).json()) as Canvas
    const hero = source.frames.find((f) => f.name.startsWith('hero.'))!
    const checked = await (await owner.post('/api/libraries/check', { frameId: hero.id })).json()
    expect(checked.duplicates[0]).toMatchObject({ libraryId: curated, reason: 'same-content', name: 'AI hero' })
    expect((await stranger.post('/api/libraries/check', { frameId: hero.id })).status).toBe(404)
    /* into a fresh library: the curated one already has it */
    const fresh = (await (await owner.post('/api/libraries/new', { name: 'Another' })).json()).id as string
    const refused = await (await owner.post(`/api/libraries/${fresh}/import`, { frameIds: [hero.id] })).json()
    expect(refused.applied[0]).toMatchObject({ frameId: hero.id, duplicate: true })
    expect(refused.report.duplicates[0].matches[0]).toMatchObject({ libraryId: curated, reason: 'same-content' })
    const forced = await (
      await owner.post(`/api/libraries/${fresh}/import`, { frameIds: [hero.id], force: true })
    ).json()
    expect(forced.applied[0].libraryFrameId).toBeTruthy()
  })
})
