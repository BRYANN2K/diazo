import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { Composition } from '../shared/motion.ts'

/**
 * Motion Studio REST + room against the REAL server (see ./harness.ts):
 * the timeline routes and their roles, the playhead relay, the render job
 * lifecycle through upload, and that a reboot keeps compositions while
 * marking interrupted jobs failed.
 */

let server: Server
let owner: Client
let outsider: Client
let canvasId: string
let pageId: string
let ownerKey: string

const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(64)])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)])

const COMP_BODY = {
  duration: 6,
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [
    {
      id: 'cam',
      kind: 'camera',
      name: 'Camera',
      keyframes: [
        { id: 'k1', property: 'x', t: 0, value: 0 },
        { id: 'k2', property: 'x', t: 6, value: 800, easing: 'ease-in-out' },
      ],
    },
  ],
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('motion-owner@test.dev', 'Owner')
  outsider = await new Client(server).signUp('motion-outsider@test.dev', 'Outsider')
  const canvas = await (await owner.post('/api/canvases', { name: 'Motion' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'motion-agent' })).json()).secret
}, 70_000)

afterAll(() => server?.stop())

const compUrl = () => `/api/canvases/${canvasId}/pages/${pageId}/composition`

async function mcpCall(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text?: string }[] } }
  /* text = the payload block; nudge text blocks the server appends ride in rest */
  return {
    isError: !!body.result.isError,
    text: body.result.content[0]?.text ?? '',
    rest: body.result.content
      .slice(1)
      .map((b) => b.text ?? '')
      .join('\n'),
  }
}

describe('composition REST + access gates', () => {
  it('starts empty, rejects bad bodies and non-editors, then round-trips', async () => {
    expect((await (await owner.get(compUrl())).json()).composition).toBeNull()
    expect((await outsider.get(compUrl())).status).toBe(403)
    expect((await owner.put(compUrl(), { duration: 'six' })).status).toBe(400)
    expect((await outsider.put(compUrl(), COMP_BODY)).status).toBe(403)

    const put = await owner.put(compUrl(), COMP_BODY)
    expect(put.status).toBe(200)
    const comp = (await put.json()).composition as Composition
    expect(comp).toMatchObject({ canvasId, pageId, duration: 6, fps: 30, revision: 1 })
    expect(comp.tracks).toHaveLength(1)
    expect(comp.updatedBy).toBe('Owner')

    const got = (await (await owner.get(compUrl())).json()).composition as Composition
    expect(got.id).toBe(comp.id)
  })

  it('applies ops, bumps the revision and conflicts on a stale expectedRevision', async () => {
    const comp = (await (await owner.get(compUrl())).json()).composition as Composition
    const stale = await owner.patch(compUrl(), {
      expectedRevision: comp.revision + 9,
      ops: [{ op: 'set_meta', duration: 8 }],
    })
    expect(stale.status).toBe(409)

    const patch = await owner.patch(compUrl(), {
      expectedRevision: comp.revision,
      ops: [
        { op: 'set_meta', duration: 8 },
        { op: 'add_keyframe', trackId: 'cam', keyframe: { id: 'k3', property: 'zoom', t: 4, value: 1.4 } },
      ],
    })
    expect(patch.status).toBe(200)
    const patched = (await patch.json()).composition as Composition
    expect(patched.revision).toBe(comp.revision + 1)
    expect(patched.duration).toBe(8)
    expect(patched.tracks[0]?.keyframes).toHaveLength(3)

    expect(
      (
        await owner.patch(compUrl(), {
          ops: [{ op: 'add_keyframe', trackId: 'nope', keyframe: { id: 'x', property: 'x', t: 0, value: 0 } }],
        })
      ).status,
    ).toBe(400)
  })

  it('deletes the timeline and survives a reboot', async () => {
    expect((await owner.delete(compUrl())).status).toBe(200)
    expect((await (await owner.get(compUrl())).json()).composition).toBeNull()

    // re-create, then reboot the server on the same data dir
    await owner.put(compUrl(), COMP_BODY)
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const again = new Client(server)
    again.cookies = owner.cookies
    const comp = (await (await again.get(compUrl())).json()).composition as Composition
    expect(comp).toMatchObject({ canvasId, pageId, duration: 6 })
  }, 30_000)
})

describe('the room relays timelines and playheads', () => {
  const join = (clientId: string) =>
    new Promise<{ ws: WebSocket; received: Record<string, unknown>[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      const received: Record<string, unknown>[] = []
      ws.on('message', (d) => received.push(JSON.parse(String(d))))
      ws.on('error', reject)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', canvasId, clientId, name: 'Obs', kind: 'user' })))
      const timer = setInterval(() => {
        if (received.some((m) => m.type === 'init')) {
          clearInterval(timer)
          resolve({ ws, received })
        }
      }, 20)
      setTimeout(() => reject(new Error('join timed out')), 8000)
    })

  it('broadcasts composition writes and collaborator playheads', async () => {
    const observer = await join('motion-observer')
    const sender = await join('motion-sender')

    await owner.patch(compUrl(), { ops: [{ op: 'set_meta', duration: 9 }] })
    /* a playhead echoes to everyone but its sender — like cursors */
    sender.ws.send(JSON.stringify({ type: 'composition:playhead', pageId, t: 2.5, playing: true }))

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (
          observer.received.some((m) => m.type === 'composition') &&
          observer.received.some((m) => m.type === 'composition:playhead')
        ) {
          clearInterval(timer)
          resolve()
        }
      }, 20)
      setTimeout(resolve, 4000)
    })
    observer.ws.close()
    sender.ws.close()

    const compMsg = observer.received.find((m) => m.type === 'composition') as
      { pageId: string; composition: Composition } | undefined
    expect(compMsg?.pageId).toBe(pageId)
    expect(compMsg?.composition.duration).toBe(9)
    const play = observer.received.find((m) => m.type === 'composition:playhead') as
      { clientId: string; pageId: string; t: number } | undefined
    expect(play).toMatchObject({ clientId: 'motion-sender', pageId, t: 2.5, playing: true })
    expect(sender.received.some((m) => m.type === 'composition:playhead')).toBe(false)
  }, 15_000)
})

describe('render jobs', () => {
  it('runs the queue → render → upload lifecycle and blocks a foreign claim', async () => {
    const noComp = await owner.post(`/api/canvases/${canvasId}/pages/${pageId}x/composition/renders`, {})
    expect(noComp.status).toBe(404)

    const created = await owner.post(`${compUrl()}/renders`, { format: 'mp4', width: 1920, height: 1080, fps: 30 })
    expect(created.status).toBe(201)
    const job = (await created.json()).job
    expect(job).toMatchObject({ canvasId, pageId, status: 'queued', format: 'mp4' })

    const list = (await (await owner.get(`${compUrl()}/renders`)).json()).jobs
    expect(list.map((j: { id: string }) => j.id)).toContain(job.id)
    expect((await outsider.get(`/api/renders/${job.id}`)).status).toBe(403)

    const claimed = await owner.patch(`/api/renders/${job.id}`, { status: 'rendering', claimedBy: 'tab-1' })
    expect(claimed.status).toBe(200)
    expect(((await claimed.json()).job as { claimedBy: string }).claimedBy).toBe('tab-1')

    const foreign = await owner.patch(`/api/renders/${job.id}`, {
      status: 'encoding',
      progress: 0.5,
      claimedBy: 'tab-2',
    })
    expect(foreign.status).toBe(409)

    const progress = await owner.patch(`/api/renders/${job.id}`, { progress: 0.5, claimedBy: 'tab-1' })
    expect(progress.status).toBe(200)

    const wrongKind = await owner.req(`/api/renders/${job.id}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: WEBM,
    })
    expect(wrongKind.status).toBe(400)

    const upload = await owner.req(`/api/renders/${job.id}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: MP4,
    })
    expect(upload.status).toBe(200)
    const done = await upload.json()
    expect(done.job.status).toBe('done')
    expect(done.asset.url).toMatch(/^\/a\/\w+\.mp4$/)
    const asset = await owner.get(done.asset.url)
    expect(asset.status).toBe(200)

    const again = await owner.patch(`/api/renders/${job.id}`, { status: 'rendering', claimedBy: 'tab-9' })
    expect(again.status).toBe(409)
  })

  it('fails a job left rendering across a reboot, and cancels cleanly', async () => {
    const created = await owner.post(`${compUrl()}/renders`, { format: 'webm' })
    const job = (await created.json()).job
    await owner.patch(`/api/renders/${job.id}`, { status: 'rendering', claimedBy: 'tab-1' })

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const back = new Client(server)
    back.cookies = owner.cookies
    const after = (await (await back.get(`/api/renders/${job.id}`)).json()).job
    expect(after.status).toBe('failed')
    expect(after.error).toBeTruthy()

    const fresh = await back.post(`${compUrl()}/renders`, { format: 'webm' })
    const cancelable = (await fresh.json()).job
    const canceled = await back.delete(`/api/renders/${cancelable.id}`)
    expect(((await canceled.json()).job as { status: string }).status).toBe('canceled')
  }, 30_000)
})

describe('the MCP tools', () => {
  it('storyboards a page, reads and patches its timeline, lints and queues a render', async () => {
    /* two frames in reading order on a fresh canvas */
    const film = await (await owner.post('/api/canvases', { name: 'Film' })).json()
    const filmPage = film.pages[0].id
    await owner.post(`/api/canvases/${film.id}/frames`, {
      name: 'Shot 1',
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
      html: '<body><h1>one</h1></body>',
    })
    await owner.post(`/api/canvases/${film.id}/frames`, {
      name: 'Shot 2',
      x: 1200,
      y: 0,
      width: 1000,
      height: 600,
      html: '<body><h1>two</h1><script>setInterval(() => Date.now(), 100)</script></body>',
    })

    const noComp = await mcpCall(ownerKey, 'get_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      agent_name: 'Rostrum',
    })
    expect(noComp.isError).toBe(true)
    expect(noComp.text).toContain('no composition')

    const story = await mcpCall(ownerKey, 'animate_storyboard', {
      canvas_id: film.id,
      page_id: filmPage,
      shot_seconds: 4,
      agent_name: 'Rostrum',
    })
    expect(story.isError).toBe(false)
    const storyData = JSON.parse(story.text) as { composition: Composition; shots: { frameId: string }[] }
    expect(storyData.shots).toHaveLength(2)
    expect(storyData.composition.tracks[0]?.kind).toBe('camera')

    const got = await mcpCall(ownerKey, 'get_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      agent_name: 'Rostrum',
    })
    const comp = (JSON.parse(got.text) as { composition: Composition }).composition
    expect(comp.duration).toBe(8)
    expect(comp.tracks[0]?.keyframes?.every((k) => (k.easing as { type: string }).type === 'hold')).toBe(true)

    const patched = await mcpCall(ownerKey, 'set_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      expected_revision: comp.revision,
      ops: [{ op: 'set_meta', duration: 10 }],
      agent_name: 'Rostrum',
    })
    expect(patched.isError).toBe(false)
    const stale = await mcpCall(ownerKey, 'set_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      expected_revision: comp.revision,
      ops: [{ op: 'set_meta', duration: 11 }],
      agent_name: 'Rostrum',
    })
    expect(stale.isError).toBe(true)

    /* lint flags the setInterval + Date.now in shot 2's html */
    const lint = await mcpCall(ownerKey, 'lint_motion', {
      canvas_id: film.id,
      page_id: filmPage,
      agent_name: 'Rostrum',
    })
    expect(lint.isError).toBe(false)
    const lintData = JSON.parse(lint.text) as { errors: number; issues: { rule: string }[] }
    expect(lintData.errors).toBeGreaterThan(0)
    expect(lintData.issues.map((i) => i.rule)).toContain('MO-02')

    const render = await mcpCall(ownerKey, 'render_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      format: 'webm',
      agent_name: 'Rostrum',
    })
    expect(render.isError).toBe(false)
    const job = (JSON.parse(render.text) as { job: { id: string; status: string } }).job
    expect(job.status).toBe('queued')

    /* a key without edit rights is refused on the write tools */
    const visitorKey = (await (await outsider.post('/api/agent-keys', { name: 'v' })).json()).secret
    const denied = await mcpCall(visitorKey, 'set_composition', {
      canvas_id: film.id,
      page_id: filmPage,
      ops: [{ op: 'set_meta', duration: 5 }],
      agent_name: 'Rostrum',
    })
    expect(denied.isError).toBe(true)
  }, 30_000)
})
