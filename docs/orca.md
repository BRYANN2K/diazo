# Orca integration: dev tasks

**Status: contract** — the backend described here is what the Orca launch
flow is built against. Design and reasoning: `.workflow/changes/orca-integration/`.

A frame signed off **ready for dev** can be sent to Orca in one click: the
Diazo desktop app creates an Orca worktree and starts a coding agent in it,
on this Mac or on a paired environment (`--environment vps`). The frame then
shows the task's live state until the PR.

The split of trust:

- **Diazo server** keeps `frame_dev_tasks` rows, builds the handoff pack and
  broadcasts `dev-task` to the room. It never learns a worktree path.
- **Desktop shell** (`desktop/src-tauri/src/orca.rs`) is the only place that
  runs `orca` — typed commands behind `window.__DIAZO_ORCA__` /
  `__DOOP_ORCA__`, argv vectors never shell strings, a native confirmation
  before every launch.
- **The coding agent** gets its brief over the Diazo MCP only
  (`get_handoff`) and reports with `update_dev_task`. Nothing is written
  into the worktree by Diazo.

## The flow

1. `POST /api/frames/:id/dev-tasks` builds the handoff pack (same
   `server/handoff.ts` as the Stip export), creates a `queued` row and
   hands a `dev_task` job to the requester's desktop over the
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
  (`vps`); absent launches on this Mac. Answers `503` when the pack cannot
  build.
- `report` accepts only the requester's session; the first report binds the
  row's `deviceId`. `requestId` settles the claimed bridge request. A
  `launch` with `cancelled` marks the task `cancelled`; `ok:false` marks it
  `failed`; otherwise it stores the Orca identity and moves to `starting`.
- `poll` carries a trimmed `worktree ps` row: `{ found, status?, agentState?,
outcome?, lastAssistantMessage?, linkedPR?, orcaSessionId?, branch?,
workspaceStatus?, devUrl? }`. `found:false` maps to `cancelled`; a `linkedPR`
  maps to `pr_open`; `outcome` `failure`/`interruption` to `failed`,
  `cancellation` to `cancelled`, `success` to `done`. `devUrl` is the dev
  server `orca ports` reported for the worktree — http(s) only, stored on the
  task for a live frame or the drift review to use.

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
the task is marked `failed`.

## MCP tools (the coding agent's side)

| Tool              | Input                                                               | Returns                                                                                        |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `get_handoff`     | `{ task_id }`                                                       | the stored pack: task meta + `pack.files` — text files as text, `assets/*.png` as image blocks |
| `update_dev_task` | `{ task_id, state?, pr_url?, summary?, orca_session_id?, branch? }` | the updated task                                                                               |

`update_dev_task` requires the caller to be the task's requester (the agent
runs with their Diazo MCP credentials). `state` may only be `needs_input`,
`pr_open`, `done` or `failed`; a `done`/`failed` sets `finishedAt`.

`get_canvas` also lists `dev_tasks` for its canvas.

## Desktop commands (`orca.rs`)

Advertised as `window.__DIAZO_ORCA__` (and `__DOOP_ORCA__` for older
clients). All take typed fields, build an argv vector, always pass `--json`.
No passthrough exists.

| Command             | Runs                                                                             | Confirmation |
| ------------------- | -------------------------------------------------------------------------------- | ------------ |
| `orca_status`       | `orca status`, `orca host list`, `orca account list`                             | none         |
| `orca_resolve_repo` | `orca repo list` matched to a repo-link grant (path, else git remote key)        | none         |
| `orca_launch_task`  | `orca worktree create --name … --repo id:… --branch doop/… --agent … --prompt …` | native       |
| `orca_poll`         | `orca worktree ps --limit 100`, filtered to identities this shell launched       | none         |
| `orca_ports`        | `orca ports --worktree identity:<key>`, trimmed to `{ port, url, process }`      | none         |
| `orca_activate`     | `orca worktree activate --worktree identity:<key>`                               | none         |

The shell persists the identities it launched in `orca-tasks.json` (app data
dir); selectors outside that set are refused. `--environment` values must
come from `orca host list`. The launch keeps `operationId` for
`--retry-launch`.

## Dev task states

`queued` → `starting` → `working` → (`needs_input` | `pr_open` | `done` |
`failed` | `cancelled`). Mapped from Orca per the table above; terminal
states are `done`, `failed`, `cancelled`. At most 20 rows are kept per
frame.
