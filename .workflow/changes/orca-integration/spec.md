# Orca integration

## Intent

A frame signed off for development becomes a running coding agent in an Orca worktree in one click, and everyone on the canvas sees its state until the PR. Full proposal: [proposal.md](proposal.md). Phase 1 (MVP) is the first change to build.

## Acceptance criteria

- AC-1: The desktop shell talks to Orca only through typed commands (`orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`, `orca_activate`) behind `__DOOP_ORCA__`, with a native confirmation before a launch, and no command passthrough.
- AC-2: "Send to Orca" on a ready-for-dev frame creates a worktree and starts the agent on this Mac or on the VPS, respecting the Orca Chat or CLI setting.
- AC-3: The coding agent gets the handoff pack through MCP only (`get_handoff`); nothing is written into the worktree by Diazo.
- AC-4: `frame_dev_tasks` records each launch; its status comes from `orca worktree ps --json` and from the agent's `update_dev_task`, and is broadcast to the canvas as `dev-task`.
- AC-5: The Inspector Build card and the frame title badge show the dev task's state.
