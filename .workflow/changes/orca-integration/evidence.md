# Evidence

Backend scope (server, shared, desktop shell — the frontend AC-5 is a
separate change). Rewritten after the 2026-11-16 review fixes; each AC
carries its verdict.

- **AC-1 typed desktop commands — passed.** `desktop/src-tauri/src/orca.rs`:
  `orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`,
  `orca_ports`, `orca_activate`, each building one argv vector through
  `run_orca`; no shell is spawned anywhere. Launch passes a native `rfd`
  confirmation. `cargo test --locked -j 2` → 107 tests (10 orca):
  `argv_never_uses_a_shell` and `launch_args_builds_the_worktree_create_argv`
  pin the real launch vector, plus `validation_accepts_the_contract`,
  `environments_come_from_host_list` and `run_orca_parses_and_reports`
  against a fake `orca` binary. The fake-binary tests are `#[cfg(unix)]` —
  the module compiles on Windows.
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
  broadcasts (`devTaskRoutes.test.ts`, 6/6).
- **AC-5 Inspector card + frame badge — unverified.** A separate frontend
  change; nothing for it shipped here.

Beyond the AC list:

- `dev_url` and `orca_ports`: the report schema now admits `poll.devUrl`
  (zod was stripping it), the server stores it http(s)-only, and the route
  test watches it reach the task. `orca_ports` trims `orca ports` to
  port/url/process.
- Status reads (`devTaskRow`, `devTasksForCanvas`, the report merge's
  `returning`) select every column but `handoff` — the base64 pack only
  leaves Postgres inside `handoffFor` for `get_handoff`, including the
  `dev_tasks` in `get_canvas`.
- `run_orca` drains stdout and stderr on threads while it waits (4 MB kept
  per stream, the rest dropped) — no pipe deadlock past 64 KB — and
  `wait()` follows `kill()` so no zombie is left.
- A poll's `linkedPR` is reduced to a URL string in `poll_row` (`as_str`,
  else `.url`) and must match `^https?://` to be stored or to claim
  `pr_open`, the same rule as `pr_url`.
- **Resident parity** — `tests/agentToolParity.test.ts` lists
  `get_handoff`/`update_dev_task` under MISSING by design: resident agents
  have no Orca task context.
- **Docs** — `docs/orca.md` (contract), `docs/TECHSTACK.md`,
  `docs/FEATURES.md` updated.

Checks run 2026-11-17:

- `bun run typecheck` — clean.
- `bunx oxlint --type-aware --deny-warnings --ignore-pattern '.claude/**' .`
  and `bunx eslint . --max-warnings 0` — clean.
- `bunx vitest run tests/devTasks.test.ts tests/devTaskRoutes.test.ts
--maxWorkers=2` — 21/21 on this worktree, and again on a `git archive
HEAD` export at `/tmp/orca-clean` after `bun install` (the journal fix
  no longer depends on worktree state).
- `cargo test --locked -j 2` in `desktop/src-tauri` — 107/107.

Still open from the review, not this change: flag-shaped `--name` /
`--prompt` / `--comment` values (fix 7), cancel/boot/concurrency hardening
and `orca-tasks.json` locking (fix 8), and the listed nits.
