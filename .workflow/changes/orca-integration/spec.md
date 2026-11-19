# Orca integration

## Intent

A frame signed off for development becomes a running coding agent in an Orca worktree in one click, and everyone on the canvas sees its state until the PR. Full proposal: [proposal.md](proposal.md). Phase 1 (MVP) is the first change to build.

## Acceptance criteria

- AC-1: The desktop shell talks to Orca only through typed commands (`orca_status`, `orca_resolve_repo`, `orca_launch_task`, `orca_poll`, `orca_activate`) behind `__DIAZO_ORCA__` with the `__DOOP_ORCA__` compatibility alias, with a native confirmation before a launch, and no command passthrough.
- AC-2: "Send to Orca" on a ready-for-dev frame creates a worktree and starts the agent on this Mac or on the VPS, respecting the Orca Chat or CLI setting.
- AC-3: The coding agent gets the stored launch brief through MCP only (`get_handoff`), with metadata and available frame PNGs; nothing is written into the worktree by Diazo.
- AC-4: `frame_dev_tasks` records each launch; its status comes from `orca worktree ps --json` and from the agent's `update_dev_task`, and is broadcast to the canvas as `dev-task`.
- AC-5: The Inspector Build card and the frame title badge show the dev task's state.

- AC-6: On a non-ready frame or without edit access the user cannot initiate a launch. Missing grants, unavailable devices and server errors leave an actionable explanation and an explicit retry.
- AC-7: A native refusal records cancellation. A delayed report or reconnect never creates a second worktree or reopens a finished task.
- AC-8: Two viewers see the same state after reload, room reconnect or an update arriving during initial load. Switching canvases never shows the previous canvas's tasks.
- AC-9: A tracked task can be opened on its originating device. A view-only participant can read its status and available PR link without gaining launch or cancellation rights.
- AC-10: A missing PNG yields a usable brief with a warning. Public room and REST task rows expose neither the brief nor a local filesystem path.
- AC-11: A truncated poll cannot cancel a missing identity. An agent finishing a turn is not reported as finishing the worktree task.

## Out of scope

Live previews, drift review and multi-agent duels are outside this phase.
