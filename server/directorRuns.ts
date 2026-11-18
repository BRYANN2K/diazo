/**
 * server/directorRuns.ts — the director-run store.
 *
 * One row per staged Animate run (shared/director.ts): the loop mutates the
 * in-memory record, this module writes it through to `director_runs` and
 * broadcasts `director` to the canvas room. Saves are immediate on stage
 * changes and pass records, throttled to once a second while calls are
 * charged, so a busy run never out-writes its own progress. At boot a row
 * still marked `running` means the process died mid-run: it is written back
 * as `interrupted` and its card fails with the retry-from-film reason.
 */
import * as persist from './db/persist.ts'
import { directorRunView, type DirectorRun, type DirectorRunView } from '../shared/director.ts'
import type { ServerMessage } from '../shared/types.ts'

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
let broadcast: Broadcast = () => {}

export function wireDirectorRuns(b: Broadcast) {
  broadcast = b
}

const runs = new Map<string, DirectorRun>()
/** 'canvasId\npageId' -> run ids, newest first */
const byPage = new Map<string, string[]>()
/** taskId -> runId, for feedback parentRunId lookups */
const byTask = new Map<string, string>()
/** agent_runs id -> runId on live runs — critique_scene finds its pass
 *  state through the actor's runId without threading it through execTool */
const byAgentRun = new Map<string, string>()

/** history kept per page */
const RUNS_PER_PAGE = 20
/** floor between non-essential writes of one run */
const SAVE_THROTTLE_MS = 1_000
const lastSave = new Map<string, number>()

const pageKey = (canvasId: string, pageId: string) => `${canvasId}\n${pageId}`

/** Fill the store from the boot hydrate; a `running` row is a dead run. */
export function initDirectorRuns(list: DirectorRun[]) {
  const reason = 'The server restarted. Retry continues from the film as it is.'
  for (const run of list) {
    if (run.status === 'running') {
      run.status = 'interrupted'
      run.endedAt = run.endedAt ?? Date.now()
      run.reason = reason
      persist.saveDirectorRun(run)
      /* the card the dead run claimed fails with the retry-from-film line;
         dynamic import — actions.ts reads this module for takeAnimateCard */
      const { canvasId, taskId } = run
      import('./actions.ts').then((a) => a.failCard(canvasId, taskId, reason)).catch(() => {})
    }
    index(run)
  }
}

function index(run: DirectorRun) {
  runs.set(run.id, run)
  byTask.set(run.taskId, run.id)
  const key = pageKey(run.canvasId, run.pageId)
  const list = (byPage.get(key) ?? []).filter((id) => id !== run.id)
  list.unshift(run.id)
  /* history cap per page: the oldest runs fall off the map (their rows stay) */
  for (const id of list.splice(RUNS_PER_PAGE)) {
    const drop = runs.get(id)
    if (drop && drop.status !== 'running') {
      runs.delete(id)
      byTask.delete(drop.taskId)
    }
  }
  byPage.set(key, list)
}

/** Insert a new run (the loop builds the record). Saved and broadcast at once. */
export function insertDirectorRun(run: DirectorRun): DirectorRun {
  index(run)
  persist.saveDirectorRun(run)
  broadcastRun(run)
  return run
}

/** Persist + broadcast a mutation. `force` skips the once-a-second throttle —
 *  stage changes, pass records and settles always go through. */
export function touchDirectorRun(run: DirectorRun, opts?: { force?: boolean; silent?: boolean }) {
  const now = Date.now()
  if (opts?.force || now - (lastSave.get(run.id) ?? 0) >= SAVE_THROTTLE_MS) {
    lastSave.set(run.id, now)
    persist.saveDirectorRun(run)
  }
  if (!opts?.silent) broadcastRun(run)
}

export function broadcastRun(run: DirectorRun) {
  broadcast(run.canvasId, { type: 'director', run: directorRunView(run) })
}

export function getDirectorRun(id: string): DirectorRun | undefined {
  return runs.get(id)
}

export function directorRunForTask(taskId: string): DirectorRun | undefined {
  const id = byTask.get(taskId)
  return id ? runs.get(id) : undefined
}

/** The live run on a page, if any — a second animate card waits on it. */
export function runningDirectorForPage(canvasId: string, pageId: string): DirectorRun | undefined {
  for (const id of byPage.get(pageKey(canvasId, pageId)) ?? []) {
    const run = runs.get(id)
    if (run?.status === 'running') return run
  }
  return undefined
}

export function listDirectorRuns(canvasId: string, pageId?: string, limit = 20): DirectorRunView[] {
  const out: DirectorRun[] = []
  if (pageId) {
    for (const id of byPage.get(pageKey(canvasId, pageId)) ?? []) {
      const run = runs.get(id)
      if (run) out.push(run)
    }
  } else {
    out.push(...[...runs.values()].filter((r) => r.canvasId === canvasId).sort((a, b) => b.startedAt - a.startedAt))
  }
  return out.slice(0, Math.max(1, Math.min(limit, 100))).map(directorRunView)
}

/** The director run an agent_runs row belongs to — critique_scene inside a
 *  run reads its pass state through the actor's runId. */
export function directorRunForAgentRun(agentRunId: string | undefined): DirectorRun | undefined {
  if (!agentRunId) return undefined
  const id = byAgentRun.get(agentRunId)
  return id ? runs.get(id) : undefined
}

export function registerAgentRun(agentRunId: string | undefined, run: DirectorRun) {
  if (agentRunId) byAgentRun.set(agentRunId, run.id)
}

export function unregisterAgentRun(agentRunId: string | undefined) {
  if (agentRunId) byAgentRun.delete(agentRunId)
}

export function dropDirectorRuns(canvasId: string) {
  for (const [id, run] of runs) {
    if (run.canvasId !== canvasId) continue
    runs.delete(id)
    byTask.delete(run.taskId)
    lastSave.delete(id)
  }
  for (const key of byPage.keys()) {
    if (key.startsWith(`${canvasId}\n`)) byPage.delete(key)
  }
}
