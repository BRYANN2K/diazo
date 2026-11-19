# Orca integration — integrated tracking dossier (2026-11-19)

Single tracking record for this change. The integrated code and technical
documentation were reviewed on `57dfbd89`, with 55 focused tests passing
in an isolated copy. The approved contract is unchanged.

This file reconciles the two slices' evidence into one dossier:

- the **backend slice** record was read from the sibling worktree's
  change folder and is condensed here — its checks were executed there,
  not re-run in this worktree;
- the **frontend slice** was implemented and verified in this worktree.

## AC verdicts — integrated

- **AC-1 typed desktop commands — passed.** `orca_status`,
  `orca_resolve_repo`, `orca_launch_task`, `orca_poll`, `orca_ports`,
  `orca_activate`, `orca_untrack` registered in `main.rs`;
  `__DIAZO_ORCA__` and the `__DOOP_ORCA__` alias advertised. Each
  command builds one `--flag=value` argv through `run_orca` — no shell,
  no passthrough, never `--surface`; launch is gated by the native `rfd`
  confirmation (`DOOP_ORCA_CONFIRM=deny` only under `cfg(test)`).
  Fake-binary tests pin the argv, the `host list` environment check and
  the parse path. Frontend calls go through the typed `src/lib/orca.ts`
  bridge only.
- **AC-2 live launch on Mac or VPS, Chat/CLI setting respected —
  unverified.** The launch argv is pinned by test (`id:<repo>` selector,
  never `--surface`, `--model`/`--effort`/`--environment` variants), so
  a launch would use Orca's own configured surface — respecting the
  setting by construction, unproven live. `orca host list` on this Mac
  shows a real `vps` environment (`4a64568a-…`, read-only check). No
  real `worktree create` has run on either target; the
  declined-confirmation path is untested. Holds for the integrated
  change.
- **AC-3 MCP-only handoff — passed.** `get_handoff` serves the stored
  brief to the requester only — metadata as JSON text, PNGs as image
  blocks (`devTasks.test.ts`). Nothing writes into a worktree.
- **AC-4 records + broadcast — passed.** `frame_dev_tasks` (migrations
  0072, 0073, 0082, all in the committed journal) records each launch;
  status merges trimmed `worktree ps` rows; every `patch` broadcasts
  `dev-task` — the route test watches `queued → starting → working →
pr_open → done` reach the room. Frontend: REST hydration after every
  `init` plus `dev-task` upserts through `src/lib/ws.ts` and the
  canvas-scoped `devTasks` store (`tests/devTasksClient.test.ts`).
- **AC-5 Inspector card + frame badge — passed (seeded states).**
  `DevTaskSection`/`DevTaskLaunch` in the Inspector and `DevTaskBadge`
  on the frame title render idle, error, working and `pr_open` states —
  screenshot pairs below and `tests/devTasksUi.test.tsx`. Live
  poll-driven transitions unexercised (no live Orca, per scope).
- **AC-6 launch guards — passed.** Server: non-`ready_for_dev` → 409
  naming the gate; no link or offline device → 409 naming the fix;
  unloaded frame html → 503; invalid agent/model/effort/environment →
  400; >5 launches/min → 429 (`devTaskRoutes.test.ts`). Frontend: a real
  409 surfaces under Send to Orca in `role="alert"`; the button disables
  while sending.
- **AC-7 cancel/replay semantics — passed.** `launch.cancelled` →
  `cancelled` + `finishedAt`; a replayed `ok` launch cannot drag
  `working`/`pr_open`/`done` back; launch reports on terminal rows are
  ignored; `requestId` settles only that task's own `dev_task` job; a
  cancelled queued task's unclaimed job is withdrawn; stale `queued`
  rows sweep to `failed` at the TTL. Frontend: the report retry never
  re-launches and terminal state untracks (`devTasksBridge.test.ts`).
- **AC-8 hydration + room updates — passed (frontend).** `devTasks`
  keyed by id, canvas-scoped merge with the room row winning when newer,
  cleared on canvas switch; hydration and upsert covered by client and
  bridge tests.
- **AC-9 roles — passed.** Server: `orca_activate`/`orca_ports`/
  `orca_untrack` refuse identities the shell did not launch for the
  current server + environment; GET routes are view-role; `report` is
  requester-and-device bound (403/409); `cancel` is edit-role. Frontend:
  a view-only participant has no Inspector — the frame badge is the PR
  link (`pr_open`, http(s) only), verified in the view-only capture.
- **AC-10 brief + public projection — passed.** `buildDevTaskBrief`
  tests pin it: a render failure lands as a named warning while title,
  meta and the good PNG still ship; code links narrow to the brief's
  frames and their components. Public rows select `STATUS_COLUMNS`
  (every column but `handoff`); `DevTask` exposes no path,
  `requestedByUserId` or `deviceId` — asserted in unit, route and
  `get_canvas` tests.
- **AC-11 truthful terminal detection — passed.** `poll_rows` reports
  nothing for a missing identity on a `truncated` page (a false
  `found:false` would wrongly cancel); `pollStateOf` returns null for a
  bare `agentState: done` — only `mainAgent.outcome` (with
  `programStatus` as outcome-shaped fallback) ends a task.

## API review

Every element below is code- and test-verified except the deferred
webhook.

- `POST /api/frames/:id/dev-tasks` (edit): builds the stored brief,
  creates the `queued` row, queues the `dev_task` bridge job with typed
  `DevTaskLaunchArgs`. Route tests cover auth, body validation,
  409/429/503 and the job payload.
- `GET /api/frames/:id/dev-tasks` and `GET /api/canvases/:id/dev-tasks`
  (view): the public projection, newest first, terminal rows included —
  reloads keep finished tasks visible.
- `POST /api/dev-tasks/:id/report` (the launching device): binds
  `deviceId` once, settles `requestId` through `finishDevTask`, merges
  launch + poll. Idempotent against replays — a settled `requestId` or a
  terminal row cannot be moved backwards.
- `POST /api/dev-tasks/:id/cancel` (edit): terminal-safe, withdraws the
  unclaimed bridge job, sends nothing destructive to Orca.
- `dev-task` broadcast: on every stored change (`patch` → `announce`),
  room-verified end-to-end.
- `get_canvas` includes `dev_tasks` in the public shape — covered by
  test.
- `dev_task.updated` outbound webhook: **deferred** — phase 2 per
  background §11; not in the AC list.

## Backend slice — reconciled evidence

Verified in the sibling worktree (its own checks below); reconciled
here, not re-executed.

- `tests/devTasks.test.ts`: +5 tests — brief renders frames and carries
  tokens, missing-PNG warning + usable brief, code-link narrowing, plan
  passthrough, `get_canvas` `dev_tasks` public shape; `saveToken` added
  to the persist mock.
- `server/index.ts`: stale "pack" comment corrected to brief.
- `docs/orca.md`: added the missing `GET /api/frames/:id/dev-tasks` row;
  the `taskId` example is nanoid-shaped.
- Deeper backend detail (flag-shaped argv values, `orca-tasks.json`
  locking, cancel/withdraw/TTL, projection columns, stream draining,
  `linkedPR` reduction, parity test, test hygiene) is verbatim in the
  historical record at the bottom of this file.

Backend checks run (in its worktree, cited not re-run): `typecheck`,
`lint`, `format:check`, `doc-lint` clean; vitest on the seven
backend-owned suites 67/67; `cargo test --locked -j 2` 127/127
(13 orca). Its open notes: `DevTaskBrief.plan` exists but no launch
input populates it (no AC requires a plan — flagged for the contract
owner); a poll landing on a terminal row still refreshes
`prUrl`/`summary`/`devUrl`/`branch` — enrichment, not a state change.

## Frontend slice — verified in this worktree (baseline `cee4509a`)

### Implemented

- `src/lib/api.ts` — `createDevTask`, `canvasDevTasks`, `frameDevTasks`,
  `reportDevTask`, `cancelDevTask` typed against `shared/devTasks.ts`.
- `src/lib/store.ts` — `devTasks` keyed by id, `setDevTasks(tasks,
canvasId)` (canvas-scoped merge, room row wins when newer),
  `upsertDevTask` (`updatedAt` guard); store cleared on canvas switch so
  a previous canvas's tasks never leak (AC-8).
- `src/lib/devTasks.ts` — `hydrateDevTasks` (REST after every `init`),
  `devTasksForFrame`, `latestDevTaskForFrame`, `hasDevTaskForFrame`,
  `DEV_TASK_STATE_KEYS`.
- `src/lib/ws.ts` — hydration on each `init`; `dev-task` room messages
  upsert (AC-4/AC-8).
- `src/lib/orca.ts` — typed bridge for `orca_status`, `orca_launch_task`,
  `orca_poll`, `orca_activate`, `orca_untrack` behind `__DIAZO_ORCA__` /
  `__DOOP_ORCA__` (AC-1).
- `src/lib/localRepo.ts` — `dev_task` dispatch off the repo loop, launch
  report on `/report` with `requestId`, ~10s per-environment poll, ~5s
  report retry that never re-launches, terminal-state untracking, no
  `finish` for dev tasks (AC-2/AC-7/AC-11).
- `src/components/DevTasks.tsx` — `DevTaskSection` (task rows newest
  first, cap 5), `DevTaskLaunch` (agent select; environment select only
  when the shell names targets; send disabled while sending; server
  error text in `role="alert"`), `DevTaskBadge` (frame-title chip; when
  `prUrl` is http(s) it is also the PR link — the only dev-task surface
  a view-only participant can reach, AC-9), `DevTaskRow` (state chip,
  meta line, summary, stale-revision note, `View PR`, `Open in Orca` on
  the launching shell only, `Cancel` for editors while non-terminal,
  `role="status"` sr line).
- `src/components/Inspector.tsx` — Build group between Development and
  Code, shown only when the frame has tasks or can launch
  (ready_for_dev + edit role).
- `src/components/FrameView.tsx` — `<DevTaskBadge frame>` in the title
  bar next to the approval badge.
- `src/lib/i18n/{en,pt-BR}/devTasks.ts` — both locales.

### Screenshot evidence — found and missing

Baseline `cee4509a` vs candidate (this worktree), same canvas
`/c/SmaL5o-xDk`, frame `Hero — Terrarium` (`9HKN-8zfup`,
`ready_for_dev`), same route, theme via `doop-theme` localStorage,
desktop 2006×1318 browser px, mobile iPhone 15 emulation 393×852. All
captures are local under `shots/`.

Found — 17 files (4 baseline + 13 candidate):

| State                                      | Before                                   | After                                           |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| desktop light idle                         | shots/before/inspector-desktop-light.png | shots/after/inspector-desktop-light.png         |
| desktop light error (real 409)             | — (state absent on baseline)             | shots/after/inspector-desktop-light-error.png   |
| desktop light working (seeded)             | — (absent)                               | shots/after/inspector-desktop-light-working.png |
| desktop light success `pr_open` (seeded)   | — (absent)                               | shots/after/inspector-desktop-light-success.png |
| desktop dark idle                          | shots/before/inspector-desktop-dark.png  | shots/after/inspector-desktop-dark.png          |
| desktop dark error                         | — (absent)                               | shots/after/inspector-desktop-dark-error.png    |
| desktop dark working                       | — (absent)                               | shots/after/inspector-desktop-dark-working.png  |
| desktop dark success                       | — (absent)                               | shots/after/inspector-desktop-dark-success.png  |
| mobile light idle                          | shots/before/inspector-mobile-light.png  | shots/after/inspector-mobile-light.png          |
| mobile light working                       | — (absent)                               | shots/after/inspector-mobile-light-working.png  |
| mobile dark idle                           | shots/before/inspector-mobile-dark.png   | shots/after/inspector-mobile-dark.png           |
| mobile dark working                        | — (absent)                               | shots/after/inspector-mobile-dark-working.png   |
| desktop light view-only (`pr_open` seeded) | — (absent)                               | shots/after/canvas-desktop-light-viewonly.png   |

Missing — never captured (browser use is out of scope on this Mac for
this batch; candidate states that were absent on baseline have no
before-pair by construction):

- mobile light/dark error and `pr_open` success;
- mobile view-only (light/dark) and desktop dark view-only;
- before-captures for every non-idle state (the Build card did not exist
  at baseline).

Intended differences: the Build card between Development and Code, the
state chip on the frame title, Cancel/View PR affordances by role, the
`role="alert"` error text under Send to Orca, "View only" chrome with
the badge but no Inspector for viewers. Task states were seeded through
the live store (`upsertDevTask`) with a correctly-shaped `DevTask`
fixture; the error shot is a real `POST /api/frames/:id/dev-tasks` 409.
No unintended layout/typography/overflow changes observed in the pairs;
one review found the host label truncating inline, fixed by giving the
meta its own line before final captures.

### Polling resumes after reload

`tracked` started empty each session, so `pollLoop` had no environments
to ask even though the shell's `orca-tasks.json` still held this
session's identities. `watchEnvironments()` now unions tracked
environments with the environments named by the open canvas's live
(`orcaIdentity`, non-terminal) task rows; `pollEnvironment()` re-primes
`tracked` from any persisted row `orca_poll` returns (`taskId` resolved
via the canvas rows, left absent until hydration can name it); the first
tick additionally sweeps `undefined` plus every `orca_status()`
environment name, covering session worktrees on Mac and VPS whose canvas
is not open. `untrackEnded` resolves discovered entries through
`taskIdFor`. No launch is ever re-run — `orca_launch_task` is invoked
only from `runDevTask`. Covered by `tests/devTasksBridge.test.ts` ›
"resumes polling persisted identities after a reload, without
relaunching".

Coverage limits for this fix:

- The environment sweep runs once per `startLocalRepo` lifetime (first
  tick). If `orca_status` fails at that instant, a session identity on a
  closed canvas's remote env is not probed until a reference appears.
- Rows whose canvas never opens keep their environment watched but
  cannot be reported (no task id) — they resolve when the user opens
  that canvas and REST hydration lands.
- Foreign tasks' environments cost one empty `worktree ps` per tick
  while the canvas is open; `orca_poll` filters shell-side so no wrong
  report is possible.
- Fakes only — no live Orca/native verification (per scope).

### Report contract alignment + late-hydration memorization (2026-11-19)

The three report layers disagreed on how an absent optional field is
spelled: the shell emitted explicit `null`, the shared types treat
absent as `undefined`, the REST schema only accepted omission — a launch
answer or in-progress poll carrying absent fields was rejected with 400
and dropped. The convention is now uniform: **absent means the key is
omitted**; `null` is kept only where it carries meaning (`devUrl: null`
clears the stored dev-server URL; `linkedPR` stays `string | null` as
the shared type always allowed).

- `desktop/src-tauri/src/orca.rs`: `set_opt` helper inserts a key only
  for `Some`; `poll_row`/`launch_reply` build maps field by field and
  omit `None`.
- `server/index.ts` `devTaskReportSchema`: `absentString`/`absentBool`
  helpers are `.nullish()` then transform `null` to `undefined` — both
  spellings accepted, type + max validation unchanged; `linkedPR` and
  `devUrl` stay `.nullable().optional()`.
- `src/lib/localRepo.ts`: `queueReport` strips `null` keys from `launch`
  and `poll` (`omitNulls`, `devUrl` kept) so a report never carries an
  empty key even if a shell sent one.

Late-hydration memorization: when `taskIdFor` resolves an identity
through the canvas task rows, it writes the resolved id back into the
`tracked` entry — the association survives a canvas switch that empties
`devTasks`, so polling keeps reporting to the right task id.

Covered by `tests/devTasksBridge.test.ts`: "posts absent report fields
as omissions when a shell sends explicit null" (realistic older-shell
payloads; asserts exact keys, `devUrl` the only preserved null) and
"resolves a discovered identity once hydration lands, and keeps it
across canvas switches" (empty `tracked` + empty store, Mac + VPS rows,
hydration, store emptied again; zero `orca_launch_task` calls
throughout).

### Checks run in this worktree

- `bun run typecheck` — clean.
- `bun run lint` (oxlint type-aware + eslint) — clean.
- `bunx prettier --check` on all touched files — clean after `--write`.
- `bun run doc-lint` — passed, 0 warnings.
- `bunx vitest run tests/devTasksBridge.test.ts --maxWorkers=1` — 10/10.
- `bunx vitest run tests/devTasksUi.test.tsx tests/devTasksClient.test.ts
--maxWorkers=1` — 14/14.
- `cargo check --locked` in `desktop/src-tauri` — compiles; the two
  dead-code warnings are pre-existing in `acp.rs`/`speech.rs`, unrelated.

### Changelog

- `docs/FEATURES.md` — the "Send to Orca (desktop app)" entry exists on
  the shared base (`cee4509a`, lines 125–131), describing the launch,
  live task state, MCP brief and the no-path guarantee.
- `CHANGELOG.md` lists Send to Orca under `[Unreleased]`.

## Coverage limits — consolidated

- **AC-2 stays unverified**: no real `worktree create` on this Mac or
  the VPS; the Orca Chat-or-CLI surface setting unexercised; the
  declined-confirmation path untested.
- No live Orca launch, poll, activate or report exercised anywhere —
  fakes and seeded fixtures only.
- `cargo test` was not re-run in this worktree (backend's 127/127 is
  cited from its own run; the contract-alignment Rust edit was verified
  here by `cargo check` only).
- Backend slice numbers are reconciled citations, not re-executed runs.
- The approver's 55-test total at `57dfbd89` is recorded as reported;
  this worktree's own verified counts are listed above.
- Screenshot matrix gaps are listed under "Missing" above.
- Full `bun run test` and browser flows were deliberately not run on
  this Mac for this batch.

## Historical record

### Review status, 2026-11-18

Source inspection at `cee4509a`. No test, live account, design
comparison or desktop execution was performed for this rewrite. AC-1,
AC-3 and AC-4 have historical backend coverage below. AC-2 still needs a
native launch on each target. AC-5 needs implemented UI. The revised
brief and AC-6 through AC-11 awaited fresh checks — provided above.

At `cee4509a`, state.json recorded phase `applying` without an approval
digest. Structural validation returned the revised contract to draft;
approval was later recorded at digest
`cf313e28cdab6e73c5112da6fca096b980464e043e1c037340d2b8b0cb866acf`
(2026-11-18).

### Verbatim pre-11-18 backend evidence

Backend scope (server, shared, desktop shell — the frontend AC-5 was a
separate change). Rewritten after the 2026-11-17 review fixes; each AC
carried its verdict.

- **AC-1 typed desktop commands — passed.** `desktop/src-tauri/src/orca.rs`:
  `orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`,
  `orca_ports`, `orca_activate`, `orca_untrack`, each building one argv
  vector through `run_orca`; no shell is spawned anywhere. Launch passes a
  native `rfd` confirmation that now names the worktree, the agent and the
  persisted launch comment. `cargo test --locked -j 2` → 108 tests (12
  orca): `argv_never_uses_a_shell` and
  `launch_args_builds_the_worktree_create_argv` pin the real launch vector,
  plus `validation_accepts_the_contract`,
  `environments_come_from_host_list`, `tracked_is_per_environment_and_server`,
  `ended_entries_report_then_prune`, `tasks_store_roundtrips` and
  `run_orca_parses_and_reports` against a fake `orca` binary. The
  fake-binary tests are `#[cfg(unix)]` — the module compiles on Windows.
- **AC-2 launch on Mac or VPS, surface respected — unverified.** The argv
  is pinned by test (`id:<repo>` selector, never `--surface`, `--model` /
  `--effort` / `--environment` variants), and `orca host list` on this Mac
  shows a real `environment` host `vps`
  (`4a64568a-3145-413d-93be-f3a95f46e707`, read-only check). No real
  `worktree create` has run; the declined-confirmation path and a live
  launch on this Mac or the VPS are still untested.
- **AC-3 MCP-only handoff — passed.** `get_handoff` in `server/mcp.ts`
  returns the stored pack's files (text and image blocks) to the requester
  only; nothing writes into the worktree. `devTasks.test.ts` covers the
  pack contents and the refusal for any other account.
- **AC-4 records + broadcast — passed.** `frame_dev_tasks` (migrations
  0072 + 0073, both in the committed journal — verified on a clean export)
  holds the opaque `wt2:` identity. `POST /api/dev-tasks/:id/report`
  merges launch + poll reports and the agent's `update_dev_task`; the room
  sees `queued → starting → working → pr_open → done` as `dev-task`
  broadcasts (`devTaskRoutes.test.ts`, 7/7).
- **AC-5 Inspector card + frame badge — unverified.** A separate frontend
  change; nothing for it shipped here.

Beyond the AC list:

- **Flag-shaped values (review fix 7).** Every dynamic launch value rides
  as one argv element `--flag=<value>` — the parser can never see a bare
  `--x` — and `name`/`prompt`/`comment`/`model`/`effort` additionally
  reject a leading `-` and control characters (`valid_line`,
  `valid_prompt`, `valid_flag_value`). `--environment` values must come
  from `orca host list`.
- **Cancel / restart / locking (review fix 8).** `orca-tasks.json` writes
  are serialized through a managed `OrcaState` mutex (load–mutate–save in
  `edit_tasks`, atomic write-then-rename). Identities carry the Diazo
  `server` origin: polls, ports, activate and `orca_untrack` only ever
  touch the current server/environment's set; rows from before the keying
  match nothing. A poll row that ended the task (vanished worktree or
  terminal `outcome`) stamps `ended`, keeps reporting for a grace window,
  then `prune_ended` retires it; `orca_untrack` drops it earlier once the
  room knows the end state.
- **Server side of 8.** `cancelDevTask` on a `queued` row withdraws the
  task's unclaimed `dev_task` bridge job (`localRepo.withdrawDevTask`) —
  a stopped launch is never handed to the desktop, and the withdrawn
  job's `cancelled` answer cannot flunk the row. Bridge requests live in
  process memory: `failStaleDevTasks` sweeps `queued` rows older than
  `DEV_TASK_LAUNCH_TTL_MS` to `failed` at boot and every minute.
- **Nits landed.** Launch reports on a terminal row are ignored (a late or
  replayed answer cannot resurrect `done`); `requestId` settles only that
  task's own `dev_task` entry (`finishDevTask`); `requestedByUserId` and
  `deviceId` no longer leave the server (out of `DevTask`, broadcasts and
  REST answers); `POST /api/frames/:id/dev-tasks` is rate limited
  (5/user/minute — every call builds a pack); `model`/`effort` are
  charset-checked server-side (`[a-z0-9._:-]+`, no leading `-`,
  `effort` needs `model`); `update_dev_task` verifies the requester still
  has canvas access; dev-task rows die with their canvas
  (`persist.deleteCanvas`) and with the requester's account
  (`purgeUserData`); a poll ends a task only on the main agent's
  `mainAgent.outcome` — real Orca reports `programStatus.state` as just
  `working`/`done`, and the per-turn `agentState: done` never does
  (`pollStateOf` returns null for it, `mergedPollState` case pinned);
  `ORCA_CLI_COMMAND` is documented in `docs/orca.md` (binary resolution
  order: `DOOP_ORCA_CLI`, `ORCA_CLI_COMMAND`, install paths, `PATH`).
- `dev_url` and `orca_ports`: the report schema admits `poll.devUrl`, the
  server stores it http(s)-only, and the route test watches it reach the
  task. `orca_ports` trims `orca ports` to port/url/process.
- Status reads (`devTaskRow`, `devTasksForCanvas`, the report merge's
  `returning`) select every column but `handoff` — the base64 pack only
  leaves Postgres inside `handoffFor` for `get_handoff`, including the
  `dev_tasks` in `get_canvas`.
- `run_orca` drains stdout and stderr on threads while it waits (4 MB kept
  per stream, the rest dropped) — no pipe deadlock past 64 KB — and
  `wait()` follows `kill()` so no zombie is left.
- A poll's `linkedPR` is reduced to a URL string in `poll_row` (`as_str`,
  else `.url`) and must match `^https?://` to be stored or to claim
  `pr_open`, the same rule as `pr_url` and `devUrl`.
- **Resident parity** — `tests/agentToolParity.test.ts` lists
  `get_handoff`/`update_dev_task` under MISSING by design: resident agents
  have no Orca task context.
- **Docs** — `docs/orca.md` (contract), `docs/TECHSTACK.md`,
  `docs/FEATURES.md` updated.
- **Test hygiene** — the route suite's `deviceOnline` helper now waits for
  the device to register before returning the claim promise (the launch
  POST used to race it and could flake to 409 under parallel load).
- **Round 3, against real `worktree ps --json`** — the launch answer is
  whitelisted through `launch_reply` (Orca's `<repoId>::<abs path>` id
  overran the report's `max(120)` and leaked a local path); `worktreeId`
  left the report contract and `TrackedTask`; a `truncated` page reports
  nothing for missing identities rather than a false `found:false` cancel;
  an `ok` launch only moves `queued` to `starting`, so a replayed report
  cannot drag a `working`/`pr_open` row back.

Checks run 2026-11-17:

- `bun run typecheck` — clean.
- `bun run lint` (oxlint `--type-aware` then eslint `--max-warnings 0`) —
  clean.
- `bun run format:check` — clean; `bun run doc-lint` — passed, 0 warnings.
- `bunx vitest run tests/devTasks.test.ts tests/devTaskRoutes.test.ts` —
  28/28.
- `cargo test --locked -j 2` in `desktop/src-tauri` — 108/108.

Round 3, rebased on `origin/dev` (the `docs/FEATURES.md` conflict kept
both bullets):

- `bun run typecheck`, `bun run lint`, `bun run format:check`,
  `bun run doc-lint` — clean.
- `bunx vitest run tests/devTask*.test.ts` — 31/31 (failure→failed,
  success→done, replayed `ok` launch keeps `working`/`pr_open`, a
  path-shaped worktree id no longer fails the route's schema).
- `cd desktop/src-tauri && cargo test --locked` — 117/117 (fixture now
  mirrors the real `mainAgent`/`programStatus` nesting; `launch_reply`
  carries no path; a truncated `ps` is not a vanished worktree).
