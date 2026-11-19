import type { DevTaskLaunchArgs, DevTaskLaunchReport, DevTaskPollReport } from '../../shared/devTasks'

/**
 * The typed Orca commands the desktop shell exposes (desktop/src-tauri/src/
 * orca.rs, documented in docs/orca.md). Every call is `__TAURI__.core.invoke`
 * with typed fields — the shell builds argv, never this side — and a launch
 * always passes a native confirmation on the device.
 */

type OrcaBridge = {
  __DIAZO_ORCA__?: boolean
  /** the name older shells advertise */
  __DOOP_ORCA__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
const bridge = globalThis as OrcaBridge

/** The page is inside an Orca-aware desktop shell — browsers only watch. */
export const hasOrca = () =>
  (bridge.__DIAZO_ORCA__ === true || bridge.__DOOP_ORCA__ === true) && !!bridge.__TAURI__?.core

function invokeOrca<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasOrca() || !bridge.__TAURI__) {
    return Promise.reject(new Error('Orca dev tasks need the Diazo desktop app.'))
  }
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

/** `orca status` + `host list` + `account list`, trimmed by the shell. */
export interface OrcaStatus {
  installed: boolean
  running?: boolean
  version?: string
  /** `host list` rows of kind 'environment' — launch targets beyond this Mac */
  environments: { name?: string | null; id?: string | null }[]
  hosts: { name?: string | null; kind?: string | null; id?: string | null; connected?: boolean | null }[]
  /** agent ids holding at least one configured account */
  agents: string[]
}

export function orcaStatus(): Promise<OrcaStatus> {
  return invokeOrca<OrcaStatus>('orca_status')
}

/** The reply `orca_launch_task` gives — a superset of the reportable
 *  `DevTaskLaunchReport` (the shell may carry `operationId` for a lost reply).
 *  Current shells omit absent fields; an older shell may send `null`, which
 *  the report boundary normalizes back to omission. */
export interface OrcaLaunchReply extends DevTaskLaunchReport {
  operationId?: string
}

/** `orca worktree create … --json` behind the native confirmation. `linkId`
 *  is the repo-link grant the request rode in on — the shell resolves the
 *  repo from it, the page never names a path. */
export function orcaLaunchTask(linkId: string, args: DevTaskLaunchArgs): Promise<OrcaLaunchReply> {
  return invokeOrca<OrcaLaunchReply>('orca_launch_task', {
    taskId: args.taskId,
    linkId,
    worktreeName: args.worktreeName,
    branch: args.branch,
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null,
    prompt: args.prompt,
    comment: args.comment,
    environment: args.environment ?? null,
  })
}

/** One watched identity in an `orca_poll` answer: the identity plus the
 *  trimmed `worktree ps` row the report route takes. Current shells omit
 *  absent fields; an older shell may send `null`, which the report
 *  boundary normalizes back to omission (except `devUrl`, whose `null`
 *  clears the stored URL). */
export interface OrcaPollRow extends DevTaskPollReport {
  identity: string
}

export function orcaPoll(environment?: string): Promise<{ rows: OrcaPollRow[] }> {
  return invokeOrca<{ rows: OrcaPollRow[] }>('orca_poll', { environment: environment ?? null })
}

/** Stop watching identities whose terminal state the server already knows. */
export function orcaUntrack(identities: string[]): Promise<{ removed: number }> {
  return invokeOrca<{ removed: number }>('orca_untrack', { identities })
}

/** `worktree activate` — "Open in Orca" on a task this shell launched. */
export function orcaActivate(identity: string, environment?: string | null): Promise<{ ok: boolean }> {
  return invokeOrca<{ ok: boolean }>('orca_activate', { identity, environment: environment ?? null })
}
