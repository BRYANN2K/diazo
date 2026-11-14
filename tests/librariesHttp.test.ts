import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { RULE_PRESETS } from '../shared/libraryRules'
import type { LibraryItemDetail, LibrarySearchResult } from '../shared/library'
import { FIXTURE_FRAMES, fixture, type FixtureName } from './libraryFixtures'

/**
 * Design libraries against the REAL server (see ./harness.ts): the row
 * survives a restart, and the REST routes answer by role.
 */

let server: Server
let owner: Client
let member: Client
let visitor: Client
let stranger: Client
let canvasId: string
let otherId: string

async function addFrame(client: Client, canvas: string, name: FixtureName, y: number) {
  const { name: frameName, width, height } = FIXTURE_FRAMES[name]
  const res = await client.post(`/api/canvases/${canvas}/frames`, {
    name: frameName,
    x: 0,
    y,
    width,
    height,
    html: fixture(name),
  })
  expect(res.status).toBe(200)
  return (await res.json()).id as string
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    value = await read()
  }
  return value
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('lib-owner@test.dev', 'Owner')
  member = await new Client(server).signUp('lib-member@test.dev', 'Member')
  visitor = await new Client(server).signUp('lib-visitor@test.dev', 'Visitor')
  stranger = await new Client(server).signUp('lib-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Design Library' })).json()).id
  await addFrame(owner, canvasId, 'sheet-static', 0)
  await addFrame(owner, canvasId, 'sheet-scripted', 600)
  await addFrame(owner, canvasId, 'card-exploded', 1400)
  expect((await owner.post(`/api/canvases/${canvasId}/members`, { email: 'lib-member@test.dev' })).status).toBe(200)
  otherId = (await (await stranger.post('/api/canvases', { name: 'Stranger library' })).json()).id
  await addFrame(stranger, otherId, 'card-exploded', 0)
}, 90_000)

afterAll(() => server?.stop())

describe('converting and reading', () => {
  it('previews, then creates, then indexes', async () => {
    const preview = await (await owner.post('/api/libraries/preview', { canvasId })).json()
    expect(preview.preset).toBe('sheets')
    expect(preview.preview).toMatchObject({ frames: 3, families: 3, variants: 2, scripted: 2 })
    const created = await owner.post('/api/libraries', { canvasId })
    expect(created.status).toBe(201)
    const library = await until(
      async () => (await (await owner.get(`/api/canvases/${canvasId}`)).json()).library,
      (l) => l?.index?.status === 'done',
    )
    expect(library).toMatchObject({ items: 3, variants: 2 })
    const detail = await (await owner.get(`/api/libraries/${canvasId}`)).json()
    expect(detail).toMatchObject({ id: canvasId, role: 'manage', rules: RULE_PRESETS.sheets })
    expect(detail.rulesText.length).toBeGreaterThan(2)
    const list = await (await owner.get('/api/libraries')).json()
    expect(list.libraries.map((l: { id: string }) => l.id)).toEqual([canvasId])
  })

  it('searches families with their variants', async () => {
    const r = (await (await owner.get(`/api/libraries/search?q=login`)).json()) as LibrarySearchResult
    expect(r.hits[0]).toMatchObject({ libraryId: canvasId, item: { id: 'bk.scb-login' }, variantCount: 2 })
    expect(r.hits[0]!.item.thumb).toMatch(/^\/i\/.+\.jpg\?preview$/)
  })

  it('reads one item and its frame html', async () => {
    const item = (await (
      await owner.get(`/api/libraries/${canvasId}/items/bk.scb-login-social-with-email-option`)
    ).json()) as LibraryItemDetail
    expect(item.family?.id).toBe('bk.scb-login')
    expect(item.item.sourceUrl).toBe('https://shadcnblocks.com/blocks/login')
    const html = await (await owner.get(`/api/libraries/${canvasId}/items/bk.scb-login/html`)).json()
    expect(html).toMatchObject({ width: 2040, height: 440, locator: { whole: true }, fidelity: 'frame' })
    expect(html.html).toContain('bk.scb-login-minimal-email-password')
    const browse = (await (await owner.get(`/api/libraries/${canvasId}/items`)).json()) as LibrarySearchResult
    expect(browse.total).toBe(3)
  })
})

describe('roles', () => {
  it('answers 404 to a stranger on every route', async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', `/api/libraries/${canvasId}`],
      ['PATCH', `/api/libraries/${canvasId}`, { description: 'x' }],
      ['DELETE', `/api/libraries/${canvasId}`],
      ['POST', `/api/libraries/${canvasId}/reindex`],
      ['GET', `/api/libraries/${canvasId}/items`],
      ['GET', `/api/libraries/${canvasId}/items/bk.scb-login`],
      ['GET', `/api/libraries/${canvasId}/items/bk.scb-login/html`],
      ['PATCH', `/api/libraries/${canvasId}/items/bk.scb-login`, { tags: ['x'] }],
      ['POST', '/api/libraries/preview', { canvasId }],
      ['POST', '/api/libraries', { canvasId }],
    ]
    for (const [method, url, body] of routes) {
      const res = await stranger.req(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      expect(res.status, `${method} ${url}`).toBe(404)
    }
  })

  it('lets a view-link visitor search but not curate', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
    const r = (await (await visitor.get(`/api/libraries/search?q=login&lib=${canvasId}`)).json()) as LibrarySearchResult
    expect(r.hits.length).toBeGreaterThan(0)
    expect((await visitor.patch(`/api/libraries/${canvasId}/items/bk.scb-login`, { tags: ['dark'] })).status).toBe(404)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
  })

  it('lets an editor curate items but not change the rules', async () => {
    const res = await member.patch(`/api/libraries/${canvasId}/items/bk.scb-login`, { tags: ['Dark', 'auth'] })
    expect(res.status).toBe(200)
    expect((await res.json()).item.tags).toEqual(['dark', 'auth'])
    const rules = await member.patch(`/api/libraries/${canvasId}`, { rules: RULE_PRESETS.blank })
    expect(rules.status).toBe(404)
    const r = (await (await owner.get(`/api/libraries/search?q=tag:dark`)).json()) as LibrarySearchResult
    expect(r.hits.map((h) => h.item.id)).toEqual(['bk.scb-login'])
  })

  it('searches only the libraries the caller may read', async () => {
    expect((await stranger.post('/api/libraries', { canvasId: otherId })).status).toBe(201)
    await until(
      async () => (await (await stranger.get(`/api/canvases/${otherId}`)).json()).library,
      (l) => l?.index?.status === 'done',
    )
    const mine = (await (await owner.get(`/api/libraries/search?q=passkey`)).json()) as LibrarySearchResult
    expect(new Set(mine.hits.map((h) => h.libraryId))).toEqual(new Set([canvasId]))
    const theirs = (await (
      await stranger.get(`/api/libraries/search?q=passkey&lib=${canvasId}`)
    ).json()) as LibrarySearchResult
    expect(theirs.hits).toEqual([])
  })

  it('refuses invalid rules with the parser paths', async () => {
    const res = await owner.patch(`/api/libraries/${canvasId}`, {
      rules: { ...RULE_PRESETS.sheets, lint: { gate: 'nope' } },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.errors.map((e: { path: string }) => e.path)).toContain('lint.gate')
  })

  it('limits searches to 30 per 10 seconds', async () => {
    const busy = await new Client(server).signUp('lib-busy@test.dev', 'Busy')
    for (let i = 0; i < 30; i++) expect((await busy.get('/api/libraries/search?q=x')).status).toBe(200)
    expect((await busy.get('/api/libraries/search?q=x')).status).toBe(429)
  })
})

describe('no route loads a canvas', () => {
  it('reads one frame at a time', () => {
    for (const file of ['libraryRoutes.ts', 'libraryQueries.ts', 'libraryIndex.ts']) {
      const source = readFileSync(path.join(__dirname, '..', 'server', file), 'utf8')
      expect(source, file).not.toMatch(/store\.load\(|withCanvas\(/)
    }
  })
})

describe('libraries across a restart', () => {
  it('keeps a library and mirrors it on the canvas', async () => {
    const fresh = (await (await owner.post('/api/canvases', { name: 'Restart' })).json()).id
    server.stop({ keepData: true })
    await server.stopped
    const pg = new PGlite(path.join(server.dataDir, 'data', 'pg'))
    await pg.query(
      `insert into libraries (canvas_id, description, rules, taxonomy, visibility, rules_version, created_at, updated_at)
       values ($1, 'Mine', $2, $3, 'private', 3, 1, 1)`,
      [fresh, JSON.stringify(RULE_PRESETS.sheets), JSON.stringify({ kinds: [], sources: [], categories: [] })],
    )
    await pg.close()
    server = await startServer({}, server.dataDir)
    const canvas = await (await owner.get(`/api/canvases/${fresh}`)).json()
    expect(canvas.library).toMatchObject({ description: 'Mine', visibility: 'private', rulesVersion: 3, items: 0 })
    const kept = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(kept.library).toMatchObject({ items: 3, variants: 2 })
  }, 90_000)
})
