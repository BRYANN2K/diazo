# Send a signed-off frame to Orca

Source baseline: dev at `cee4509a`. The backend landed in PR #28. PR #36 replaced the file pack with a stored frame brief. The original decisions, CLI experiments and later phases remain in [background.md](background.md).

## Launch and ownership

The missing piece is the path from a selected frame to a confirmed launch and back to the room. The Inspector submits the selection to the server. Only a native device with the repo grant runs Orca. A web participant with view access can follow a launch from another device. The browser never needs the grant folder or a worktree path.

Use the existing REST contracts in `server/index.ts:1384` and [docs/orca.md](../../../docs/orca.md). The launch POST accepts an allowlisted agent, optional model and effort, and optional environment. Omit environment for this Mac. Offer only hosts returned by Orca. Preserve the server-generated worktree name and branch. Leave Orca's Chat/CLI preference intact. Default to this Mac and require a valid available account choice. A refused native confirmation ends this request. Retrying after a refusal is a new user action.

## Device and room

The current loop in `src/lib/localRepo.ts:101` polls a job and sends a generic finish. Dispatch a claimed dev task to its dedicated report route, including the same request ID and device ID. Keep normal folder requests on their existing path. Scope polling to active origin and environment. Report deltas from tracked identities, and untrack only after the server has acknowledged a terminal state. Recover a lost acknowledgement by retrying the report, never by launching a second worktree.

Read public task rows from the canvas list. Subscribe to room updates while hydration is in flight. Reconcile by task ID and updatedAt, discarding late data after canvas navigation. The Inspector shows current state, host, agent, summary and supported actions. The frame title carries the same state text or accessible equivalent. Keep terminal rows visible on reload. Cancellation follows the server contract, which withdraws pending work and records cancellation. It does not promise to terminate an agent already running.

## Handoff

The existing `DevTaskBrief` in `shared/devTasks.ts:240` carries title, canvas, optional plan, frames with dimensions and optional PNG, optional token descriptions and relevant code links, and warnings. The MCP caller receives metadata as JSON and available PNGs as image blocks. A render warning leaves the textual brief usable. Only the public task projection enters REST and room events. Preserve requester checks on agent updates and the existing canvas access requirements. The resident has no Orca task context. Its documented parity exception stands.

## Dependencies and boundaries

Use the native operations, database schema and bridge job already on dev. No migration or new agent tool is required. A built compatible shell, local Orca, a paired VPS and a configured coding account are prerequisites for end-to-end evidence. Drift, preview, duels, automations and session search remain later work even where supporting fields already exist.
