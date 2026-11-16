import { nanoid } from 'nanoid'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db/index.ts'
import { frameDevTasks } from './db/schema.ts'
import { env } from './env.ts'
import { localRepo } from './localRepo.ts'
import type { ServerMessage } from '../shared/types.ts'
import type { RepoLink } from '../shared/localRepo.ts'
import type { HandoffPack } from '../shared/handoff.ts'
import {
  DEV_TASK_KEEP_PER_FRAME,
  DEV_TASK_LAUNCH_TTL_MS,
  DEV_TASK_PUSH_STATES,
  DEV_TASK_SUMMARY_CHARS,
  DEV_TASK_TERMINAL,
  devTaskComment,
  devTaskPrompt,
  isDevTaskPushState,
  type DevTask,
  type DevTaskAgentUpdate,
  type DevTaskLaunchArgs,
  type DevTaskLaunchReport,
  type DevTaskPollReport,
  type DevTaskReport,
  type DevTaskState,
} from '../shared/devTasks.ts'

/**
 * Dev tasks: the server half of "Send to Orca" (shared/devTasks.ts,
 * docs/orca.md). A launch leaves here as a `queued` row plus a `dev_task`
 * request on the local-repo poll bridge; the desktop shell answers through
 * the report route, the coding agent pushes through update_dev_task over
 * MCP, and every stored change broadcasts `dev-task` to the room.
 *
 * Two status sources merge into one row, last writer wins with one
 * exception: the agent's own `pr_open`/`done`/`failed` push outranks the
 * device's `worktree ps` read — a chat agent reports "done" per turn, so
 * the pull side can never be trusted to end a task on its own.
 */

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
let broadcast: Broadcast | undefined

/** index.ts wires the room broadcast at boot. */
export function wireDevTasks(b: Broadcast): void {
  broadcast = b
}

function announce(task: DevTask): void {
  broadcast?.(task.canvasId, { type: 'dev-task', task })
}

/* ------------------------------------------------------------------ */
/* rows                                                                */
/* ------------------------------------------------------------------ */

type Row = typeof frameDevTasks.$inferSelect

/** The public shape: the stored handoff pack and the agent-merge column
 *  stay inside the server. */
function toTask(row: Row): DevTask {
  return {
    id: row.id,
    canvasId: row.canvasId,
    frameIds: row.frameIds,
    handoffChangeId: row.handoffChangeId,
    frameRevision: row.frameRevision,
    duelId: row.duelId,
    requestedBy: row.requestedByName,
    requestedByUserId: row.requestedByUserId,
    deviceId: row.deviceId,
    runner: row.runner,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    hostLabel: row.hostLabel,
    environment: row.environment,
    orcaIdentity: row.orcaIdentity,
    orcaSessionId: row.orcaSessionId,
    branch: row.branch,
    prUrl: row.prUrl,
    state: row.state,
    summary: row.summary,
    drift: row.drift,
    devUrl: row.devUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  }
}

export async function devTaskRow(id: string): Promise<Row | undefined> {
  const [row] = await db.select().from(frameDevTasks).where(eq(frameDevTasks.id, id))
  return row
}

export async function devTaskFor(id: string): Promise<DevTask | undefined> {
  const row = await devTaskRow(id)
  return row ? toTask(row) : undefined
}

export async function devTasksForCanvas(canvasId: string): Promise<DevTask[]> {
  const rows = await db
    .select()
    .from(frameDevTasks)
    .where(eq(frameDevTasks.canvasId, canvasId))
    .orderBy(desc(frameDevTasks.createdAt))
    .limit(100)
  return rows.map(toTask)
}

/** The stored pack — `get_handoff`'s payload, read only there. */
export async function handoffFor(taskId: string): Promise<{ row: Row; pack: HandoffPack } | undefined> {
  const row = await devTaskRow(taskId)
  return row ? { row, pack: row.handoff } : undefined
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const TERMINAL = new Set<DevTaskState>(DEV_TASK_TERMINAL)

/** A trimmed `worktree ps` row mapped to a task state, or null when the
 *  row says nothing conclusive (an agent "done" without an outcome is a
 *  turn that ended, not a task that finished). */
export function pollStateOf(poll: DevTaskPollReport): DevTaskState | null {
  if (poll.found === false) return 'cancelled'
  if (poll.linkedPR) return 'pr_open'
  switch (poll.outcome) {
    case 'success':
      return 'done'
    case 'failure':
    case 'interruption':
      return 'failed'
    case 'cancellation':
      return 'cancelled'
  }
  const agent = poll.agentState ?? poll.status
  if (agent === 'blocked' || agent === 'waiting') return 'needs_input'
  if (agent === 'working') return 'working'
  return null
}

/** The poll's verdict against what's already stored — the agent's own push
 *  wins the states only it can truly know (a PR it opened, a task it
 *  finished); a person's cancel always wins. */
export function mergedPollState(task: Row, next: DevTaskState | null): DevTaskState {
  if (!next) return task.state
  if (task.state === 'cancelled') return task.state
  if (task.agentState === 'done' || task.agentState === 'failed') return task.state
  if (task.state === 'done' || task.state === 'failed') return task.state
  if (
    task.agentState === 'pr_open' &&
    (next === 'queued' || next === 'starting' || next === 'working' || next === 'needs_input')
  )
    return task.state
  return next
}

/** The launch answer against the row — a fresh launch revives a task the
 *  bridge expiry failed, but never a cancelled one. */
function launchState(task: Row, launch: DevTaskLaunchReport): DevTaskState {
  if (launch.cancelled) return 'cancelled'
  if (launch.ok === false) return 'failed'
  if (task.state === 'cancelled') return task.state
  return 'starting'
}

const isTerminal = (state: DevTaskState) => TERMINAL.has(state)

/* ------------------------------------------------------------------ */
/* writes                                                              */
/* ------------------------------------------------------------------ */

async function patch(id: string, set: Partial<typeof frameDevTasks.$inferInsert>): Promise<DevTask | undefined> {
  const rows = await db
    .update(frameDevTasks)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(frameDevTasks.id, id))
    .returning()
  const task = rows[0] ? toTask(rows[0]) : undefined
  if (task) announce(task)
  return task
}

/** Keep the newest DEV_TASK_KEEP_PER_FRAME rows per frame set. */
async function prune(canvasId: string, frameIds: string[]): Promise<void> {
  const rows = await db
    .select({ id: frameDevTasks.id })
    .from(frameDevTasks)
    .where(
      and(eq(frameDevTasks.canvasId, canvasId), sql`${frameDevTasks.frameIds} = ${JSON.stringify(frameIds)}::jsonb`),
    )
    .orderBy(desc(frameDevTasks.createdAt))
  const stale = rows.slice(DEV_TASK_KEEP_PER_FRAME).map((r) => r.id)
  if (stale.length) {
    await db.delete(frameDevTasks).where(and(eq(frameDevTasks.canvasId, canvasId), inArray(frameDevTasks.id, stale)))
  }
}

/** The launch the POST hands to the device, and its row. */
export async function createDevTask(input: {
  canvasId: string
  frameIds: string[]
  frameRevision: number | null
  pack: HandoffPack
  link: RepoLink
  userId: string
  userName: string
  agent: string
  model?: string
  effort?: string
  environment?: string
}): Promise<DevTask> {
  const now = Date.now()
  const id = nanoid(10)
  const environment = input.environment
  const row = {
    id,
    canvasId: input.canvasId,
    frameIds: input.frameIds,
    handoffChangeId: input.pack.changeId,
    frameRevision: input.frameRevision,
    duelId: null,
    requestedByUserId: input.userId,
    requestedByName: input.userName,
    deviceId: null,
    runner: 'orca',
    agent: input.agent,
    model: input.model ?? null,
    effort: input.effort ?? null,
    hostLabel: environment ?? 'This Mac',
    environment: environment ?? null,
    orcaIdentity: null,
    orcaSessionId: null,
    branch: `doop/${input.pack.changeId}`,
    prUrl: null,
    state: 'queued' as DevTaskState,
    agentState: null,
    summary: null,
    drift: null,
    handoff: input.pack,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  }
  await db.insert(frameDevTasks).values(row)
  await prune(input.canvasId, input.frameIds)
  const task = toTask(row as Row)
  const args: DevTaskLaunchArgs = {
    taskId: id,
    worktreeName: `doop-${input.pack.changeId}`.slice(0, 80),
    branch: `doop/${input.pack.changeId}`,
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    prompt: devTaskPrompt({
      canvasId: input.canvasId,
      frameIds: input.frameIds,
      taskId: id,
      changeId: input.pack.changeId,
    }),
    comment: devTaskComment({
      canvasUrl: `${env.BETTER_AUTH_URL}/c/${input.canvasId}`,
      frameId: input.frameIds[0]!,
      taskId: id,
    }),
    ...(environment ? { environment } : {}),
  }
  /* the device answers through the report route, which settles the bridge
     entry itself; a job that never gets claimed fails the task at its TTL */
  void localRepo
    .repoRequest(input.userId, input.link.id, 'dev_task', { devTask: args }, DEV_TASK_LAUNCH_TTL_MS)
    .then((result) => {
      if (!result.ok) void failUnlaunched(id, result.error ?? 'the launch did not answer')
    })
  announce(task)
  return task
}

/** A queued launch whose job expired unanswered. Already-answered launches
 *  are untouched: the report route binds `claimed` on the row. */
async function failUnlaunched(id: string, error: string): Promise<void> {
  const row = await devTaskRow(id)
  if (!row || row.state !== 'queued') return
  await patch(id, {
    state: 'failed',
    summary: `${error} — open the desktop app`.slice(0, DEV_TASK_SUMMARY_CHARS),
    finishedAt: Date.now(),
  })
}

/* ------------------------------------------------------------------ */
/* reports — the device's answer                                       */
/* ------------------------------------------------------------------ */

export type ReportOutcome = { ok: true; task: DevTask } | { ok: false; status: number; error: string }

/**
 * `POST /api/dev-tasks/:id/report`. Only the requester's own session may
 * report, and once a report binds the row's `deviceId`, only that install
 * may speak for it. `requestId` settles the bridge entry the launch rode
 * on (localRepo.finish with the launch's own verdict).
 */
export async function applyDeviceReport(userId: string, taskId: string, report: DevTaskReport): Promise<ReportOutcome> {
  const row = await devTaskRow(taskId)
  if (!row) return { ok: false, status: 404, error: 'no such dev task' }
  if (row.requestedByUserId !== userId)
    return { ok: false, status: 403, error: 'only the requester’s device may report' }
  if (row.deviceId && row.deviceId !== report.deviceId)
    return { ok: false, status: 409, error: 'another device owns this task' }
  if (report.requestId) {
    /* finishing the bridge entry stops it expiring into a false failure;
       the entry must have been claimed by this very device */
    const launch = report.launch
    localRepo.finish(report.requestId, userId, report.deviceId, {
      ok: launch ? launch.ok && !launch.cancelled : true,
      ...(launch?.cancelled ? { error: 'cancelled' } : launch?.error ? { error: launch.error } : {}),
    })
  }
  const set: Partial<typeof frameDevTasks.$inferInsert> = {}
  if (!row.deviceId) set.deviceId = report.deviceId

  const launch = report.launch
  if (launch) {
    set.state = launchState(row, launch)
    if (launch.orcaIdentity) set.orcaIdentity = launch.orcaIdentity.slice(0, 120)
    if (launch.branch) set.branch = launch.branch.slice(0, 200)
    if (launch.orcaSessionId) set.orcaSessionId = launch.orcaSessionId.slice(0, 200)
    if (launch.error) set.summary = launch.error.slice(0, DEV_TASK_SUMMARY_CHARS)
    if (isTerminal(set.state)) set.finishedAt = Date.now()
  }

  const poll = report.poll
  if (poll) {
    const next = mergedPollState(row, pollStateOf(poll))
    set.state = next
    if (poll.lastAssistantMessage) set.summary = poll.lastAssistantMessage.slice(0, DEV_TASK_SUMMARY_CHARS)
    if (poll.linkedPR) set.prUrl = poll.linkedPR.slice(0, 500)
    if (poll.orcaSessionId) set.orcaSessionId = poll.orcaSessionId.slice(0, 200)
    if (poll.branch) set.branch = poll.branch.slice(0, 200)
    if (poll.devUrl !== undefined) {
      /* the dev server the worktree printed — http(s) only, like pr_url */
      const url = typeof poll.devUrl === 'string' ? poll.devUrl.slice(0, 500) : ''
      set.devUrl = url && /^https?:\/\//.test(url) ? url : null
    }
    if (isTerminal(next) && !row.finishedAt) set.finishedAt = Date.now()
  }

  const task = await patch(taskId, set)
  return task ? { ok: true, task } : { ok: false, status: 404, error: 'no such dev task' }
}

/* ------------------------------------------------------------------ */
/* agent updates — update_dev_task over MCP                            */
/* ------------------------------------------------------------------ */

/**
 * The coding agent's own report. Only the requester's credentials may push
 * (the agent runs with their Diazo MCP), and only the agent-facing states:
 * it can ask for input, attach its PR, and end the task — it cannot mark
 * itself queued or cancel a person's stop.
 */
export async function applyAgentUpdate(
  userId: string | undefined,
  update: DevTaskAgentUpdate,
): Promise<{ ok: true; task: DevTask } | { ok: false; error: string }> {
  const row = await devTaskRow(update.task_id)
  if (!row) return { ok: false, error: `no dev task ${update.task_id} — the id comes from the launch brief` }
  if (!userId || row.requestedByUserId !== userId)
    return { ok: false, error: 'only the requester’s agent may update this dev task' }
  if (row.state === 'cancelled') return { ok: false, error: 'this dev task was cancelled — stop working on it' }
  if (update.state !== undefined && !isDevTaskPushState(update.state))
    return { ok: false, error: `state must be one of ${DEV_TASK_PUSH_STATES.join(', ')}` }

  const set: Partial<typeof frameDevTasks.$inferInsert> = {}
  if (update.state) {
    /* a terminal state is frozen except that the agent itself may refine it:
       failed → done stays refused, done → failed too, but the same state
       with fresh fields always lands */
    if (isTerminal(row.state) && row.state !== update.state) {
      return { ok: false, error: `this dev task is already ${row.state}` }
    }
    set.state = update.state
    set.agentState = update.state
    if (isTerminal(update.state) && !row.finishedAt) set.finishedAt = Date.now()
  }
  if (update.pr_url !== undefined) {
    const url = update.pr_url.slice(0, 500)
    if (url && !/^https?:\/\//.test(url)) return { ok: false, error: 'pr_url must be an http(s) URL' }
    set.prUrl = url || null
    /* attaching a PR without a state means the work reached review */
    if (!update.state && !isTerminal(row.state)) {
      set.state = 'pr_open'
      set.agentState = 'pr_open'
    }
  }
  if (update.summary !== undefined) set.summary = update.summary.slice(0, DEV_TASK_SUMMARY_CHARS) || null
  if (update.orca_session_id !== undefined) set.orcaSessionId = update.orca_session_id.slice(0, 200) || null
  if (update.branch !== undefined) set.branch = update.branch.slice(0, 200) || null
  if (!Object.keys(set).length)
    return { ok: false, error: 'nothing to update — pass state, pr_url, summary, orca_session_id or branch' }

  const task = await patch(update.task_id, set)
  return task ? { ok: true, task } : { ok: false, error: 'no such dev task' }
}

/* ------------------------------------------------------------------ */
/* cancel                                                              */
/* ------------------------------------------------------------------ */

/** The person's stop: marks the row cancelled. Nothing destructive is sent
 *  anywhere — stopping the agent stays the person's own click in Orca
 *  (orca_activate), and worktree removal stays behind its native confirm. */
export async function cancelDevTask(taskId: string): Promise<DevTask | undefined> {
  const row = await devTaskRow(taskId)
  if (!row) return undefined
  if (isTerminal(row.state)) return toTask(row)
  return patch(taskId, { state: 'cancelled', finishedAt: Date.now() })
}
