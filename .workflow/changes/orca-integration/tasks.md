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

## Implementation sequence on feat/orca-ui

The checked items above record the original backend work. PR #36 supersedes their pack description with the stored brief. Phase two stays deferred.

1. **Typed client and hydration (AC-4, AC-8).** Add launch, list, report and cancel methods in `src/lib/api.ts` using `DevTask` from `shared/devTasks.ts`. At canvas entry subscribe and reconcile REST plus room rows by ID/revision. Cover a newer event preceding an older list, a second viewer reconnect and a late response after navigation.
2. **Device dispatch (AC-1, AC-2, AC-7, AC-11).** Branch on `dev_task` before generic completion in `src/lib/localRepo.ts`. Resolve the granted repo on the chosen host, invoke typed native launch, and deliver the resulting report. Poll roughly every ten seconds per environment while tracking tasks. Retry delivery after a network error without repeating native launch. Exercise native refusal, lost reply, truncated poll and ordinary folder jobs with a fake bridge.
3. **Launch and status panel (AC-2, AC-5, AC-6, AC-9).** Add a Build section in `src/components/Inspector.tsx` for selected approved frames. Bind pending/error states and disable repeated submit. Distinguish unavailable shell, disconnected grant, permission denial, throttling and brief generation failure. Show state in `FrameView.tsx` and expose accessible labels in both locales. Check keyboard activation, browser-only observer, view-only role, valid PR link and native activation for tracked identity.
4. **Verify the brief (AC-3, AC-10).** Run devTasks, devTaskRoutes, devTaskHandoffMigration and agentToolParity suites. Inspect MCP text and image blocks, missing-render warnings, legacy data and public projections. No pack files should appear in the worktree.
5. **Record device proof (AC-1–AC-11).** On a built shell, record versions, target, task ID, confirmation choice, resulting worktree and room transitions. Cover Mac and paired VPS, respect both Orca surface settings and use a configured Codex or ChatGPT connection for the live run. Repeat with refusal and a browser observer. Record unavailable prerequisites as unverified.
