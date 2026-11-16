# Evidence

Backend scope (server, shared, desktop shell — the frontend AC-5 is a
separate change).

- **AC-1 typed desktop commands** — `desktop/src-tauri/src/orca.rs`:
  `orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`,
  `orca_activate`, each building one argv vector via `Command::args`
  (`run_orca`); no shell is spawned anywhere. Launch passes a native
  `rfd` confirmation (`confirm_launch`). Verified: `cargo test -j 2` —
  106 tests, including `orca::tests::argv_never_uses_a_shell`,
  `validation_accepts_the_contract`, `environments_come_from_host_list`
  (fake `orca` binary, no real Orca state).
- **AC-2 launch on Mac or VPS, surface respected** — `orca_launch_task`
  builds `worktree create --name --repo id:<resolved> --branch --agent
--prompt --comment --no-parent --json` plus `--model`/`--effort` and
  `--environment` (validated against `orca host list` names/ids).
  `--surface` is never emitted (`argv_never_uses_a_shell`). Verified by
  fake-`orca` argv capture in the Rust tests; the real `vps` environment
  was confirmed present via `orca host list` (read-only).
- **AC-3 MCP-only handoff** — `get_handoff` in `server/mcp.ts` returns
  the stored pack's files (text and image blocks), nothing writes into
  the worktree. Verified: `devTasks.test.ts` (`get_handoff` pack
  contents, requester binding) and `devTaskRoutes.test.ts` — 5/5
  `bunx vitest run tests/devTaskRoutes.test.ts --maxWorkers=2`.
- **AC-4 records + broadcast** — `frame_dev_tasks` (schema + migration 0072) holds the opaque `wt2:` identity; `POST /api/dev-tasks/:id/report`
  merges device launch/poll reports (`found:false` → `cancelled`,
  `linkedPR` → `pr_open`, `outcome` → done/failed/cancelled) and the
  agent's `update_dev_task`; every change broadcasts `{type:'dev-task'}`.
  Verified: `devTaskRoutes.test.ts` observed the broadcast sequence
  `queued → starting → working → pr_open → done` over the live room.
- **Resident parity** — `tests/agentToolParity.test.ts` lists
  `get_handoff`/`update_dev_task` under MISSING by design: resident
  agents have no Orca task context.
- **Docs** — `docs/orca.md` (contract), `docs/TECHSTACK.md`,
  `docs/FEATURES.md` updated.
