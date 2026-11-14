import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* Frame → code over the REAL server: the preview reads what the linked repo
   holds at the output paths (the "desktop app" is a raw fetch here) and
   answers a patch — a create for a missing file, a replace for one there. */

let server: Server
let owner: Client
let canvasId: string
let frameId: string

const LINK_ID = '8a2c1e4f-0000-4000-8000-0000000000e1'
const DEVICE = '9b3d2f5a-0000-4000-8000-0000000000e2'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('framecode-owner@test.dev', 'Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Export' })).json()).id
  frameId = (
    await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Pricing',
        html: '<!doctype html><html><head><style>.p { color: red }</style></head><body><p class="p">Hi</p></body></html>',
      })
    ).json()
  ).id
}, 70_000)

afterAll(() => server?.stop())

const poll = () =>
  fetch(`${server.base}/api/local-repo/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
    body: JSON.stringify({ deviceId: DEVICE, grants: [LINK_ID] }),
  }).then((r) => r.json() as Promise<{ request: { id: string; op: string; args: Record<string, unknown> } }>)

const finish = (id: string, result: unknown) =>
  owner.post(`/api/local-repo/finish/${id}`, { deviceId: DEVICE, ok: true, result })

describe('POST /api/frames/:id/code/preview', () => {
  it('validates the request and needs a linked project', async () => {
    expect((await owner.post(`/api/frames/${frameId}/code/preview`, { framework: 'vue' })).status).toBe(400)
    const bad = await owner.post(`/api/frames/${frameId}/code/preview`, { framework: 'react', path: '../x.tsx' })
    expect(bad.status).toBe(400)
    expect((await owner.post(`/api/frames/${frameId}/code/preview`, { framework: 'react' })).status).toBe(409)
  })

  it('diffs the component against what the repo holds', async () => {
    await owner.post(`/api/canvases/${canvasId}/repo`, { linkId: LINK_ID, name: 'site', deviceId: DEVICE })
    const device = poll()
    await new Promise((r) => setTimeout(r, 300))
    const preview = owner.post(`/api/frames/${frameId}/code/preview`, { framework: 'react' })
    const { request } = await device
    expect(request.op).toBe('read')
    expect(request.args.paths).toEqual(['src/components/Pricing.tsx', 'src/components/Pricing.css'])
    await finish(request.id, {
      files: [
        { path: 'src/components/Pricing.tsx', error: 'missing' },
        { path: 'src/components/Pricing.css', text: '.old {}\n' },
      ],
      truncated: false,
    })
    const res = await preview
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.repo).toBe('site')
    expect(body.code.name).toBe('Pricing')
    expect(body.summary.files.map((f: { path: string; create: boolean }) => [f.path, f.create])).toEqual([
      ['src/components/Pricing.tsx', true],
      ['src/components/Pricing.css', false],
    ])
    expect(body.patch).toContain('--- /dev/null\n+++ b/src/components/Pricing.tsx')
    expect(body.patch).toContain('-.old {}')
  })
})
