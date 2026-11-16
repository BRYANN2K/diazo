import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * GET /i/<frame>.<ext>?lod=<width>&v=<updatedAt> against the REAL server
 * (tests/harness.ts): the version-stamped stage image is far-future cacheable
 * only while the bytes actually show that design — a stale serve and an
 * unversioned or non-stage ask get the short or no cache. Needs a Chromium
 * for the renders; skips without one.
 */

let server: Server
let owner: Client
let frame: { id: string; updatedAt: number }

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('previews@test.dev', 'Previews')
  const canvas = await (await owner.post('/api/canvases', { name: 'Headers' })).json()
  const res = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Card',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html: '<body><h1>first design</h1></body>',
  })
  frame = await res.json()
}, 70_000)

afterAll(() => server?.stop())

const image = (path: string) => fetch(`${server.base}${path}`)

describe.skipIf(!findBrowserPath())('GET /i/<frame>.<ext>?lod=…', () => {
  it('rejects a width it does not know', async () => {
    const res = await image(`/i/${frame.id}.jpg?lod=bogus&v=${frame.updatedAt}`)
    expect(res.status).toBe(400)
    await res.arrayBuffer()
  })

  it('caches a versioned fresh stage image for a year', async () => {
    const res = await image(`/i/${frame.id}.jpg?lod=256&v=${frame.updatedAt}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('x-doop-preview')).toBeNull()
    await res.arrayBuffer()
  })

  it('short-caches the same image under an old or missing version', async () => {
    for (const query of ['lod=256&v=0', 'lod=256']) {
      const res = await image(`/i/${frame.id}.jpg?${query}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
      await res.arrayBuffer()
    }
  })

  it('serves the stored older design as stale once the frame changes', async () => {
    /* the design moves past what the stored render shows */
    const patched = await (
      await owner.patch(`/api/frames/${frame.id}`, { html: '<body><h1>second design</h1></body>' })
    ).json()
    frame = patched
    /* the stored w256 still shows the first design; its refresh waits out
       the after-write quiet time, so this serve is deterministically stale */
    const res = await image(`/i/${frame.id}.jpg?lod=256&v=${frame.updatedAt}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-doop-preview')).toBe('stale')
    await res.arrayBuffer()
    /* …and never immutable under the new version's URL — an immutable
       response here is the bug this route keys its cache on the version for */
    expect(res.headers.get('cache-control')).not.toContain('immutable')
  })

  it('preserves a standalone shape transparency even when its deferred client asks jpg', async () => {
    const canvas = await (await owner.post('/api/canvases', { name: 'Shapes' })).json()
    const shape = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Shape',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        html: '<body data-doop-canvas-element="true"><div style="width:20px;height:20px;background:red"></div></body>',
      })
    ).json()
    const res = await image(`/i/${shape.id}.jpg?lod=128&v=${shape.updatedAt}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[(info.width * info.height - 1) * info.channels + 3]).toBe(0)
  })

  it('short-caches images that are not versioned stage asks', async () => {
    const res = await image(`/i/${frame.id}.jpg?preview`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    await res.arrayBuffer()
  })
})
