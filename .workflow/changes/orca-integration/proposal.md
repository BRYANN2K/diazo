# Orca integration (design → code through Orca worktrees)

Status: **proposal**, not built. Written against Orca 1.4.259 (`orca status --json` →
`runtime.appVersion`), CLI schema v1 (`orca agent-context --json`: 334 commands). Every Orca
command quoted below was read from that schema or run read-only on 2026-11-15; nothing in Orca was
created or changed while writing this.

## 1. Why

### The loop today

doop already carries a frame most of the way to code, but stops at the repo's doorstep:

1. A person marks a frame **ready for dev** (`frame-approval.md`, `PUT /api/frames/:id/approval`).
2. The server drafts a **Stip change pack** (`server/handoff.ts`: `proposal.md`, `spec.md` with
   `- AC-n:` criteria, `tasks.md`, `evidence.md`, `state.json`, `tokens.json`, `assets/*.png`,
   `code-links.json`).
3. The desktop shell writes it into the linked folder with its one write command
   `repo_write_change` (`desktop/src-tauri/src/repo.rs`): new files only, under
   `.workflow/changes/<change-id>/`, after a native confirmation.
4. **Then a human** opens a terminal, makes a branch or worktree, starts Claude Code or Codex,
   points it at the pack, waits, opens the dev server, and comes back to doop for a **drift review**
   (`compare_with_url`, `server/drift.ts`) or waits for the **Built page** webhook
   (`server/built.ts`) after a preview deploy.

Step 4 is where the loop leaks. doop knows nothing about the coding agent: not that it started, not
its branch, not its PR, not when it finished. The frame shows "ready for dev" forever.

### Where Orca fits

Orca is the app Bryan already uses for step 4. It owns exactly the pieces doop lacks:

| Need                      | Orca surface (quoted from the CLI)                                                      |
| ------------------------- | --------------------------------------------------------------------------------------- |
| An isolated checkout      | `orca worktree create --name <name> --repo <selector> --base-branch <ref>`              |
| A coding agent in it      | same call with `--agent <id> --prompt <text> --model <id> --effort <level>`             |
| Live agent state          | `orca worktree ps --json` → `agents[].state`, `mainAgent.state`, `lastAssistantMessage` |
| PR / issue links          | `linkedPR`, `linkedIssue`, `linkedLinearIssue` on each worktree row                     |
| A note on the worktree    | `orca worktree set --worktree <sel> --comment <text>` (one free-text field)             |
| A board column            | `orca worktree set --workspace-status <id>` (todo, in-progress, in-review, completed)   |
| The worktree's dev server | `orca ports --worktree <sel> --json` → `ports[].url` (what the server printed)          |
| A browser on that server  | `orca tab create --url <url> --worktree <sel>`, `orca screenshot --worktree <sel>`      |
| Another agent later       | `orca agent launch --agent <id> --worktree <sel> --prompt <text>`                       |
| Session search            | `orca search "<query>" --json [--since <iso>] [--agent <id>]`                           |
| Scheduled agent work      | `orca automations create --trigger <preset/cron/rrule> --prompt … --precheck <cmd>`     |
| Other machines            | `orca host list`, `--environment <name>` (paired `orca serve`), `--host ssh:<id>`       |

So the split is clean: **doop owns the design, the sign-off and the verdict; Orca owns the
checkout, the agent and the terminal.** The integration is the wire between "ready for dev" and
"drift review", plus a status light on the frame.

## 2. What we verified (and what surprised us)

- `orca worktree ps --json` is rich enough to be the status source without parsing terminals: each
  row has `worktreeId`, `identity.key` (`wt2:<host>:<instance>`), `branch`, `path`, `hostId`,
  `workspaceStatus`, `comment`, `linkedPR`, `lastActivityAt`, `status` (`working`…), and
  `agents[]` with `agentType`, `orcaSessionId`, `state`, `mainAgent.state`,
  `lastAssistantMessage`, `prompt`. One call covers every host Orca reaches (its `scope:` line says
  which were not covered).
- **`--reference` refuses doop URLs.** `orca reference find "https://…/c/abc?frame=f1"` answers
  `invalid_argument: Unsupported reference URL. Use a PR, MR or issue URL with an identifiable
provider route.` So the canvas link cannot ride Orca's reference system; it goes in `--comment`,
  and the mapping lives in doop.
- **Orca plugins cannot call doop.** The plugin guide (`orca skills get orca-plugin-authoring`)
  lists the events we want (`agent.status.changed` with `state: working|blocked|waiting|done` and
  `mainAgent.outcome: success|failure|cancellation|…`; `workspace.created`/`removed`), but also
  "No network: requests outside the plugin's files fail." A plugin is not a webhook sender. (A
  worker could shell out through `terminal.create`; we will not build on that.)
- **Orca automations have no external trigger.** Triggers are `hourly|daily|weekdays|weekly`, cron
  or RRULE. The two ways in are `orca automations run <id>` (manual, skips the precheck) and
  `--precheck <command>` (exit 0 runs the scheduled turn). doop events can drive either.
- **Agent launch is asynchronous and idempotent on retry**: a lost reply is retried with
  `--retry-launch <operationId>`, "never retry as a fresh launch". The shell must keep that id.
- **Agents start as chat or terminal** per the user's Orca setting; `--surface terminal` forces the
  CLI. Status from `worktree ps` works for both, terminal-only verbs do not.
- `orca status --json` → `caller.orcaSessionId` tells an agent running inside Orca its own session
  id, so the agent can report it to doop itself.
- Agents available on this machine (`orca account list`): Claude and Codex accounts, OpenCode
  system default. Devin is launchable (`account add --agent devin`) but has no account yet.
- Multi-machine is real here: `orca host list` shows this Mac, four SSH targets and one paired Orca
  server (`--environment vps`).

## 3. User flows

### F1 — Ready for dev → Orca worktree + agent (the MVP)

```
Frame "Checkout / mobile"  [Ready for dev ✓]
Inspector ▸ Development
┌──────────────────────────────────────────────┐
│ Handoff  stip change  checkout-mobile-a3f    │
│ Repo     redoop (linked)                     │
│ Build with  [Claude Code ▾] [opus ▾] [high ▾]│
│ On       [This Mac ▾]                        │
│          ( Send to Orca )                    │
└──────────────────────────────────────────────┘
```

1. The person clicks **Send to Orca**. The page builds the handoff pack as today (server), then
   asks the desktop shell to run the job.
2. The shell (Rust, §5) resolves the canvas's linked folder to an Orca repo locally (match the grant
   path against `orca repo list --json` → `repos[].path`; the path never leaves the Mac), then shows
   a **native confirmation**: "Create worktree `doop/checkout-mobile-a3f` in redoop and start Claude
   Code (opus, high) with this brief?" with the prompt text visible.
3. On OK it runs, as an argument vector (never a shell string):

   ```
   orca worktree create --name doop-checkout-mobile-a3f --repo id:<repoId> \
     --branch doop/checkout-mobile-a3f --agent claude --model opus --effort high \
     --setup inherit --no-parent \
     --comment "doop: https://<doop>/c/<canvasId>?frame=<frameId> · task <taskId>" \
     --prompt "<short brief, §6.3>" --json
   ```

4. It reads `result.worktree` (id, identity, path, branch) and `result.launch.outcome`
   (`kind`, `handle`), and reports them to doop. The frame gets a `dev task` row.
5. If the pack must exist as files in the worktree (Stip agents read `.workflow/changes/`), the
   shell writes it **into the new worktree** with a variant of `repo_write_change` whose root is the
   worktree path just returned, checked to share the granted repo's `git rev-parse
--git-common-dir`. Otherwise the agent fetches the pack over the doop MCP (`get_handoff`), which
   needs no file crossing at all (recommended default, §6.3).

### F2 — Live status on the frame

```
Frame title bar:   Checkout / mobile   ● Claude · working 4m   ⎇ doop/checkout-mobile-a3f
Inspector ▸ Development ▸ Build
┌──────────────────────────────────────────────┐
│ ● Working   Claude Code · opus · This Mac    │
│ "Wiring the payment sheet to the tokens…"    │
│ ⎇ doop/checkout-mobile-a3f   PR —            │
│ [Open in Orca] [Preview] [Stop…]             │
└──────────────────────────────────────────────┘
```

States shown, mapped from Orca:

| doop `state`  | from                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `queued`      | job accepted by doop, shell not yet answered                              |
| `starting`    | `worktree create` returned, `launch.outcome` pending / setup running      |
| `working`     | `mainAgent.state = working`                                               |
| `needs_input` | `blocked` or `waiting` (the agent asked something; "Open in Orca")        |
| `pr_open`     | `linkedPR` set, or the agent reported a PR URL through MCP                |
| `done`        | `mainAgent.state = done` with `outcome = success`                         |
| `failed`      | `outcome` is `failure` or `interruption`, worktree gone, or launch failed |
| `cancelled`   | `outcome = cancellation`, or the person stopped it from doop              |

Two sources, merged (last writer by timestamp):

- **Pull, from the shell**: while the desktop app runs, it polls
  `orca worktree ps --json --limit 100` every 10 s (one call for all tasks), filters to the
  identities it launched, and posts the delta. Cheap, catches PRs and the board column.
- **Push, from the agent**: the prompt tells the agent to call the doop MCP `update_dev_task`
  (§7) when it opens a PR and when it finishes, with a one-line summary. This works with the Mac
  asleep, from another host, and from agents doop did not launch.

"Open in Orca" runs `orca worktree activate --worktree identity:<key>` (reveals it in the app).

### F3 — Preview the worktree's dev server back into doop

When the agent prints a dev server URL, `orca ports --worktree identity:<key> --json` returns it
(`ports[].url`, `owner.confidence = cwd`). The Build card then offers **Preview**:

- **Same Mac**: create a doop **live frame** (`create_live_frame`, loopback only) beside the design
  frame, sized like it, URL from `orca ports`. Optionally also `orca tab create --url <url>
--worktree identity:<key>` so the Orca browser shows the same page next to the agent.
- **Other host** (worktree on `--environment vps` or `--host ssh:…`): the dev server is that
  machine's localhost, which neither the doop desktop nor the doop server can fetch. Use Orca's
  browser as the camera: `orca tab create --url <url> --worktree <sel> --environment vps`, then
  `orca screenshot --format png --worktree <sel> --environment vps` (or `full-screenshot`), and post
  the PNG as the "built" side of a drift comparison. A screenshot, not a live frame.

```
┌ Design: Checkout / mobile ┐  ┌ LIVE  localhost:5173 (doop/checkout-mobile-a3f) ┐
│                            │  │                                                 │
│        (frame)             │  │         (live frame, desktop snapshot)          │
└────────────────────────────┘  └───────────────── drift 94% · 3 cards ───────────┘
```

### F4 — Drift review when the agent finishes

On the transition to `done` (or `pr_open`), doop runs the existing drift review against the
preview from F3 (`compare_with_url` with the loopback URL, or the Orca screenshot for remote
hosts). The result lands as drift cards on the frame and as a short summary in the Build card. If
the score is under the canvas threshold, the card offers **Send fixes to the agent**: the drift
cards become a follow-up prompt through `orca agent launch --agent <same> --worktree
identity:<key> --prompt "<drift cards>"` (a new agent turn in the same worktree; a live terminal
agent could also get `orca terminal send --terminal <handle> --text … --enter`, but `agent launch`
works for chat and terminal alike). When a preview deploy later reports to the Built page, its
capture supersedes the local one.

### F5 — Duel: N worktrees, N agents

The model duel already exists for design (`server/duels.ts`). The code duel mirrors it:

```
Send to Orca ▸ Duel
┌ Claude Code · opus · high ┐ ┌ Codex · gpt-6 · high ┐ ┌ OpenCode · … ┐
│ ⎇ doop/checkout-…-claude  │ │ ⎇ doop/checkout-…-codex│ │ ⎇ …-opencode │
│ ● done 12m · drift 96%    │ │ ● done 18m · drift 91% │ │ ✕ failed     │
│ [Keep] [Open in Orca]     │ │ [Keep] [Open in Orca]  │ │ [Retry]      │
└───────────────────────────┘ └────────────────────────┘ └──────────────┘
```

- One native confirmation lists all N launches; then N × `orca worktree create … --agent <id>`
  with distinct `--branch` names, sharing the same pack and prompt.
- Each contestant gets its drift score (F4), time, and the agent's own summary. **Keep** records a
  canvas decision (as the design duel does) and moves the winner's board column with
  `orca worktree set --workspace-status in-review`.
- The losers are **not** removed by doop. "Clean up the others…" opens one more native
  confirmation and runs `orca worktree rm --worktree identity:<key>` (no `--force`, no
  `--delete-branch`; Orca keeps the branch by default). Recommendation: leave cleanup to Orca's own
  rules (`orca workspace cleanup preview`) in the MVP.

### F6 — The canvas link inside Orca

Every doop-launched worktree carries `--comment "doop: <frame link> · task <taskId>"`, which
Orca shows on the worktree and returns in `worktree ps` (`comment`). An agent in any worktree can
also read it back (`orca worktree current --json` → `orca worktree show`) and call the doop MCP
with the frame id. On state changes the shell may refresh the comment with a short status
("doop: … · drift 94%"); it never overwrites a comment it did not write (it checks the `doop:`
prefix first).

### F7 — Orca automations driven by doop events

Orca cannot be called by doop, so doop drives automations from the Mac:

- **Run on event** (desktop): an automation step in doop's own automations
  (`server/automations.ts`, approval triggers) gains an action "Run Orca automation <uuid>". The
  server queues it for the person's device; the shell runs `orca automations run <uuid>` after a
  one-time native approval per automation id (remembered like repo grants).
- **Pull with a precheck** (no desktop needed at event time): the person creates an Orca automation
  whose precheck asks doop whether there is work, e.g.
  `orca automations create --name "doop ready-for-dev" --trigger hourly --provider claude
--repo id:<repoId> --precheck "bun run doop dev-tasks --pending --canvas <id> --exit-code"
--prompt "Take the next doop dev task: call list_dev_tasks …"`. `doop dev-tasks` is a new
  subcommand of the existing `doop` CLI (`cli/`, agent key auth) that exits 0 when a task is
  pending. doop only ever has to answer an HTTP read; Orca does
  the rest. This is the cleanest event bridge we found.

### F8 — Search agent sessions from doop

The Build card's "Sessions" disclosure runs, through the shell,
`orca search "<frame name> OR <taskId>" --json --limit 10 --since <task created>` and lists hits
(agent, date, title, snippet). "Resume" is offered only for local hosts, where Orca prints a resume
command; doop does not run it, it opens Orca (`orca worktree activate`) or copies the command.
Results are shown to the person who asked, never stored on the server (they are transcripts of
someone's terminal).

### Out of scope (seen, deliberately not used)

- `orca computer …` (native GUI control) and `orca pair --grant-desktop-control`: far more power
  than this needs; never invoked by doop.
- `orca terminal send` with arbitrary text from the page: only the fixed drift follow-up (F4) uses
  an agent prompt, and through `agent launch`.
- `orca emulator …`: a later idea for drift review of the iOS app, not part of this spec.
- `orca orchestration …` (Runs, gates, dispatch): Orca's own coordinator model. doop's dev task is
  simpler; revisit if Bryan wants doop to be the coordinator of a DAG.

## 4. Where each piece runs

| Piece                                    | Runs on              | Why                                                       |
| ---------------------------------------- | -------------------- | --------------------------------------------------------- |
| Pack build, task rows, status, MCP tools | doop server          | shared state, visible to everyone on the canvas           |
| Every `orca …` invocation                | desktop shell (Rust) | the CLI talks to the local Orca runtime; paths stay local |
| Repo ↔ Orca repo resolution              | desktop shell        | needs the granted absolute path                           |
| Status pull (`worktree ps`)              | desktop shell        | same                                                      |
| Status push (`update_dev_task`)          | the coding agent     | via the doop MCP it already has (`doop mcp install`)      |
| Precheck bridge (F7)                     | Orca → `doop` CLI    | HTTP read with an agent key                               |
| Preview of remote worktrees              | Orca browser         | only Orca reaches the remote host's localhost             |

A plain browser tab sees the dev tasks and their status but cannot launch: the button says "Open
the desktop app to send this to Orca", exactly as repo linking does today.

## 5. Desktop shell surface (Tauri)

New module `desktop/src-tauri/src/orca.rs`, advertised to the page as `__DOOP_ORCA__`. It follows
`repo.rs` and `claude.rs`: typed commands, no generic exec.

| Command               | Runs (argv, `--json` always)                                                 | Confirmation                            |
| --------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `orca_status`         | `orca status`, `orca host list`, `orca account list`                         | none (read)                             |
| `orca_resolve_repo`   | `orca repo list` matched to a grant id → `{ repoId, displayName }`           | none (read)                             |
| `orca_launch_task`    | `orca worktree create …` (§3 F1), returns worktree + launch                  | native, shows every flag and the prompt |
| `orca_poll`           | `orca worktree ps --limit 100`, filtered to identities it launched           | none (read)                             |
| `orca_ports`          | `orca ports --worktree identity:<key>`                                       | none (read)                             |
| `orca_preview`        | `orca tab create --url <url> --worktree …`, `orca screenshot …`              | none (URL must come from `orca_ports`)  |
| `orca_follow_up`      | `orca agent launch --agent <id> --worktree identity:<key> --prompt …`        | native                                  |
| `orca_activate`       | `orca worktree activate --worktree identity:<key>`                           | none                                    |
| `orca_set_comment`    | `orca worktree set --worktree … --comment "doop: …"` (only `doop:`-prefixed) | none                                    |
| `orca_remove`         | `orca worktree rm --worktree identity:<key>` (never `--force`)               | native                                  |
| `orca_search`         | `orca search <query> --limit ≤20 [--since] [--agent]`                        | none (read)                             |
| `orca_run_automation` | `orca automations run <uuid>`                                                | native once per uuid                    |

Rules the module enforces natively (the page is untrusted):

- **No shell, no free argv.** Each command builds its own argument vector from typed fields;
  `std::process::Command` with `.args()`, never `sh -c`. The binary is `orca` found the way
  `claude.rs` finds `claude` (login shell `command -v`, or a path picked in Settings), checked to
  be the CLI shipped in `/Applications/Orca.app` or a user-picked file.
- **Allowlisted values**: `--agent` ∈ the ids `orca account list` / the schema enumerate
  (`claude`, `codex`, `opencode`, `devin`, `cursor`…); `--model` and `--effort` shape-checked like
  `valid_model` in `claude.rs`; `--name`/`--branch` match `^[a-z0-9][a-z0-9/-]{0,80}$`; the repo is
  a grant id resolved locally, never a page-supplied path; worktree selectors are only
  `identity:<key>` values this shell created (kept in the app data dir, `orca-tasks.json`).
- **Prompt text** is capped (8 KB), shown in full in the confirmation, and is the only free text
  that reaches Orca. It is passed as one argv element, so it cannot become flags.
- **URLs** for previews must be loopback and must have come from `orca_ports` for that worktree.
- `--environment` / `--host` values must be ones `orca host list` printed; the confirmation names
  the machine.
- Launch keeps the `operationId` from a failed reply and retries only with `--retry-launch`.

## 6. Server side

### 6.1 Data model

New table `frame_dev_tasks` (migration `00xx_frame_dev_tasks`):

| column                                    | type        | notes                                                                                    |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `id`                                      | text pk     | server-minted                                                                            |
| `canvas_id`                               | text fk     | cascade                                                                                  |
| `frame_ids`                               | jsonb       | one frame, or a pack's frames                                                            |
| `handoff_change_id`                       | text        | the Stip change id the pack used                                                         |
| `frame_revision`                          | text        | `approvedFrameUpdatedAt` at launch, to flag a stale build                                |
| `duel_id`                                 | text null   | groups F5 contestants                                                                    |
| `requested_by`                            | text fk     | user                                                                                     |
| `device_id`                               | text        | the shell that launched it (as `repo_links.device_id`)                                   |
| `runner`                                  | text        | `orca` (room for others later)                                                           |
| `agent`                                   | text        | `claude`, `codex`, …                                                                     |
| `model`, `effort`                         | text null   |                                                                                          |
| `host_label`                              | text        | "This Mac", "vps" — a label, never a path                                                |
| `orca_identity`                           | text null   | `wt2:<host>:<instance>`; opaque                                                          |
| `orca_session_id`                         | text null   | from `agents[].orcaSessionId` or the agent's own report                                  |
| `branch`                                  | text null   |                                                                                          |
| `pr_url`                                  | text null   | from `linkedPR` or `update_dev_task`                                                     |
| `state`                                   | text        | §3 F2 enum                                                                               |
| `summary`                                 | text null   | last agent line, capped 500 chars                                                        |
| `drift`                                   | jsonb null  | `{ score, cards, comparedAt, source }`, source one of `live`, `orca-screenshot`, `built` |
| `created_at`, `updated_at`, `finished_at` | timestamptz |                                                                                          |

The worktree's absolute path is **not** stored (same rule as repo links). Retention: keep the
last 20 tasks per frame.

### 6.2 API

- `POST /api/frames/:id/dev-tasks` (edit role) — `{ agent, model?, effort?, host?, duel? }`.
  Builds or reuses the handoff pack, creates `queued` rows, queues a device job (the same
  request/poll seam as `server/localRepo.ts`), answers the rows.
- `GET /api/canvases/:id/dev-tasks` (view role) — rows for the canvas; also in `get_canvas`.
- `POST /api/dev-tasks/:id/report` (device only: the launching device id + session) — the shell's
  launch result and poll deltas.
- `POST /api/dev-tasks/:id/cancel` (edit role) — marks the task `cancelled` and queues nothing
  destructive: the card offers "Stop in Orca" (`orca_activate`), and removal stays `orca_remove`
  behind its native confirmation.
- Room broadcast `dev-task` on every change, so the frame badge updates live for everyone.
- Outbound webhooks (`outbound-webhooks.md`) gain `dev_task.updated`.

### 6.3 The prompt and the pack

The `--prompt` stays short so the confirmation is readable and nothing large crosses argv:

```
You are implementing a design signed off in doop.
Canvas <canvasId>, frame <frameId>, dev task <taskId>, Stip change <changeId>.
1. Call the doop MCP tool get_handoff({ task_id: "<taskId>" }) and follow spec.md's AC list.
2. Read get_frame and get_tokens for exact values; respect code-links.json.
3. Report with update_dev_task when you open a PR and when you finish (one-line summary).
If the doop MCP is not connected, say so and stop.
```

Recommended default: the pack is fetched over MCP, so no files cross into the worktree and the
existing `repo_write_change` stays the only write. Option for Stip users: write the pack into the
new worktree (§3 F1 step 5) so `stip` commands see it.

## 7. MCP tools (for the coding agent and for design agents)

| Tool               | Who calls it            | Does                                                                                                                                                                    |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_handoff`      | coding agent            | the pack for a task (files as text, PNGs as image content)                                                                                                              |
| `list_dev_tasks`   | coding / resident agent | tasks for a canvas or frame, filter by state                                                                                                                            |
| `update_dev_task`  | coding agent            | `{ task_id, state?, pr_url?, summary?, orca_session_id?, branch? }`, state one of `pr_open`, `done`, `failed`, `needs_input`; only the task's own transitions, rationed |
| `request_dev_task` | resident / MCP agent    | proposes a launch; it shows as a pending card the **human** confirms (agents never launch Orca on their own)                                                            |

`update_dev_task` is authorized by the agent key / OAuth of the person who requested the task (the
agent runs in their Orca with their doop MCP). A report on a task of a canvas the caller cannot
edit is refused.

## 8. Auth and trust

- **doop → Orca**: no credential at all. The shell runs the local CLI as the logged-in user, and
  Orca's own runtime decides what that user may do. Remote hosts are reached only through pairings
  the user already made in Orca (`orca environment list`); doop never stores a pairing code.
- **Orca → doop**: only through the coding agent's doop MCP (agent key or OAuth from
  `doop mcp install`) and the `doop` CLI in a precheck. Both are the user's own credentials.
- **Who may launch**: editors of the canvas, from their own desktop app, on their own Orca. A
  co-editor watching the canvas sees the status but cannot make another person's Mac run anything:
  device jobs are bound to the requester's device id, like repo reads.
- **Prompt injection**: frame text, comments and pack contents are design data the agent reads; the
  prompt marks them as data, and the agent runs with its normal Orca permissions, nothing more. The
  native confirmation shows exactly what will be launched.

## 9. Failure modes

| Failure                        | Behaviour                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Desktop app closed             | job stays `queued` 10 min then `failed: open the desktop app` (requests expire, as repo reads do)                        |
| Orca not running               | `orca status` says so; offer `orca open`, never auto-launch the app                                                      |
| Linked folder not an Orca repo | card says "Add redoop to Orca" (doop does not run `orca repo add`)                                                       |
| `worktree create` reply lost   | retry once with `--retry-launch <operationId>`; else `failed` with the id                                                |
| Setup hooks slow / failing     | state `starting` until `mainAgent` appears; Orca's receipt shown                                                         |
| Agent asks a question          | `needs_input`; "Open in Orca" (doop does not answer for the human)                                                       |
| Worktree removed in Orca       | poll stops seeing the identity → `cancelled`, kept in history                                                            |
| Frame edited after launch      | approval flips to `needs_review`; the task shows "built from an older revision"                                          |
| Agent without doop MCP         | only the pull status works; the card says "no reports from the agent"                                                    |
| Remote host unreachable        | `worktree ps` scope line lists it as not covered → status "unknown", not failed                                          |
| Orca CLI schema changes        | the shell checks `orca agent-context --json` `schemaVersion` and the flags it needs at startup; missing → feature hidden |

## 10. Multi-machine

Three topologies, in order of support:

1. **Everything on this Mac** (MVP): doop desktop + Orca + worktrees local.
2. **Orca drives a remote host** (phase 2): the worktree lives on `--environment vps` or
   `--host ssh:<id>`; the shell on the Mac still runs the CLI with that flag. Status and search work
   (they are host-aware); live previews do not (localhost is remote), so F3 uses Orca's browser
   screenshot. The pack must come over MCP.
3. **doop server talks to an Orca server directly** (not proposed): the k3s doop could reach an
   `orca serve` on the tailnet, but that needs a pairing code stored server-side, which is a remote
   control credential for a whole machine. Rejected unless Bryan wants headless, Mac-off launches;
   then it deserves its own spec (a dedicated, scoped `orca serve` with no desktop control).

## 11. Phased plan

**Phase 0 — spike (1 day, outside the main code).** A throwaway script that runs the exact F1
`worktree create` on a scratch repo, then `worktree ps --json` until `done`, then `worktree rm`.
Proves: the `--prompt` reaches a chat and a terminal agent, the JSON fields in §2 are stable, the
doop MCP is visible to the launched agent, `--retry-launch` behaves. Not yet run (it creates state).

**Phase 1 — MVP: "Send to Orca" + status light.** Smallest valuable slice:

- `orca.rs` with `orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`,
  `orca_activate`; `__DOOP_ORCA__`.
- `frame_dev_tasks` + `POST /api/frames/:id/dev-tasks`, `GET …/dev-tasks`, the device report route,
  the `dev-task` broadcast.
- MCP `get_handoff` and `update_dev_task`; the short prompt of §6.3.
- Inspector Build card and the frame title badge; one agent at a time; this Mac only.

Value: a frame signed off becomes a running agent in one click, and everyone sees its state until
the PR.

**Phase 2 — close the loop.** `orca_ports` + live frame preview (F3), automatic drift review on
`done` (F4) with "Send fixes", the `doop:` worktree comment (F6), remote hosts (§10.2) with Orca
screenshots, `dev_task.updated` webhook.

**Phase 3 — scale out.** Code duel (F5), session search (F8), Orca automations bridge (F7: the
`doop dev-tasks --pending --exit-code` CLI precheck first, then "Run Orca automation" as a doop
automation action), `list_dev_tasks` / `request_dev_task` for agents.

Docs at each phase: `docs/FEATURES.md`, `docs/TECHSTACK.md`, and the tasks of this change in `.workflow/changes/`.

## 12. Decisions (Bryan, 2026-11-15)

- **Pack delivery (Q1):** MCP only (`get_handoff`). Nothing is written into the worktree.
- **Surface (Q2):** respect Bryan's Orca Chat | CLI setting; doop never forces `--surface`.
- **Targets (Q5):** this Mac **and** the VPS (`--environment vps`) in the MVP. Remote hosts move
  from phase 2 into phase 1: the launch picks the environment, status comes from
  `orca worktree ps --json` on that host, and the preview on the VPS uses Orca screenshots until a
  live frame can reach the remote dev server.

The questions below stay open.

## 13. Open questions for Bryan

1. Pack delivery: MCP only (`get_handoff`, recommended), or also files in the worktree so `stip`
   runs there?
2. Should a doop launch always force `--surface terminal` (predictable status, terminal verbs), or
   respect your Orca Chat | CLI setting?
3. Default agent and model for "Send to Orca": Claude Code opus/high, or remember the last pick per
   canvas like the composer's runner pick?
4. Branch naming: `doop/<change-id>` under your Orca branch prefix, or let Orca name it?
5. Do you want the VPS (`--environment vps`) as a launch target in the MVP, or Mac-only first?
6. Duel losers: leave them to Orca's cleanup rules, or offer "Clean up" from doop (native confirm,
   no `--force`)?
7. Automation bridge: is the precheck pattern (Orca polls `doop` hourly) acceptable, or do you want
   doop events to fire `orca automations run` from the desktop immediately?
8. Should the agent move the Orca board column (`--workspace-status in-review` on PR) or is that
   yours to move by hand?
9. Server-to-Orca headless launches (§10.3): never, or worth a separate spec?
10. Is Devin a real target (needs `orca account add --agent devin`), or Claude + Codex only?

## 14. Risks

- **CLI drift**: Orca ships often (1.4.259 today; several notes say "older hosts…"). Mitigation:
  schema check at startup, `--json` everywhere, tolerant parsing, feature hidden when flags vanish.
- **Status truth**: `mainAgent.outcome` can be `unconfirmed`; a chat agent may report `done` per
  turn, not per task. Treat `done` as "turn ended" and prefer the agent's `update_dev_task` for
  task completion.
- **Two sources of truth** (pull vs push) can disagree; last-writer-by-time with the agent's push
  winning for `pr_open`/`done`.
- **Load on the Mac**: one `worktree create` with setup hooks can install dependencies; a 3-way duel
  triples it. The confirmation says so; duels capped at 3.
- **Security of the bridge**: the new Tauri module is the riskiest code here. Keep it to the typed
  commands of §5, review it like `repo.rs`, and never add a "run this orca command" passthrough.
- **Transcript privacy**: search results (F8) can contain secrets typed in a terminal; never
  persisted server-side, shown only to the requester.
