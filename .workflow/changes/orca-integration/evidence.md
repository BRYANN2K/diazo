# Evidence

Backend scope (server, shared, desktop shell — the frontend AC-5 is a
separate change). Rewritten after the 2026-11-17 review fixes; each AC
carries its verdict.

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
