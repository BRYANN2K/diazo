import { create } from 'zustand'
import { api, ApiError } from './api'
import type { RepoLink, RepoLinkStatus, RepoRequest, RepoResult } from '../../shared/localRepo'
import { DEV_TASK_TERMINAL, type DevTaskLaunchReport, type DevTaskReport } from '../../shared/devTasks'
import { hasOrca, orcaLaunchTask, orcaPoll, orcaStatus, orcaUntrack, type OrcaPollRow } from './orca'
import { useStore } from './store'

type Bridge = {
  __DOOP_LOCAL_REPO__?: boolean
  /** the shell has repo_apply_patch (older shells only read) */
  __DOOP_REPO_PATCH__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
const bridge = globalThis as Bridge

/** The desktop shell holds the grants and does the reads (repo.rs); a plain
 *  browser tab can see a link's status but cannot pick or serve folders. */
export const hasLocalRepo = () => bridge.__DOOP_LOCAL_REPO__ === true && !!bridge.__TAURI__?.core

function invokeRepo<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasLocalRepo() || !bridge.__TAURI__) {
    return Promise.reject(new Error('Link a local project from the Diazo desktop app.'))
  }
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

/** One stable id per install — the link records it, so a different device
 *  polling for the same account is flagged instead of silently used. */
export function repoDeviceId(): string {
  const KEY = 'doop.repo.device'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

interface RepoGrant {
  id: string
  name: string
}

/** link status per canvas id, for the Agents panel row */
export const useLocalRepo = create<{ status: Record<string, RepoLinkStatus | undefined> }>(() => ({
  status: {},
}))

export async function refreshLocalRepo(canvasId: string): Promise<RepoLinkStatus> {
  const status = await api.canvasRepo(canvasId)
  useLocalRepo.setState((s) => ({ status: { ...s.status, [canvasId]: status } }))
  return status
}

/** Native picker + consent → grant on this device → link row on the server.
 *  Answers the stored link, or null when the person cancelled. */
export async function linkLocalProject(canvasId: string): Promise<RepoLink | null> {
  const picked = await invokeRepo<{ id: string | null; name?: string }>('repo_choose', { canvasId })
  if (!picked.id || !picked.name) return null
  const { link } = await api.linkCanvasRepo(canvasId, {
    linkId: picked.id,
    name: picked.name,
    deviceId: repoDeviceId(),
  })
  await refreshLocalRepo(canvasId)
  return link
}

/** Drop the server link, and this device's grant too when it holds one. */
export async function unlinkLocalProject(canvasId: string, linkId: string): Promise<void> {
  await api.unlinkCanvasRepo(canvasId)
  if (hasLocalRepo()) await invokeRepo('repo_forget', { linkId }).catch(() => {})
  await refreshLocalRepo(canvasId)
}

/* ~10s between `worktree ps` polls per environment, as docs/orca.md lays out */
const ORCA_POLL_MS = 10_000
/* a report the server has not acknowledged rides again after this pause */
const REPORT_RETRY_MS = 5_000

/**
 * The device's end of the bridge: advertise the grants this install holds,
 * answer each request the server hands out through repo.rs, and post the
 * result back. Lives above navigation like startLocalAgent — the reads
 * keep working on whichever canvas page is open.
 *
 * `dev_task` requests take a second path: they launch through the typed
 * `orca_launch_task` command and answer on `/api/dev-tasks/:id/report` —
 * the report's `requestId` settles the bridge entry, `finish` never sees
 * them. While a launched task lives, the shell polls `orca worktree ps`
 * and posts the trimmed rows; a report the server does not acknowledge is
 * retried, never re-launched.
 */
export function startLocalRepo(): () => void {
  if (!hasLocalRepo()) return () => {}
  const deviceId = repoDeviceId()
  let disposed = false

  const serve = async (request: RepoRequest): Promise<RepoResult> => {
    if (request.op === 'apply_patch' && bridge.__DOOP_REPO_PATCH__ !== true)
      return { ok: false, error: 'update the doop desktop app to write patches into the linked project' }
    try {
      const result = await invokeRepo<unknown>(`repo_${request.op}`, { linkId: request.linkId, ...request.args })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /* --- dev tasks ----------------------------------------------------- */

  /* orca identities this session launched — or re-discovered after a
     reload — → the dev task they serve, so a poll row routes to the right
     report. The shell's own orca-tasks.json remembers them across reloads;
     rows the open canvas cannot name yet (their canvas is not open) stay
     watched without a task id until hydration lands. */
  const tracked = new Map<string, { taskId?: string; environment?: string }>()
  /* reports awaiting the server's answer — launch answers land here too,
     so a lost reply is delivered again without ever re-running create */
  const pending = new Map<string, DevTaskReport>()

  const taskIdFor = (identity: string): string | undefined => {
    const entry = tracked.get(identity)
    if (entry?.taskId) return entry.taskId
    const taskId = Object.values(useStore.getState().devTasks).find((task) => task.orcaIdentity === identity)?.id
    /* remember a resolution that only late hydration could name — the
       canvas that carried it may switch away and take devTasks with it */
    if (taskId && entry) tracked.set(identity, { ...entry, taskId })
    return taskId
  }

  const untrack = (identity: string) => {
    tracked.delete(identity)
    void orcaUntrack([identity]).catch(() => {})
  }

  /** The room already counts this task as over (the agent pushed done, or
   *  someone cancelled) — the server has the terminal state, so the
   *  worktree leaves the watch set. */
  const untrackEnded = () => {
    const devTasks = useStore.getState().devTasks
    for (const [identity, entry] of tracked) {
      const taskId = entry.taskId ?? taskIdFor(identity)
      const task = taskId ? devTasks[taskId] : undefined
      if (task && DEV_TASK_TERMINAL.includes(task.state)) untrack(identity)
    }
  }

  const flush = async (taskId: string): Promise<void> => {
    const report = pending.get(taskId)
    if (!report) return
    try {
      const { task } = await api.reportDevTask(taskId, report)
      /* a report merged in while this one was in flight stays queued */
      if (pending.get(taskId) === report) pending.delete(taskId)
      if (DEV_TASK_TERMINAL.includes(task.state)) {
        for (const [identity, entry] of tracked) if (entry.taskId === taskId) untrack(identity)
      }
    } catch (error) {
      /* gone, or the requester lost access: nothing will ever take this
         report — drop it and stop watching the worktree */
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        pending.delete(taskId)
        for (const [identity, entry] of tracked) if (entry.taskId === taskId) untrack(identity)
      }
      /* anything else keeps the report queued for the retry pass */
    }
  }

  /* the report contract's absent means `undefined` — older shells send it
     as explicit `null`, which the shared DevTask*Report types and the REST
     schema both read as omission. Strip nulls at the boundary so a report
     never carries a key with nothing in it — except `devUrl`, whose null
     is the signal that clears the stored dev-server URL. */
  const omitNulls = <T extends object>(obj: T, keep: readonly (keyof T)[] = []): T =>
    Object.fromEntries(
      Object.entries(obj).filter(([key, value]) => value !== null || (keep as readonly string[]).includes(key)),
    ) as T

  /** Merge into the task's queued report and try it now — a poll delta may
   *  ride a launch answer still waiting for its ack. */
  const queueReport = (taskId: string, report: Omit<DevTaskReport, 'deviceId'>) => {
    const prev = pending.get(taskId)
    const merged: DevTaskReport = { ...(prev ?? {}), ...report, deviceId }
    if (merged.launch) merged.launch = omitNulls(merged.launch)
    if (merged.poll) merged.poll = omitNulls(merged.poll, ['devUrl'])
    pending.set(taskId, merged)
    void flush(taskId)
  }

  /** The `dev_task` bridge request: typed `orca_launch_task` then the
   *  report. Runs off the repo loop so a slow native confirm never stalls
   *  ordinary folder reads. */
  const runDevTask = async (request: RepoRequest): Promise<void> => {
    const args = request.args.devTask
    if (!args) {
      /* malformed request — settle the bridge entry and leave the task to
         its TTL sweep; there is no task id to report against */
      await api
        .finishLocalRepo(request.id, deviceId, { ok: false, error: 'dev_task request is missing its launch args' })
        .catch(() => {})
      return
    }
    let launch: DevTaskLaunchReport
    if (!hasOrca()) {
      launch = { ok: false, error: 'update the Diazo desktop app to launch Orca dev tasks' }
    } else {
      try {
        launch = await orcaLaunchTask(request.linkId, args)
      } catch (error) {
        launch = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (launch.ok && launch.orcaIdentity)
      tracked.set(launch.orcaIdentity, { taskId: args.taskId, environment: args.environment })
    queueReport(args.taskId, { requestId: request.id, launch })
  }

  /* the environments worth asking this tick: every one a watched identity
     lives on, plus every one a live canvas task names — that second set is
     what re-primes `tracked` after a reload, when the Map is still empty
     but the canvas rows already carry orcaIdentity. orcaPoll itself only
     ever returns identities this shell launched, so a foreign task's
     environment costs one empty `worktree ps`, never a wrong report */
  const watchEnvironments = (): Set<string | undefined> => {
    const environments = new Set<string | undefined>()
    for (const entry of tracked.values()) environments.add(entry.environment)
    for (const task of Object.values(useStore.getState().devTasks)) {
      if (task.orcaIdentity && !DEV_TASK_TERMINAL.includes(task.state)) {
        environments.add(task.environment ?? undefined)
      }
    }
    return environments
  }

  const pollEnvironment = async (environment: string | undefined): Promise<void> => {
    let rows: OrcaPollRow[]
    try {
      rows = (await orcaPoll(environment)).rows
    } catch {
      return // this environment could not be asked — next tick
    }
    for (const row of rows) {
      const { identity, ...poll } = row
      /* a persisted identity this session did not launch — the reload
         case — rejoins the watch set with whatever task id can be named */
      if (!tracked.has(identity)) tracked.set(identity, { taskId: taskIdFor(identity), environment })
      const taskId = taskIdFor(identity)
      if (taskId) queueReport(taskId, { poll })
    }
  }

  /* one `worktree ps` per environment the tracked set or the open canvas
     touches; each row is trimmed shell-side already and just forwarded as
     a poll report. The first tick also sweeps every launch target the
     status command names — this Mac's tasks and a paired VPS's alike —
     because a reloaded shell's own worktrees may live on a canvas that is
     not open; an identity found there stays watched through `tracked` */
  const pollLoop = async () => {
    let discovered = false
    while (!disposed) {
      await new Promise((r) => setTimeout(r, ORCA_POLL_MS))
      if (disposed) return
      untrackEnded()
      const environments = watchEnvironments()
      if (!discovered) {
        discovered = true
        environments.add(undefined)
        try {
          const { environments: remote } = await orcaStatus()
          for (const env of remote) if (typeof env.name === 'string' && env.name) environments.add(env.name)
        } catch {
          /* status unavailable — the named environments are still probed */
        }
      }
      for (const environment of environments) await pollEnvironment(environment)
    }
  }

  const retryLoop = async () => {
    while (!disposed) {
      await new Promise((r) => setTimeout(r, REPORT_RETRY_MS))
      for (const taskId of pending.keys()) await flush(taskId)
    }
  }

  /* ------------------------------------------------------------------ */

  const loop = async () => {
    while (!disposed) {
      try {
        const grants = await invokeRepo<RepoGrant[]>('repo_grants')
        const { request } = await api.pollLocalRepo(
          deviceId,
          grants.map((g) => g.id),
        )
        if (!request) continue // the long-poll timed out — ask again
        if (request.op === 'dev_task') void runDevTask(request)
        else await api.finishLocalRepo(request.id, deviceId, await serve(request))
      } catch {
        if (disposed) return
        await new Promise((r) => setTimeout(r, 3000)) // back off on errors
      }
    }
  }
  void loop()
  void pollLoop()
  void retryLoop()
  return () => {
    disposed = true
  }
}
