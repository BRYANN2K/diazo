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

  it('takes approved repo values into the canvas, creating and editing tokens', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/token-sync/apply`, {
      tokens: [
        { name: '--color-brand', type: 'color', value: '#0a7cff', themes: { dark: '#66b2ff' } },
        { name: '--radius-md', type: 'radius', value: '8px' },
      ],
    })
    expect(res.status).toBe(200)
    const { results, tokens } = await res.json()
    expect(results.map((r: { result: string }) => r.result).sort()).toEqual(['created', 'updated'])
    const byName = Object.fromEntries(tokens.map((t: { name: string }) => [t.name, t]))
    expect(byName['--color-brand']).toMatchObject({ value: '#0a7cff', themes: { dark: '#66b2ff' } })
    expect(byName['--radius-md']).toMatchObject({ type: 'radius', value: '8px' })
    expect((await owner.post(`/api/canvases/${canvasId}/token-sync/apply`, { tokens: [] })).status).toBe(400)
  })

  it('previews the doop → repo patch, then writes exactly that through apply_patch', async () => {
    const CSS = ':root {\n  --color-brand: #0a7cff;\n  --radius-md: 8px;\n}\n'
    /* the "desktop app": answers each request until `ops` run out */
    const serve = async (ops: string[], seen: { op: string; args: Record<string, unknown> }[]) => {
      for (const want of ops) {
        const { request } = await poll()
        seen.push(request)
        expect(request.op).toBe(want)
        const result =
          request.op === 'list'
            ? { entries: [{ path: 'src/app.css', kind: 'file', size: 60 }], truncated: false }
            : request.op === 'read'
              ? { files: [{ path: 'src/app.css', text: CSS }], truncated: false }
              : { written: ['src/app.css'], repo: 'site' }
        await finish(request.id, result)
      }
    }
    const names = ['--color-extra']
    const seen: { op: string; args: Record<string, unknown> }[] = []
    const device = serve(['list', 'read'], seen)
    await new Promise((r) => setTimeout(r, 300))
    const preview = await owner.post(`/api/canvases/${canvasId}/token-sync/patch`, { names })
    await device
    expect(preview.status).toBe(200)
    const plan = await preview.json()
    expect(plan.names).toEqual(['--color-extra'])
    expect(plan.patch).toContain('+  --color-extra: #333333;')
    expect(plan.summary.files).toEqual([{ path: 'src/app.css', create: false, added: 1, removed: 0 }])

    /* a stale patch is refused before the device is asked to write */
    const staleDevice = serve(['list', 'read'], [])
    await new Promise((r) => setTimeout(r, 300))
    const stale = await owner.post(`/api/canvases/${canvasId}/token-sync/write`, { names, patch: `${plan.patch}x` })
    await staleDevice
    expect(stale.status).toBe(409)

    const writeSeen: { op: string; args: Record<string, unknown> }[] = []
    const writer = serve(['list', 'read', 'apply_patch'], writeSeen)
    await new Promise((r) => setTimeout(r, 300))
    const write = await owner.post(`/api/canvases/${canvasId}/token-sync/write`, { names, patch: plan.patch })
    await writer
    expect(write.status).toBe(200)
    expect((await write.json()).result).toEqual({ written: ['src/app.css'], repo: 'site' })
    expect(writeSeen[2]!.args.patch).toBe(plan.patch)
    expect(String(writeSeen[2]!.args.reason)).toMatch(/Token sync/)
  })
})
