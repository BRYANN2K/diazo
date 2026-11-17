# Orca integration: dev tasks

**Status: contract** — the backend described here is what the Orca launch
flow is built against. Design and reasoning: `.workflow/changes/orca-integration/`.

A frame signed off **ready for dev** can be sent to Orca in one click: the
Diazo desktop app creates an Orca worktree and starts a coding agent in it,
on this Mac or on a paired environment (`--environment vps`). The frame then
shows the task's live state until the PR.

The split of trust:

- **Diazo server** keeps `frame_dev_tasks` rows, builds the brief stored on
  the task and broadcasts `dev-task` to the room. It never learns a worktree path.
- **Desktop shell** (`desktop/src-tauri/src/orca.rs`) is the only place that
  runs `orca` — typed commands behind `window.__DIAZO_ORCA__` /
  `__DOOP_ORCA__`, argv vectors never shell strings, a native confirmation
  before every launch.
- **The coding agent** gets its brief over the Diazo MCP only
  (`get_handoff`) and reports with `update_dev_task`. Nothing is written
  into the worktree by Diazo.

## The flow

1. `POST /api/frames/:id/dev-tasks` builds the brief
   (`buildDevTaskBrief` in `server/devTasks.ts`: the frame's PNG export,
   the canvas's design tokens and its code links), creates a `queued` row
   and hands a `dev_task` job to the requester's desktop over the
   `/api/local-repo/poll` bridge — only a device holding the canvas's repo
   link grant may claim it.
2. The shell resolves the grant folder to an Orca repo (`orca repo list`),
   shows a native confirmation, runs `orca worktree create … --agent …
--prompt … --json`, then posts the outcome to
   `POST /api/dev-tasks/:id/report`.
3. While the task lives, the shell polls `orca worktree ps --json` every
   ~10 s (one call per environment), trims each watched row to the fields
   below, and posts deltas. The coding agent also pushes updates itself
   over MCP (`update_dev_task`). Both merge last-writer-by-time, the
   agent's push winning for `pr_open` and `done`.
4. Every change broadcasts `{ type: 'dev-task', task }` to the canvas room.

## REST

| Route                             | Role                 | Body → answer                                               |
| --------------------------------- | -------------------- | ----------------------------------------------------------- |
| `POST /api/frames/:id/dev-tasks`  | edit                 | `{ agent, model?, effort?, environment? }` → `{ task }`     |
| `GET /api/canvases/:id/dev-tasks` | view                 | → `{ tasks: DevTask[] }` (newest first)                     |
| `POST /api/dev-tasks/:id/report`  | the launching device | `{ deviceId, requestId?, launch?, poll? }` → `{ ok, task }` |
| `POST /api/dev-tasks/:id/cancel`  | edit                 | → `{ task }`                                                |

- `POST …/dev-tasks` requires the frame's `approval.status` to be
  `ready_for_dev` and the caller to hold a repo link on the canvas whose
  device is online — else `409`. `environment` is an Orca environment name
  (`vps`); absent launches on this Mac. Answers `503` when the frame's html
  is not loaded, and is rate limited (5 launches per user per minute,
  `429`) — every call builds a brief before the device's confirm gates it.
  `model`/`effort` are charset-checked here already
  (`[a-z0-9._:-]+`, no leading `-`), and `effort` needs `model`.
- `report` accepts only the requester's session; the first report binds the
  row's `deviceId`. `requestId` settles the claimed bridge request — and
  must name that task's own `dev_task` job, not another launch's pending
  one. A `launch` with `cancelled` marks the task `cancelled`; `ok:false`
  marks it `failed`; an `ok` answer stores the Orca identity and only ever
  moves `queued` to `starting` — a late or replayed report cannot drag a
  `working`/`pr_open` row back, and launch reports on a terminal row
  (`done`, `failed`, `cancelled`) are ignored outright.
- `poll` carries a trimmed `worktree ps` row: `{ found, status?, agentState?,
outcome?, lastAssistantMessage?, linkedPR?, orcaSessionId?, branch?,
workspaceStatus?, devUrl? }`. `found:false` maps to `cancelled` — and is
  only ever sent on a full page: a `truncated` `ps` answer reports nothing
  for a missing identity rather than risk a false cancel. A `linkedPR`
  maps to `pr_open`; `outcome` `failure`/`interruption` to `failed`,
  `cancellation` to `cancelled`, `success` to `done` — the main agent's
  `mainAgent.outcome` is the only pull-side value that may end a task (its
  `programStatus.state` only ever reads `working`/`done`, and an agent's
  per-turn `agentState: done` is a finished turn, not a finished
  task). `devUrl` is the dev server `orca ports` reported for the worktree —
  http(s) only, stored on the task for a live frame or the drift review to
  use. `linkedPR` follows the same http(s)-only rule.
- `cancel` marks the row `cancelled` and withdraws the task's unclaimed
  `dev_task` job, so a stopped launch is never handed to the desktop. A
  job already claimed still answers through `report`, which keeps the row
  cancelled.

## The `dev_task` bridge op

`POST /api/frames/:id/dev-tasks` queues the launch as a `RepoRequest` with
`op: 'dev_task'` and `args.devTask`:

```json
{
  "taskId": "dt_…",
  "worktreeName": "doop-checkout-mobile-a3f",
  "branch": "doop/checkout-mobile-a3f",
  "agent": "claude",
  "model": "opus",
  "effort": "high",
  "prompt": "You are implementing a design signed off in Diazo. …",
  "comment": "doop: https://diazo.example/c/<canvas>?frame=<frame> · task <taskId>",
  "environment": "vps"
}
```

The device claims it like any repo request (it must hold the link's grant),
runs `orca_launch_task` natively, and answers through the report route —
not `/api/local-repo/finish` (the report's `requestId` settles the bridge
entry). An unclaimed job expires at `DEV_TASK_LAUNCH_TTL_MS` (10 min) and
the task is marked `failed`. Bridge requests live in the server's memory:
a restart orphans every still-queued job, so `queued` rows older than the
TTL are swept to `failed` at boot and once a minute.

## MCP tools (the coding agent's side)

| Tool              | Input                                                               | Returns                                                                                                |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `get_handoff`     | `{ task_id }`                                                       | the stored brief: task meta + title/plan/tokens/code links as JSON, each frame's PNG as an image block |
| `update_dev_task` | `{ task_id, state?, pr_url?, summary?, orca_session_id?, branch? }` | the updated task                                                                                       |

`update_dev_task` requires the caller to be the task's requester (the agent
runs with their Diazo MCP credentials) and to still have access to the
task's canvas. `state` may only be `needs_input`,
`pr_open`, `done` or `failed`; a `done`/`failed` sets `finishedAt`.

`get_canvas` also lists `dev_tasks` for its canvas.

## Desktop commands (`orca.rs`)

Advertised as `window.__DIAZO_ORCA__` (and `__DOOP_ORCA__` for older
clients). All take typed fields, build an argv vector, always pass `--json`.
No passthrough exists.

The binary resolves in order: `DOOP_ORCA_CLI` (test override),
`ORCA_CLI_COMMAND` — what Orca itself exports into managed sessions —
then the install locations and `PATH`. Dynamic values ride as single argv
elements (`--name=<value>`), so a value can never parse as its own option;
`name`, `prompt` and `comment` additionally reject a leading `-` and
control characters, and `--environment` values must come from
`orca host list`. The launch keeps `operationId` for `--retry-launch`.

| Command             | Runs                                                                         | Confirmation |
| ------------------- | ---------------------------------------------------------------------------- | ------------ |
| `orca_status`       | `orca status`, `orca host list`, `orca account list`                         | none         |
| `orca_resolve_repo` | `orca repo list` matched to a repo-link grant (path, else git remote key)    | none         |
| `orca_launch_task`  | `orca worktree create --name=… --repo=id:… --agent=… --prompt=… --comment=…` | native       |
| `orca_poll`         | `orca worktree ps --limit=100`, filtered to identities this shell launched   | none         |
| `orca_ports`        | `orca ports --worktree identity:<key>`, trimmed to `{ port, url, process }`  | none         |
| `orca_activate`     | `orca worktree activate --worktree identity:<key>`                           | none         |
| `orca_untrack`      | drops the task's identity once the server saw a terminal state               | none         |

The shell persists the identities it launched in `orca-tasks.json` (app
data dir): `{ taskId, environment, server, orcaIdentity, … }`, serialized
through a mutex so concurrent callers cannot corrupt the file. `server` is
the active Diazo origin — a shell signed into two instances never polls
the other's worktrees. Selectors outside the current server/environment
set are refused. A worktree gone from `ps` or terminal is kept `ended` for
a grace window (the last report still ships) then pruned; `orca_untrack`
removes it earlier, once the room already knows the end state.

The native confirmation names the worktree, the agent and the launch
comment, which Orca persists as task metadata.

## Dev task states

`queued` → `starting` → `working` → (`needs_input` | `pr_open` | `done` |
`failed` | `cancelled`). Mapped from Orca per the table above; terminal
states are `done`, `failed`, `cancelled`. At most 20 rows are kept per
frame.
