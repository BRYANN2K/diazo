# Motion Studio backend, phases 0 and 1

## Problem

Motion Studio needs a contract, storage, an API and renderers before any timeline UI can work. The product proposal is [../motion-studio/proposal.md](../motion-studio/proposal.md); this change is the backend of its phases 0 and 1.

## Scope

- In: the composition contract (`shared/motion.ts`), the time → state runtime (`shared/motionRuntime.ts`), the seek-safety lint (`shared/motionLint.ts`), persistence with versions, REST and room messages, render jobs, the MCP and resident tools, the deterministic desktop render, and a disabled Blender bridge. API reference: `docs/motion-api.md` on the branch.
- Out: the timeline UI (change `frontend-redesign`), server-side renders (phase 5), real Blender renders (phase 4), metering of render jobs.

## Where the work is

- Branch `feat/motion-backend`, six commits from `6052d6a5` to `fc595d5a`, worktree `doop-wt/motion-backend`.
- PR #3 was closed unmerged against `main`; it must be reopened against `dev` under the branch flow (ADR 0006).
- Not yet run through Stip: no approval and no evidence are recorded. Review the spec, approve it, then `stip-check` against the branch.

## Decisions and open questions

- A composition belongs to an ordinary page ([ADR 0009](../../../docs/adr/0009-store-one-motion-composition-per-page.md)).
- HyperFrames timing contract, WAAPI and CSS runtime, no GSAP ([ADR 0010](../../../docs/adr/0010-adopt-the-hyperframes-contract-with-a-waapi-runtime.md)).
- Blender only through the desktop app ([ADR 0011](../../../docs/adr/0011-reach-blender-through-the-desktop-app.md)).
- The proposal names the table `scenes` and the tools `get_scene` / `set_scene`; the branch uses `compositions` and `get_composition` / `set_composition`. The branch names win; the proposal is not updated.
- After merge, the branch's lines that cite `.context/specs/motion-studio.md` and `.context/TECHSTACK.md` must point at this change and `docs/TECHSTACK.md`.
