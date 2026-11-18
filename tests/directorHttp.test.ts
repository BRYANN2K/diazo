import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The director-run REST surface against the REAL server (see ./harness.ts):
 * the three run routes and their roles, and the card route's animate-request
 * validation — the kind is never derived from the card's text.
 */

let server: Server
let owner: Client
let commenter: Client
let outsider: Client
let canvasId: string
let pageId: string
let privateCanvasId: string

beforeAll(async () => {
  /* a free tier so the card route's resident-task allowance lets cards in */
  server = await startServer({ RESIDENT_TASK_LIMIT: '25' })
  owner = await new Client(server).signUp('director-owner@test.dev', 'Owner')
  commenter = await new Client(server).signUp('director-commenter@test.dev', 'Commenter')
  outsider = await new Client(server).signUp('director-outsider@test.dev', 'Outsider')
  const canvas = await (await owner.post('/api/canvases', { name: 'Director' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
  /* the commenter reaches the canvas through a comment-level share link */
  await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })
  const priv = await (await owner.post('/api/canvases', { name: 'Private' })).json()
  privateCanvasId = priv.id
}, 70_000)

afterAll(() => server?.stop())

describe('the animate card route', () => {
  it('creates an animate card from an explicit kind and a valid request', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/cards`, {
      title: 'Animate the hero',
      kind: 'animate',
      animate: { pageId, seconds: 8, passes: 2, freedom: 'balanced' },
    })
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card.kind).toBe('animate')
    expect(card.animate.pageId).toBe(pageId)
    expect(card.animate.passes).toBe(2)
  })

  it('refuses an invalid animate request', async () => {
    for (const animate of [
      undefined,
      {},
      { pageId, mode: 'sideways' },
      { pageId, passes: 9 },
      { pageId, width: 8 },
      { pageId, note: 'x'.repeat(1001) },
    ]) {
      const res = await owner.post(`/api/canvases/${canvasId}/cards`, {
        title: 'Animate',
        kind: 'animate',
        animate,
      })
      expect(res.status, JSON.stringify(animate)).toBe(400)
    }
  })

  it('refuses an animate payload on an ordinary card', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/cards`, {
      title: 'Ordinary card',
      animate: { pageId },
    })
    expect(res.status).toBe(400)
  })

  it('refuses a comment-role caller', async () => {
    const res = await commenter.post(`/api/canvases/${canvasId}/cards`, {
      title: 'Animate',
      kind: 'animate',
      animate: { pageId },
    })
    expect(res.status).toBe(403)
    const plain = await commenter.post(`/api/canvases/${canvasId}/cards`, { title: 'Ordinary' })
    expect(plain.status).toBe(403)
  })
})

describe('the director-run routes', () => {
  it('lists a canvas’s runs for anyone who can view it', async () => {
    const res = await owner.get(`/api/canvases/${canvasId}/director-runs`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [] })
    const asCommenter = await commenter.get(`/api/canvases/${canvasId}/director-runs?pageId=${pageId}&limit=5`)
    expect(asCommenter.status).toBe(200)
  })

  it('keeps a private canvas’s runs private', async () => {
    const res = await outsider.get(`/api/canvases/${privateCanvasId}/director-runs`)
    expect(res.status).toBe(403)
  })

  it('404s an unknown run on get and stop', async () => {
    expect((await owner.get('/api/director-runs/nope')).status).toBe(404)
    expect((await owner.post('/api/director-runs/nope/stop')).status).toBe(404)
    /* the run lookup comes before the role gate: an unknown id is a 404 for
       a commenter too — the edit check only guards a run that exists */
    expect((await commenter.post('/api/director-runs/nope/stop')).status).toBe(404)
  })
})
