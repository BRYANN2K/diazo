import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The dev-task routes over the REAL server (./harness.ts): a ready-for-dev
 * frame launches a task, the "desktop app" is a raw fetch claiming the
 * dev_task job on the poll bridge and posting reports back, and the room
 * hears every state change as `dev-task`.
 */

let server: Server
let owner: Client
let member: Client
let stranger: Client
let canvasId: string

const LINK_ID = '7b1e2c3d-0000-4000-8000-0000000000d1'
const DEVICE = '6c2f3e4a-0000-4000-8000-0000000000e2'
const DEVICE_B = '5d3a4f5b-0000-4000-8000-0000000000f3'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('devtask-owner@test.dev', 'Owner')
  member = await new Client(server).signUp('devtask-member@test.dev', 'Member')
  stranger = await new Client(server).signUp('devtask-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Dev tasks' })).json()).id
  await owner.post(`/api/canvases/${canvasId}/members`, { email: 'devtask-member@test.dev' })
}, 70_000)

afterAll(() => server?.stop())

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 60 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50))
}

async function makeFrame(name: string, html = `<p>${name}</p>`) {
  const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name, width: 400, height: 300, html })
  return res.json()
}

async function approve(frame: { id: string; updatedAt: number }) {
  const res = await owner.put(`/api/frames/${frame.id}/approval`, {
    status: 'ready_for_dev',
    expectedUpdatedAt: frame.updatedAt,
  })
  expect(res.status, await res.text()).toBe(200)
}

/** Start the device's long-poll and wait until the server sees it online. */
async function deviceOnline(deviceId = DEVICE, grants = [LINK_ID]) {
  const claimed = owner.post('/api/local-repo/poll', { deviceId, grants })
  await until(async () => (await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()).online as boolean)
  return claimed
}

async function linkProject() {
  const res = await owner.post(`/api/canvases/${canvasId}/repo`, {
    linkId: LINK_ID,
    name: 'proj',
    deviceId: DEVICE,
  })
  expect(res.status).toBe(200)
}

/** Join the canvas room and collect every message after init. */
function listen(client: Client) {
  return new Promise<{ messages: Record<string, unknown>[]; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const messages: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'room', name: 'Owner', kind: 'user' })),
    )
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d))
      if (msg.type === 'init') {
        clearTimeout(timer)
        resolve({ messages, close: () => ws.close() })
      } else messages.push(msg)
    })
    ws.on('error', reject)
  })
}

describe('POST /api/frames/:id/dev-tasks', () => {
  it('requires a session, edit access and a valid body', async () => {
    const frame = await makeFrame('Gate')
    const anon = new Client(server)
    expect((await anon.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude' })).status).toBe(401)
    expect((await stranger.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude' })).status).toBe(403)
    expect((await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'hal' })).status).toBe(400)
    expect((await owner.post(`/api/frames/${frame.id}/dev-tasks`, {})).status).toBe(400)
    expect(
      (await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude', environment: 'bad env!' })).status,
    ).toBe(400)
  })

  it('refuses a frame that is not ready for dev and a canvas without a live link', async () => {
    const frame = await makeFrame('Draft')
    const res = await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ready for dev/)

    await approve(frame)
    const noLink = await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude' })
    expect(noLink.status).toBe(409)
    expect((await noLink.json()).error).toMatch(/linked project/)

    /* the link alone is not enough: its device must be polling */
    await linkProject()
    const offline = await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude' })
    expect(offline.status).toBe(409)
  })

  it('creates a queued task, hands the device a typed dev_task job and reports state to the room', async () => {
    const room = await listen(owner)
    const frame = await makeFrame('Checkout screen')
    await approve(frame)
    const claimed = deviceOnline()

    const res = await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'claude', environment: 'vps' })
    const { task } = await res.json()
    expect(res.status, JSON.stringify(task)).toBe(200)
    expect(task).toMatchObject({
      canvasId,
      frameIds: [frame.id],
      state: 'queued',
      agent: 'claude',
      environment: 'vps',
      hostLabel: 'vps',
      requestedBy: 'Owner',
      runner: 'orca',
    })
    expect(task.frameRevision).toBeTypeOf('number')
    /* the public task never carries a path or the stored pack */
    expect(task).not.toHaveProperty('handoff')
    expect(JSON.stringify(task)).not.toMatch(/\/Users\/|\/home\//)

    const { request } = await claimed.then((r) => r.json())
    expect(request).toMatchObject({
      linkId: LINK_ID,
      op: 'dev_task',
      args: {
        devTask: {
          taskId: task.id,
          branch: expect.stringMatching(/^doop\//),
          agent: 'claude',
          environment: 'vps',
        },
      },
    })
    expect(request.args.devTask.prompt).toContain(`get_handoff({ task_id: "${task.id}" })`)
    expect(request.args.devTask.comment).toContain(`/c/${canvasId}?frame=${frame.id}`)
    expect(request.args.devTask.comment).toContain(`task ${task.id}`)

    /* the launch answer binds the device and stores the opaque identity */
    const report = await owner.post(`/api/dev-tasks/${task.id}/report`, {
      deviceId: DEVICE,
      requestId: request.id,
      launch: { ok: true, orcaIdentity: 'wt2:vps:inst-9', branch: 'doop/new-screen-a1b2', orcaSessionId: 's-7' },
    })
    const after = await report.json()
    expect(report.status, JSON.stringify(after)).toBe(200)
    expect(after.task).toMatchObject({ state: 'starting', orcaIdentity: 'wt2:vps:inst-9', deviceId: DEVICE })

    /* polls then move it along */
    for (const [poll, state] of [
      [{ found: true, agentState: 'working', lastAssistantMessage: 'building the form' }, 'working'],
      [{ found: true, linkedPR: 'https://github.com/acme/proj/pull/3' }, 'pr_open'],
      [{ found: true, outcome: 'success' }, 'done'],
    ] as const) {
      const r = await owner.post(`/api/dev-tasks/${task.id}/report`, { deviceId: DEVICE, poll })
      expect(r.status).toBe(200)
      expect((await r.json()).task.state).toBe(state)
    }

    const list = await (await owner.get(`/api/canvases/${canvasId}/dev-tasks`)).json()
    const mine = list.tasks.find((t: { id: string }) => t.id === task.id)
    expect(mine).toMatchObject({ state: 'done', prUrl: 'https://github.com/acme/proj/pull/3' })
    expect(mine.finishedAt).toBeTypeOf('number')
    const byFrame = await (await owner.get(`/api/frames/${frame.id}/dev-tasks`)).json()
    expect(byFrame.tasks.map((t: { id: string }) => t.id)).toContain(task.id)

    await until(
      () =>
        room.messages.filter((m) => m.type === 'dev-task' && (m.task as { id?: string })?.id === task.id).length >= 4,
    )
    const states = room.messages
      .filter((m) => m.type === 'dev-task' && (m.task as { id: string }).id === task.id)
      .map((m) => (m.task as { state: string }).state)
    expect(states).toEqual(['queued', 'starting', 'working', 'pr_open', 'done'])
    room.close()
  }, 30_000)

  it('report is requester-and-device scoped', async () => {
    const frame = await makeFrame('Scoped')
    await approve(frame)
    const claimed = deviceOnline()
    const { task } = await (await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'codex' })).json()
    const { request } = await claimed.then((r) => r.json())

    /* a canvas member who did not launch it cannot speak for the device */
    const asMember = await member.post(`/api/dev-tasks/${task.id}/report`, { deviceId: DEVICE, launch: { ok: true } })
    expect(asMember.status).toBe(403)

    const ok = await owner.post(`/api/dev-tasks/${task.id}/report`, {
      deviceId: DEVICE,
      requestId: request.id,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1' },
    })
    expect(ok.status).toBe(200)

    /* the task is bound to the reporting device now */
    const other = await owner.post(`/api/dev-tasks/${task.id}/report`, { deviceId: DEVICE_B, poll: { found: true } })
    expect(other.status).toBe(409)

    const bad = await owner.post(`/api/dev-tasks/${task.id}/report`, { deviceId: 'x' })
    expect(bad.status).toBe(400)
  }, 30_000)
})

describe('cancel and list', () => {
  it('an editor cancels a live task; a finished one is untouched', async () => {
    const room = await listen(owner)
    const frame = await makeFrame('Stoppable')
    await approve(frame)
    const claimed = deviceOnline()
    const { task } = await (await owner.post(`/api/frames/${frame.id}/dev-tasks`, { agent: 'codex' })).json()
    const { request } = await claimed.then((r) => r.json())
    await owner.post(`/api/dev-tasks/${task.id}/report`, {
      deviceId: DEVICE,
      requestId: request.id,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i2' },
    })

    expect((await stranger.post(`/api/dev-tasks/${task.id}/cancel`)).status).toBe(403)
    const cancelled = await (await member.post(`/api/dev-tasks/${task.id}/cancel`)).json()
    expect(cancelled.task.state).toBe('cancelled')

    /* terminal: further polls cannot move it */
    const late = await owner.post(`/api/dev-tasks/${task.id}/report`, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'working' },
    })
    expect((await late.json()).task.state).toBe('cancelled')

    await until(() =>
      room.messages.some((m) => m.type === 'dev-task' && (m.task as { state: string }).state === 'cancelled'),
    )
    room.close()
  }, 30_000)
})
