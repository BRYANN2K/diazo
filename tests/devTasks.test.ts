import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { frameDevTasks } from '../server/db/schema.ts'
import { store } from '../server/store.ts'
import { localRepo } from '../server/localRepo.ts'
import {
  applyAgentUpdate,
  applyDeviceReport,
  cancelDevTask,
  createDevTask,
  devTaskFor,
  failStaleDevTasks,
  mergedPollState,
  pollStateOf,
  wireDevTasks,
} from '../server/devTasks.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { REPO_POLL_MS, type RepoLink } from '../shared/localRepo.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { DEV_TASK_LAUNCH_TTL_MS, devTaskSlug, type DevTaskBrief, type DevTaskState } from '../shared/devTasks.ts'

/**
 * Dev tasks against an in-memory PGlite: the launch job really rides the
 * LocalRepo bridge, the reports really merge, and get_handoff /
 * update_dev_task run as the real MCP tools over an in-memory transport.
 * No orca binary is involved — the desktop side is faked by calling the
 * report function the shell's POST wraps.
 */

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveMember: () => {},
  deleteMember: () => {},
}))

const owner = { id: 'owner-1', name: 'Owner' }
const LINK: RepoLink = { id: 'link-1', name: 'proj', deviceId: 'dev-a', createdAt: 0, lastUsedAt: 0 }
const DEVICE = 'dev-a'
const DEVICE_B = 'dev-b'

let canvas: Canvas
let frame: Frame
let broadcasts: { canvasId: string; msg: unknown }[]

const fakeBrief = (): DevTaskBrief => ({
  title: 'New screen',
  canvasId: canvas.id,
  frames: [{ id: 'frame-1', name: 'Checkout', width: 800, height: 600, png: 'aGVsbG8=' }],
  warnings: [],
})

/** The job the desktop claims on the poll bridge. */
async function launch(frameIds: string[], extra: Partial<Parameters<typeof createDevTask>[0]> = {}) {
  const claim = localRepo.poll(owner.id, DEVICE, [LINK.id])
  const task = await createDevTask({
    canvasId: canvas.id,
    frameIds,
    frameRevision: 42,
    brief: fakeBrief(),
    link: LINK,
    userId: owner.id,
    userName: owner.name,
    agent: 'claude',
    ...extra,
  })
  const job = await claim
  return { task, job }
}

/** The task id reduced to what devTaskSlug's suffix keeps — [a-z0-9]. */
const idSlug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '')

const row = async (id: string) => (await db.select().from(frameDevTasks).where(eq(frameDevTasks.id, id)))[0]

/** Wait for an async follow-up (the unclaimed-launch failure) to land. */
async function untilSettled(id: string, state: DevTaskState) {
  for (let i = 0; i < 60; i++) {
    const task = await devTaskFor(id)
    if (task?.state === state) return task
    await new Promise((r) => setTimeout(r, 20))
  }
  return devTaskFor(id)
}

/** An MCP client signed in as `userId`/`name`, over in-memory transport. */
async function mcpFor(userId: string, name = 'Agent') {
  const server = buildMcpServer(name, userId)
  const client = new Client({ name: 'devtask-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return {
    call: (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args }),
    async close() {
      await client.close()
      await server.close()
    },
  }
}

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

beforeEach(async () => {
  await db.delete(frameDevTasks)
  broadcasts = []
  wireDevTasks((canvasId, msg) => broadcasts.push({ canvasId, msg }))
  canvas = store.createCanvas('Ship', owner.id)
  frame = store.createFrame(canvas.id, { name: 'Checkout', html: '<h1>Pay</h1>' }, owner.name)!
})

afterEach(() => wireDevTasks(() => {}))

describe('createDevTask', () => {
  it('stores the row and hands a typed dev_task job to the device', async () => {
    const { task, job } = await launch([frame.id], { environment: 'vps', model: 'opus', effort: 'high' })
    expect(task).toMatchObject({
      canvasId: canvas.id,
      frameIds: [frame.id],
      frameRevision: 42,
      state: 'queued',
      runner: 'orca',
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      environment: 'vps',
      hostLabel: 'vps',
    })
    /* the room's task never carries the requester's user id or device id */
    expect(task.requestedBy).toBe('Owner')
    expect(task).not.toHaveProperty('requestedByUserId')
    expect(task).not.toHaveProperty('deviceId')
    expect(job).toMatchObject({
      linkId: LINK.id,
      op: 'dev_task',
      args: {
        devTask: {
          taskId: task.id,
          worktreeName: `doop-new-screen-${idSlug(task.id)}`,
          branch: `doop/new-screen-${idSlug(task.id)}`,
          agent: 'claude',
          model: 'opus',
          effort: 'high',
          environment: 'vps',
        },
      },
    })
    const args = (job as { args: { devTask: { prompt: string; comment: string } } }).args.devTask
    expect(args.prompt).toContain(`get_handoff({ task_id: "${task.id}" })`)
    expect(args.prompt).toContain('update_dev_task')
    expect(args.comment).toContain(`/c/${canvas.id}?frame=${frame.id}`)
    /* nothing on the row carries a path or the brief itself */
    const stored = await row(task.id)
    expect(stored?.handoff.title).toBe('New screen')
    expect(JSON.stringify(task)).not.toContain('/Users/')
    expect(broadcasts.at(-1)).toMatchObject({ canvasId: canvas.id, msg: { type: 'dev-task', task: { id: task.id } } })
  })

  it('fails the task when no device claims the launch', async () => {
    /* localRepo.repoRequest rejects fast: no online device holds the grant */
    const task = await createDevTask({
      canvasId: canvas.id,
      frameIds: [frame.id],
      frameRevision: null,
      brief: fakeBrief(),
      link: LINK,
      userId: 'user-without-device',
      userName: 'Ghost',
      agent: 'codex',
    })
    const stored = await untilSettled(task.id, 'failed')
    expect(stored?.state).toBe('failed')
    expect(stored?.summary).toMatch(/isn't online/)
    expect(stored?.finishedAt).toBeTypeOf('number')
  })
})

describe('applyDeviceReport', () => {
  it('moves a launch to starting, then working, then done', async () => {
    const { task, job } = await launch([frame.id])
    const started = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      requestId: (job as { id: string }).id,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1', branch: 'doop/new-screen-a1b2', orcaSessionId: 's-1' },
    })
    expect(started.ok && started.task.state).toBe('starting')
    expect(started.ok && started.task.orcaIdentity).toBe('wt2:mac:i1')
    /* the device is bound (a wrong-device poll below is refused) — its id
       itself never leaves the server */
    expect(started.ok && started.task).not.toHaveProperty('deviceId')

    const working = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'working', lastAssistantMessage: 'writing the form' },
    })
    expect(working.ok && working.task.state).toBe('working')
    expect(working.ok && working.task.summary).toBe('writing the form')

    const done = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, outcome: 'success' },
    })
    expect(done.ok && done.task.state).toBe('done')
    expect(done.ok && done.task.finishedAt).toBeTypeOf('number')
  })

  it('marks cancelled when the person declines the native confirmation', async () => {
    const { task } = await launch([frame.id])
    const out = await applyDeviceReport(owner.id, task.id, { deviceId: DEVICE, launch: { ok: false, cancelled: true } })
    expect(out.ok && out.task.state).toBe('cancelled')
  })

  it('refuses another user and another device', async () => {
    const { task } = await launch([frame.id])
    const wrongUser = await applyDeviceReport('someone-else', task.id, {
      deviceId: DEVICE,
      launch: { ok: true },
    })
    expect(wrongUser).toMatchObject({ ok: false, status: 403 })
    await applyDeviceReport(owner.id, task.id, { deviceId: DEVICE, launch: { ok: true } })
    const wrongDevice = await applyDeviceReport(owner.id, task.id, { deviceId: DEVICE_B, poll: { found: true } })
    expect(wrongDevice).toMatchObject({ ok: false, status: 409 })
  })

  it('lets the agent’s own pr_open/done outrank later polls', async () => {
    const { task } = await launch([frame.id])
    await applyDeviceReport(owner.id, task.id, { deviceId: DEVICE, launch: { ok: true, orcaIdentity: 'wt2:x:i2' } })
    const pr = await applyAgentUpdate(owner.id, {
      task_id: task.id,
      state: 'pr_open',
      pr_url: 'https://github.com/acme/proj/pull/7',
    })
    expect(pr.ok).toBe(true)
    /* a stale 'working' poll must not drag a PR'd task backwards */
    const stale = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'working' },
    })
    expect(stale.ok && stale.task.state).toBe('pr_open')

    await applyAgentUpdate(owner.id, { task_id: task.id, state: 'done', summary: 'merged' })
    /* and a worktree that vanished cannot resurrect a finished task */
    const gone = await applyDeviceReport(owner.id, task.id, { deviceId: DEVICE, poll: { found: false } })
    expect(gone.ok && gone.task.state).toBe('done')
  })

  it('a failed poll outcome ends the task as failed', async () => {
    const { task } = await launch([frame.id])
    await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1' },
    })
    await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'working' },
    })
    /* the main agent's outcome — the shell reads mainAgent.outcome —
       is the pull-side value that ends the task */
    const out = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'done', outcome: 'failure' },
    })
    expect(out.ok && out.task.state).toBe('failed')
    expect(out.ok && out.task.finishedAt).toBeTypeOf('number')
  })

  it('a replayed ok launch report does not drag a live row back to starting', async () => {
    const { task } = await launch([frame.id])
    await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1' },
    })
    await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      poll: { found: true, agentState: 'working' },
    })
    const replayed = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1', branch: 'doop/new-screen-a1b2' },
    })
    expect(replayed.ok && replayed.task.state).toBe('working')
    await applyAgentUpdate(owner.id, {
      task_id: task.id,
      state: 'pr_open',
      pr_url: 'https://github.com/a/b/pull/5',
    })
    const replayedPr = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true },
    })
    expect(replayedPr.ok && replayedPr.task.state).toBe('pr_open')
  })

  it('ignores launch reports once the row is terminal', async () => {
    const { task } = await launch([frame.id])
    await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i1' },
    })
    await applyAgentUpdate(owner.id, { task_id: task.id, state: 'done' })
    /* a late or replayed launch answer must not drag done back to starting,
       nor stamp a fresh identity on the finished row */
    const late = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:replayed', branch: 'doop/other' },
    })
    expect(late.ok && late.task.state).toBe('done')
    expect(late.ok && late.task.orcaIdentity).toBe('wt2:mac:i1')
    /* nor may a declined confirmation cancel a completed task */
    const declined = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: false, cancelled: true },
    })
    expect(declined.ok && declined.task.state).toBe('done')
  })

  it('a report settles only its own task’s bridge request', async () => {
    /* two launches in flight: reporting one must not burn the other's job */
    const a = await launch([frame.id])
    const b = await launch([frame.id])
    const aJob = a.job as { id: string }
    const bJob = b.job as { id: string }
    /* a failing report on A wearing B's requestId: B stays claimable */
    const stolen = await applyDeviceReport(owner.id, a.task.id, {
      deviceId: DEVICE,
      requestId: bJob.id,
      launch: { ok: false, error: 'create blew up' },
    })
    expect(stolen.ok && stolen.task.state).toBe('failed')
    expect((await devTaskFor(b.task.id))?.state).toBe('queued')
    /* and B's own request still settles its launch */
    const launched = await applyDeviceReport(owner.id, b.task.id, {
      deviceId: DEVICE,
      requestId: bJob.id,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i-b' },
    })
    expect(launched.ok && launched.task.state).toBe('starting')
    /* A's own request was never settled — the launch TTL fails it, not B's report */
    expect(aJob.id).not.toBe(bJob.id)
  })
})

describe('applyAgentUpdate', () => {
  it('is requester-only and push-state-only', async () => {
    const { task } = await launch([frame.id])
    const stranger = await applyAgentUpdate('intruder', { task_id: task.id, state: 'done' })
    expect(stranger.ok).toBe(false)
    const bad = await applyAgentUpdate(owner.id, { task_id: task.id, state: 'queued' as never })
    expect(bad.ok).toBe(false)
    expect((await row(task.id))?.state).toBe('queued')
  })

  it('attaching a PR without a state means pr_open; terminal states freeze', async () => {
    const { task } = await launch([frame.id])
    const pr = await applyAgentUpdate(owner.id, { task_id: task.id, pr_url: 'https://github.com/a/b/pull/1' })
    expect(pr.ok && pr.task.state).toBe('pr_open')
    const nonHttp = await applyAgentUpdate(owner.id, { task_id: task.id, pr_url: 'javascript:alert(1)' })
    expect(nonHttp.ok).toBe(false)
    await applyAgentUpdate(owner.id, { task_id: task.id, state: 'done' })
    const reopen = await applyAgentUpdate(owner.id, { task_id: task.id, state: 'needs_input' })
    expect(reopen.ok).toBe(false)
    const fresh = await applyAgentUpdate(owner.id, { task_id: task.id, state: 'done', summary: 'final' })
    expect(fresh.ok && fresh.task.summary).toBe('final')
  })

  it('a cancelled task stays cancelled', async () => {
    const { task } = await launch([frame.id])
    await cancelDevTask(task.id)
    const out = await applyAgentUpdate(owner.id, { task_id: task.id, state: 'working' as never })
    expect(out.ok).toBe(false)
    expect((await row(task.id))?.state).toBe('cancelled')
  })
})

describe('devTaskSlug', () => {
  /* the desktop shell's valid_branch (desktop/src-tauri/src/orca.rs):
     [A-Za-z0-9._/-], no '..', no leading '-'/'/', no trailing '/'/'.'/'-' */
  const branchOk = (branch: string) =>
    branch.length > 0 &&
    branch.length <= 200 &&
    [...branch].every((c) => /[A-Za-z0-9._/-]/.test(c)) &&
    !branch.includes('..') &&
    !'-/'.includes(branch[0]!) &&
    !'/.-'.includes(branch.at(-1)!)

  const titles = [
    'Checkout screen',
    '',
    '   ',
    '—',
    'Ünïcödé ✨ frame',
    'a'.repeat(80),
    'trailing dash—',
    '..dots..',
    'slash/inside',
    'Version 2.0 (final)',
  ]
  const ids = [
    'abcDEF1234',
    'abcdef123-', // nanoid's '-' as the last character
    '----------',
    '__________',
    '-_-_-_-_-_',
    'a/b.c d',
    'XYZ-123_zy',
    '',
    'x'.repeat(40),
    /* nanoid's real alphabet at many deterministic positions */
    ...Array.from({ length: 64 }, (_, i) =>
      Array.from(
        { length: 10 },
        (__, k) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[(i * 17 + k * 29) % 64],
      ).join(''),
    ),
  ]

  it('keeps doop/<slug> inside the shell’s branch rules for every input', () => {
    for (const title of titles)
      for (const id of ids) {
        const branch = `doop/${devTaskSlug(title, id)}`
        expect(branchOk(branch), `${JSON.stringify(title)} / ${JSON.stringify(id)} -> ${branch}`).toBe(true)
      }
  })

  it('strips the id to [a-z0-9] so the suffix can never end in a dash', () => {
    expect(devTaskSlug('Billing screen', 'abcdef123-')).toBe('billing-screen-abcdef123')
    expect(devTaskSlug('Billing screen', '_AbC-Def_')).toBe('billing-screen-abcdef')
    expect(devTaskSlug('', 'x1')).toBe('task-x1')
    expect(devTaskSlug('—', 'ab12')).toBe('task-ab12')
    /* an all-punctuation id still yields a valid, non-empty slug */
    expect(devTaskSlug('Checkout', '----____')).toBe('checkout-x')
    /* two launches of one frame still differ */
    expect(devTaskSlug('Checkout', 'id00000001')).not.toBe(devTaskSlug('Checkout', 'id00000002'))
  })
})

describe('state mapping', () => {
  const base = { state: 'working', agentState: null } as typeof frameDevTasks.$inferSelect
  it('maps trimmed worktree ps rows', () => {
    expect(pollStateOf({ found: false })).toBe('cancelled')
    expect(pollStateOf({ found: true, linkedPR: 'https://x/pr/1' })).toBe('pr_open')
    expect(pollStateOf({ found: true, outcome: 'success' })).toBe('done')
    expect(pollStateOf({ found: true, outcome: 'failure' })).toBe('failed')
    expect(pollStateOf({ found: true, outcome: 'interruption' })).toBe('failed')
    expect(pollStateOf({ found: true, outcome: 'cancellation' })).toBe('cancelled')
    expect(pollStateOf({ found: true, agentState: 'blocked' })).toBe('needs_input')
    expect(pollStateOf({ found: true, agentState: 'working' })).toBe('working')
    /* an agent turn that merely ended is not the task ending */
    expect(pollStateOf({ found: true, agentState: 'done' })).toBeNull()
  })
  it('merges polls against agent pushes', () => {
    const cases: [Partial<typeof base>, DevTaskState | null, DevTaskState][] = [
      [{ state: 'cancelled' }, 'working', 'cancelled'],
      /* an agent's own terminal push beats a worktree that vanished or a
         stale status read */
      [{ state: 'done', agentState: 'done' }, 'cancelled', 'done'],
      [{ state: 'failed' }, 'working', 'failed'],
      [{ state: 'pr_open', agentState: 'pr_open' }, 'working', 'pr_open'],
      [{ state: 'pr_open', agentState: 'pr_open' }, 'done', 'done'],
      [{ state: 'queued' }, 'starting', 'starting'],
      [{ state: 'working' }, null, 'working'],
      /* a programStatus outcome ends the task — the agent's per-turn
         "done" agentState never does (pollStateOf returns null for it) */
      [{ state: 'working' }, 'done', 'done'],
    ]
    for (const [rowLike, next, expected] of cases) {
      expect(mergedPollState({ ...base, ...rowLike } as typeof base, next), JSON.stringify(rowLike)).toBe(expected)
    }
  })
})

describe('cancel', () => {
  it('stops a live task and leaves a terminal one alone', async () => {
    const { task } = await launch([frame.id])
    const cancelled = await cancelDevTask(task.id)
    expect(cancelled?.state).toBe('cancelled')
    expect(cancelled?.finishedAt).toBeTypeOf('number')
    const done = await launch([frame.id])
    await applyAgentUpdate(owner.id, { task_id: done.task.id, state: 'done' })
    expect((await cancelDevTask(done.task.id))?.state).toBe('done')
  })

  it('a cancelled queued task withdraws its unclaimed bridge job', async () => {
    /* the device is online but not long-polling: the dev_task request sits
       in the pending map, unclaimed */
    const registered = localRepo.poll(owner.id, DEVICE, [LINK.id])
    localRepo.dropWaiter(owner.id, DEVICE)
    await registered
    const task = await createDevTask({
      canvasId: canvas.id,
      frameIds: [frame.id],
      frameRevision: null,
      brief: fakeBrief(),
      link: LINK,
      userId: owner.id,
      userName: owner.name,
      agent: 'claude',
    })
    expect((await devTaskFor(task.id))?.state).toBe('queued')
    await cancelDevTask(task.id)
    /* the next poll must not hand the cancelled launch to the desktop */
    vi.useFakeTimers()
    try {
      const claim = localRepo.poll(owner.id, DEVICE, [LINK.id])
      await vi.advanceTimersByTimeAsync(REPO_POLL_MS + 1_000)
      expect(await claim).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    /* and the withdrawn job's resolve cannot flunk the cancelled row */
    expect((await devTaskFor(task.id))?.state).toBe('cancelled')
  })

  it('a launch already claimed cannot be withdrawn, but the row stays cancelled', async () => {
    const { task } = await launch([frame.id]) // the device claimed the job
    await cancelDevTask(task.id)
    const late = await applyDeviceReport(owner.id, task.id, {
      deviceId: DEVICE,
      launch: { ok: true, orcaIdentity: 'wt2:mac:i9' },
    })
    expect(late.ok && late.task.state).toBe('cancelled')
  })
})

describe('failStaleDevTasks', () => {
  it('fails orphaned queued rows only', async () => {
    /* a queued row older than the launch TTL: its bridge request died with
       the process that held it, so no device can ever claim it */
    const { task: stale } = await launch([frame.id])
    await db
      .update(frameDevTasks)
      .set({ createdAt: Date.now() - DEV_TASK_LAUNCH_TTL_MS - 1_000 })
      .where(eq(frameDevTasks.id, stale.id))
    /* a fresh queued row and an aged starting one are left alone */
    const { task: young } = await launch([frame.id])
    const { task: started } = await launch([frame.id])
    await applyDeviceReport(owner.id, started.id, { deviceId: DEVICE, launch: { ok: true } })
    await db
      .update(frameDevTasks)
      .set({ createdAt: Date.now() - DEV_TASK_LAUNCH_TTL_MS - 1_000 })
      .where(eq(frameDevTasks.id, started.id))

    const failed = await failStaleDevTasks()
    expect(failed).toBe(1)
    expect((await devTaskFor(stale.id))?.state).toBe('failed')
    expect((await devTaskFor(stale.id))?.finishedAt).toBeTypeOf('number')
    expect((await devTaskFor(young.id))?.state).toBe('queued')
    expect((await devTaskFor(started.id))?.state).toBe('starting')
    expect(broadcasts.some((b) => (b.msg as { task?: { id?: string } }).task?.id === stale.id)).toBe(true)
  })
})

describe('MCP tools', () => {
  it('get_handoff hands the requester’s agent the stored brief', async () => {
    const { task } = await launch([frame.id])
    const mcp = await mcpFor(owner.id)
    const result = await mcp.call('get_handoff', { task_id: task.id })
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[]
    const header = JSON.parse(content[0]!.text!)
    expect(header.task).toMatchObject({ id: task.id, canvasId: canvas.id, frameIds: [frame.id] })
    expect(header.title).toBe('New screen')
    expect(header.frames).toEqual([{ id: 'frame-1', name: 'Checkout', width: 800, height: 600 }])
    const png = content.find((b) => b.type === 'image')
    expect(png).toMatchObject({ mimeType: 'image/png', data: 'aGVsbG8=' })
    await mcp.close()
  })

  it('get_handoff refuses everyone else', async () => {
    const { task } = await launch([frame.id])
    const mcp = await mcpFor('someone-else')
    const result = await mcp.call('get_handoff', { task_id: task.id })
    expect(result.isError).toBe(true)
    await mcp.close()
  })

  it('update_dev_task pushes agent state the room sees', async () => {
    const { task } = await launch([frame.id])
    const mcp = await mcpFor(owner.id)
    const before = broadcasts.length
    const result = await mcp.call('update_dev_task', {
      task_id: task.id,
      state: 'pr_open',
      pr_url: 'https://github.com/acme/proj/pull/9',
      summary: 'PR up',
    })
    expect(result.isError).toBeUndefined()
    expect((await devTaskFor(task.id))?.state).toBe('pr_open')
    expect(broadcasts.length).toBeGreaterThan(before)
    expect(broadcasts.at(-1)?.msg).toMatchObject({ type: 'dev-task', task: { id: task.id, state: 'pr_open' } })
    const denied = await mcp.call('update_dev_task', { task_id: 'nope' })
    expect(denied.isError).toBe(true)
    await mcp.close()
  })

  it('update_dev_task refuses once the requester lost canvas access', async () => {
    /* member access is live-checked: launching is not a lifetime pass */
    store.addMember(canvas.id, 'user-2', owner.id)
    const claim = localRepo.poll('user-2', DEVICE, [LINK.id])
    const task = await createDevTask({
      canvasId: canvas.id,
      frameIds: [frame.id],
      frameRevision: null,
      brief: fakeBrief(),
      link: LINK,
      userId: 'user-2',
      userName: 'Agent Two',
      agent: 'claude',
    })
    await claim
    const mcp = await mcpFor('user-2')
    const ok = await mcp.call('update_dev_task', { task_id: task.id, state: 'needs_input', summary: 'hold on' })
    expect(ok.isError).toBeUndefined()
    store.removeMember(canvas.id, 'user-2')
    const denied = await mcp.call('update_dev_task', { task_id: task.id, state: 'needs_input' })
    expect(denied.isError).toBe(true)
    await mcp.close()
  })
})
