# Tasks — Orca integration (phase 1 backend)

- [x] Contract: `shared/devTasks.ts` (states, allowlisted agents, caps,
      `DevTaskLaunchArgs`), `dev-task` `ServerMessage`, `dev_task` bridge op
      (`shared/localRepo.ts`), API section in `docs/orca.md`.
- [x] `frame_dev_tasks` schema (`server/db/schema.ts`) + migration 0072. No
      absolute path is stored: `orcaIdentity` is the opaque `wt2:` key.
- [x] `server/devTasks.ts`: `POST /api/frames/:id/dev-tasks` (409 without an
      online grant-holding device, 503 on a pack-build failure), `GET
/api/frames/:id/dev-tasks` and `GET /api/canvases/:id/dev-tasks`, `POST
/api/dev-tasks/:id/report` (binds the device, settles the bridge request,
      merges launch + poll rows), `POST /api/dev-tasks/:id/cancel`, `dev-task`
      room broadcast.
- [x] MCP: `get_handoff` (task meta + pack files; text as text, PNGs as
      image blocks), `update_dev_task` (requester only; `needs_input`,
      `pr_open`, `done`, `failed`); `dev_tasks` in `get_canvas`; resident
      parity recorded in `tests/agentToolParity.test.ts` (MCP-only tools — a
      resident has no Orca task context).
- [x] `desktop/src-tauri/src/orca.rs`: `orca_status`, `orca_resolve_repo`,
      `orca_launch_task` (native confirmation, `worktree create … --json`,
      `--environment` validated against `host list`, never `--surface`),
      `orca_poll` (trimmed to launched identities), `orca_activate`; no
      passthrough; `__DIAZO_ORCA__` + `__DOOP_ORCA__` advertised; launched
      identities persisted per environment in `orca-tasks.json`.
- [ ] Frontend (separate agent): Send to Orca UI, Inspector Build card,
      frame badge, task polling (AC-5).
- [ ] Phase 2 if time: dev-server port to a live frame, drift review on
      `done`, worktree comment link.
