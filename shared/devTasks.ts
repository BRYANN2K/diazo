import type { HandoffPack } from './handoff.ts'

/**
 * A dev task: one launch of a coding agent into an Orca worktree, sent from
 * a ready-for-dev frame. The server keeps the record (`frame_dev_tasks`),
 * the desktop shell runs the `orca` CLI through typed commands
 * (`desktop/src-tauri/src/orca.rs` — never a shell), and the coding agent
 * reads its brief and reports back over the Diazo MCP (`get_handoff`,
 * `update_dev_task`). Status also reaches the room as `dev-task`
 * broadcasts. Keep in step with `server/devTasks.ts` and `orca.rs`.
 *
 * Trust split, as in shared/localRepo.ts: the server never learns the
 * worktree's absolute path — `orca_identity` is the opaque `wt2:` key — and
 * every launch passes a native confirmation on the device that holds the
 * canvas's linked-folder grant.
 */

/** Where one task sits between "Send to Orca" and the PR. */
export const DEV_TASK_STATES = [
  /** row created; the launch job is waiting for the device to claim it */
  'queued',
  /** `worktree create` ran; setup hooks or the agent start are still in flight */
  'starting',
  /** the agent is running (`mainAgent.state = working`) */
  'working',
  /** the agent asked something or waits on a person (`blocked` / `waiting`) */
  'needs_input',
  /** a PR is attached — `linkedPR` on the row or the agent's own report */
  'pr_open',
  /** finished with a success outcome */
  'done',
  /** launch failed, agent ended in failure/interruption, or the worktree died */
  'failed',
  /** the person stopped it, or the worktree went away in Orca */
  'cancelled',
] as const
export type DevTaskState = (typeof DEV_TASK_STATES)[number]

/** States nothing leaves: done, failed, cancelled. */
export const DEV_TASK_TERMINAL: readonly DevTaskState[] = ['done', 'failed', 'cancelled']

/** The states a coding agent may push through `update_dev_task`. */
export const DEV_TASK_PUSH_STATES = ['needs_input', 'pr_open', 'done', 'failed'] as const
export type DevTaskPushState = (typeof DEV_TASK_PUSH_STATES)[number]

/** Agents Orca can launch for a dev task (from `orca account list`). */
export const DEV_TASK_AGENTS = ['claude', 'codex', 'opencode', 'devin'] as const

/** Row counts and field caps. */
export const DEV_TASK_KEEP_PER_FRAME = 20
export const DEV_TASK_SUMMARY_CHARS = 500
export const DEV_TASK_PROMPT_CHARS = 8 * 1024
export const DEV_TASK_COMMENT_CHARS = 500
/** How long a queued launch may sit before it counts as lost. */
export const DEV_TASK_LAUNCH_TTL_MS = 10 * 60_000

/** The task as the room, REST and MCP see it — never the pack or a path. */
export interface DevTask {
  id: string
  canvasId: string
  frameIds: string[]
  /** the Stip change id the stored handoff pack was built under */
  handoffChangeId: string
  /** `approval.approvedFrameUpdatedAt` at launch — an older value than the
   *  frame's current approval means the design moved since the build */
  frameRevision: number | null
  /** groups duel contestants (phase 3); null for a solo launch */
  duelId: string | null
  /** display name and id of the person who clicked Send to Orca */
  requestedBy: string
  requestedByUserId: string
  /** the desktop install that answered the launch; null until it reports */
  deviceId: string | null
  /** the runner that owns execution — 'orca' today, room for others */
  runner: string
  agent: string
  model: string | null
  effort: string | null
  /** a label for the launch target — "This Mac" or the environment name */
  hostLabel: string
  /** the `--environment` selector the launch ran against; null = this machine */
  environment: string | null
  /** Orca's opaque `wt2:<host>:<instance>` key — the only worktree handle stored */
  orcaIdentity: string | null
  orcaSessionId: string | null
  branch: string | null
  prUrl: string | null
  state: DevTaskState
  /** the agent's last line or a human-readable failure, capped */
  summary: string | null
  /** the latest drift review for this task's build (phase 2) */
  drift: DevTaskDrift | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export interface DevTaskDrift {
  score: number
  cards: number
  comparedAt: number
  /** where the built side came from */
  source: 'live' | 'orca-screenshot' | 'built'
}

/* ------------------------------------------------------------------ */
/* the launch job (server → device, over the local-repo poll bridge)    */
/* ------------------------------------------------------------------ */

/** The `dev_task` op's payload on a `RepoRequest`: everything the shell
 *  needs to build the `orca worktree create` argv. Every field is typed —
 *  nothing here is a shell string. */
export interface DevTaskLaunchArgs {
  taskId: string
  /** Orca worktree name — `doop-<changeId>` */
  worktreeName: string
  /** git branch — `doop/<changeId>` */
  branch: string
  agent: string
  model?: string
  effort?: string
  /** the short brief the agent starts with (built by devTaskPrompt) */
  prompt: string
  /** the `doop:` comment stamped on the worktree (frame link + task id) */
  comment: string
  /** `--environment` selector; absent = this machine's Orca */
  environment?: string
}

/* ------------------------------------------------------------------ */
/* reports (device → server, POST /api/dev-tasks/:id/report)            */
/* ------------------------------------------------------------------ */

/** What the shell posts after the launch attempt. `requestId` releases the
 *  claimed bridge request; the first report also binds the task's device. */
export interface DevTaskLaunchReport {
  /** the worktree create ran and returned */
  ok: boolean
  /** the person declined the native confirmation */
  cancelled?: boolean
  /** Orca/CLI failure text when ok is false */
  error?: string
  orcaIdentity?: string
  worktreeId?: string
  branch?: string
  /** `launch.outcome.kind`: 'structured' (a chat) or 'terminal' */
  launchKind?: string
  /** `launch.outcome.handle` — the chat or terminal handle */
  launchHandle?: string
  orcaSessionId?: string
  /** retry handle for a lost reply — the shell keeps it for `--retry-launch` */
  operationId?: string
}

/** One `worktree ps` row, trimmed to what a task needs — the shell picks
 *  these fields out of the JSON row; the absolute path never crosses. */
export interface DevTaskPollReport {
  /** the identity still appears in `worktree ps`; false = worktree gone */
  found: boolean
  /** the row's `status` ('working'…) */
  status?: string
  /** the agent's own state, from `agents[].state` or `mainAgent.state` */
  agentState?: string
  /** `mainAgent.outcome` — success | failure | cancellation | interruption */
  outcome?: string
  lastAssistantMessage?: string
  linkedPR?: string | null
  orcaSessionId?: string
  branch?: string
  /** the worktree's `workspaceStatus` board column */
  workspaceStatus?: string
}

/** Body of `POST /api/dev-tasks/:id/report`: a launch answer, a poll
 *  delta, or both (the first poll can ride the launch reply). */
export interface DevTaskReport {
  deviceId: string
  /** the bridge request this report settles, when it answers one */
  requestId?: string
  launch?: DevTaskLaunchReport
  poll?: DevTaskPollReport
}

/* ------------------------------------------------------------------ */
/* REST bodies                                                         */
/* ------------------------------------------------------------------ */

/** `POST /api/frames/:id/dev-tasks` — the launch request. */
export interface DevTaskCreateBody {
  agent: string
  model?: string
  effort?: string
  /** an environment `orca host list` printed (e.g. 'vps'); absent = this Mac */
  environment?: string
}

/** `update_dev_task` (MCP): the coding agent's own report. */
export interface DevTaskAgentUpdate {
  task_id: string
  state?: DevTaskPushState
  pr_url?: string
  summary?: string
  orca_session_id?: string
  branch?: string
}

/* ------------------------------------------------------------------ */
/* the brief                                                           */
/* ------------------------------------------------------------------ */

/** The launch's `--prompt` — deliberately short: the confirmation shows it
 *  whole and the pack itself travels over MCP, never through argv. */
export function devTaskPrompt(input: {
  canvasId: string
  frameIds: string[]
  taskId: string
  changeId: string
}): string {
  return [
    'You are implementing a design signed off in Diazo.',
    `Canvas ${input.canvasId}, frame(s) ${input.frameIds.join(', ')}, dev task ${input.taskId}, Stip change ${input.changeId}.`,
    `1. Call the Diazo MCP tool get_handoff({ task_id: "${input.taskId}" }) and follow spec.md's AC list.`,
    '2. Read get_frame and get_tokens for exact values; respect code-links.json.',
    '3. Report with update_dev_task when you open a PR and when you finish (one-line summary).',
    'If the Diazo MCP is not connected, say so and stop.',
  ].join('\n')
}

/** The `doop:` comment stamped on the Orca worktree — the frame link and
 *  the task id, nothing else. orca.rs only ever refreshes comments that
 *  already carry this prefix. */
export function devTaskComment(input: { canvasUrl: string; frameId: string; taskId: string }): string {
  return `doop: ${input.canvasUrl}?frame=${input.frameId} · task ${input.taskId}`
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

/** What `get_handoff` answers: the stored pack plus enough context to know
 *  what it is for. PNG files come back as image content blocks. */
export interface DevTaskHandoff {
  task: Pick<DevTask, 'id' | 'canvasId' | 'frameIds' | 'state' | 'handoffChangeId'>
  pack: HandoffPack
}

export function isDevTaskState(value: unknown): value is DevTaskState {
  return typeof value === 'string' && (DEV_TASK_STATES as readonly string[]).includes(value)
}

export function isDevTaskPushState(value: unknown): value is DevTaskPushState {
  return typeof value === 'string' && (DEV_TASK_PUSH_STATES as readonly string[]).includes(value)
}
