import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { pickTokenFiles } from '../server/tokenSync.ts'

/* Token sync over the REAL server: the repo side rides the same poll bridge
   as every read — here the "desktop app" is a raw fetch answering the list
   and read requests. */

let server: Server
let owner: Client
let canvasId: string

const LINK_ID = '8a2c1e4f-0000-4000-8000-0000000000d1'
const DEVICE = '9b3d2f5a-0000-4000-8000-0000000000d2'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('tokensync-owner@test.dev', 'Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Tokens' })).json()).id
  await owner.post(`/api/canvases/${canvasId}/tokens`, {
    tokens: [
      { name: '--color-brand', type: 'color', value: '#000000' },
      { name: '--color-extra', type: 'color', value: '#333333' },
    ],
  })
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

describe('pickTokenFiles', () => {
  it('reads configs and likely style sheets, never build output', () => {
    expect(
      pickTokenFiles([
        'dist/app.css',
        'src/components/card.css',
        'src/styles/globals.css',
        'tailwind.config.ts',
        'README.md',
      ]),
    ).toEqual(['tailwind.config.ts', 'src/styles/globals.css', 'src/components/card.css'])
  })
})

describe('POST /api/canvases/:id/token-sync', () => {
  it('needs a linked project', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/token-sync`, {})
    expect(res.status).toBe(409)
  })

  it('diffs the repo tokens against the canvas', async () => {
    await owner.post(`/api/canvases/${canvasId}/repo`, { linkId: LINK_ID, name: 'site', deviceId: DEVICE })
    const first = poll()
    await new Promise((r) => setTimeout(r, 300))
    const preview = owner.post(`/api/canvases/${canvasId}/token-sync`, {})
    const { request: list } = await first
    expect(list.op).toBe('list')
    const second = poll()
    await finish(list.id, {
      entries: [
        { path: 'src/app.css', kind: 'file', size: 80 },
        { path: 'dist/app.css', kind: 'file', size: 80 },
      ],
      truncated: false,
    })
    const { request: read } = await second
    expect(read.op).toBe('read')
    expect(read.args.paths).toEqual(['src/app.css'])
    await finish(read.id, {
      files: [{ path: 'src/app.css', text: ':root {\n  --color-brand: #0a7cff;\n  --radius-md: 8px;\n}\n' }],
      truncated: false,
    })
    const res = await preview
    expect(res.status).toBe(200)
    const diff = await res.json()
    expect(diff.repo).toBe('site')
    expect(diff.files).toEqual(['src/app.css'])
    expect(diff.entries.map((e: { kind: string; name: string }) => [e.kind, e.name])).toEqual([
      ['change', '--color-brand'],
      ['add', '--radius-md'],
      ['doop-only', '--color-extra'],
    ])
  })
})
