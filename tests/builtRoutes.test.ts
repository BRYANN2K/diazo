import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Built page routes against the real server: the hook's settings CRUD (the
 * secret leaves once), the delivery's signature ladder and payload checks,
 * and a delivery that runs to its report. The accepted delivery points at a
 * `.example` host, which never resolves — so the background capture fails
 * at its DNS check, before any browser starts.
 */

let server: Server
let BASE: string

beforeAll(async () => {
  server = await startServer()
  BASE = server.base
}, 70_000)

afterAll(() => server?.stop())

const sign = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

const deliver = (
  canvasId: string,
  payload: unknown,
  secret: string,
  options: { timestamp?: number; signature?: string; raw?: string } = {},
) => {
  const body = options.raw ?? JSON.stringify(payload)
  const timestamp = options.timestamp ?? Date.now()
  return fetch(`${BASE}/api/canvases/${canvasId}/built`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Doop-Timestamp': String(timestamp),
      'X-Doop-Signature': options.signature ?? sign(secret, timestamp, body),
    },
    body,
  })
}

describe('built page routes', () => {
  let owner: Client
  let stranger: Client
  let canvasId: string
  let frameId: string
  let secret: string

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('built-owner@test.dev', 'Owner')
    await stranger.signUp('built-stranger@test.dev', 'Stranger')
    canvasId = (await (await owner.post('/api/canvases', { name: 'built' })).json()).id
    frameId = (
      await (
        await owner.post(`/api/canvases/${canvasId}/frames`, {
          name: 'Pricing',
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          html: '<p>pricing</p>',
        })
      ).json()
    ).id
  })

  it('needs a session and durable access to manage the hook', async () => {
    const anon = new Client(server)
    expect((await anon.get(`/api/canvases/${canvasId}/built-hook`)).status).toBe(401)
    expect([403, 404]).toContain((await stranger.get(`/api/canvases/${canvasId}/built-hook`)).status)
    expect([403, 404]).toContain((await stranger.post(`/api/canvases/${canvasId}/built-hook`)).status)
  })

  it('answers 404 to a delivery on a canvas without a hook', async () => {
    const res = await deliver(canvasId, { deployUrl: 'https://x.example', routes: ['/'] }, 'bhsec_nope')
    expect(res.status).toBe(404)
  })

  it('creates the hook and shows the secret once', async () => {
    expect(await (await owner.get(`/api/canvases/${canvasId}/built-hook`)).json()).toEqual({ hook: null })
    const created = await (await owner.post(`/api/canvases/${canvasId}/built-hook`)).json()
    expect(created.secret).toMatch(/^bhsec_/)
    expect(created.hook.endpoint).toContain(`/api/canvases/${canvasId}/built`)
    secret = created.secret
    const read = await (await owner.get(`/api/canvases/${canvasId}/built-hook`)).json()
    expect(read.hook.id).toBe(created.hook.id)
    expect(JSON.stringify(read)).not.toContain(secret)
  })

  it('stores route mappings by frame name and refuses unknown frames', async () => {
    const bad = await owner.put(`/api/canvases/${canvasId}/built-hook/mappings`, {
      mappings: [{ route: '/pricing', frame: 'Nope' }],
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/Nope/)
    const ok = await owner.put(`/api/canvases/${canvasId}/built-hook/mappings`, {
      mappings: [{ route: '/pricing/', frame: 'pricing' }],
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).hook.mappings).toEqual([{ route: '/pricing', frameId, frameName: 'Pricing' }])
  })

  it('refuses unsigned, mis-signed and stale deliveries', async () => {
    const payload = { deployUrl: 'https://x.example', routes: ['/'] }
    expect((await deliver(canvasId, payload, 'bhsec_wrong')).status).toBe(401)
    expect((await deliver(canvasId, payload, secret, { signature: 'sha256=00' })).status).toBe(401)
    expect((await deliver(canvasId, payload, secret, { timestamp: Date.now() - 10 * 60_000 })).status).toBe(401)
    const unsigned = await fetch(`${BASE}/api/canvases/${canvasId}/built`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(unsigned.status).toBe(401)
  })

  it('validates the payload once the signature holds', async () => {
    expect((await deliver(canvasId, null, secret, { raw: 'not json' })).status).toBe(400)
    expect((await deliver(canvasId, { deployUrl: 'ftp://x.example', routes: ['/'] }, secret)).status).toBe(400)
    expect((await deliver(canvasId, { deployUrl: 'https://x.example', routes: ['nope'] }, secret)).status).toBe(400)
    const local = await deliver(canvasId, { deployUrl: 'http://localhost:3000', routes: ['/'] }, secret)
    expect(local.status).toBe(422)
  })

  it('accepts a signed delivery and reports it on the hook', async () => {
    const res = await deliver(canvasId, { deployUrl: 'https://x.example', routes: ['/pricing'], commit: 'abc' }, secret)
    expect(res.status).toBe(202)
    const { delivery } = await res.json()
    expect(delivery).toMatchObject({ status: 'running', deployUrl: 'https://x.example', commit: 'abc' })

    let last: { id: string; status: string; routes: { route: string; status: string; error?: string }[] } | undefined
    for (let i = 0; i < 100; i++) {
      last = (await (await owner.get(`/api/canvases/${canvasId}/built-hook`)).json()).hook.lastDelivery
      if (last?.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(last).toMatchObject({ id: delivery.id, status: 'done' })
    expect(last!.routes).toEqual([expect.objectContaining({ route: '/pricing', status: 'failed' })])
    /* the Built page exists even when every capture failed */
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.pages.map((p: { name: string }) => p.name)).toContain('Built')
  })

  it('rotates the secret: the old one stops working', async () => {
    const rotated = await (await owner.post(`/api/canvases/${canvasId}/built-hook`)).json()
    expect(rotated.secret).not.toBe(secret)
    const payload = { deployUrl: 'https://x.example', routes: ['/'] }
    expect((await deliver(canvasId, payload, secret)).status).toBe(401)
    secret = rotated.secret
  })

  it('deletes the hook: deliveries get a 404', async () => {
    expect((await owner.delete(`/api/canvases/${canvasId}/built-hook`)).status).toBe(200)
    expect((await deliver(canvasId, { deployUrl: 'https://x.example', routes: ['/'] }, secret)).status).toBe(404)
  })
})
