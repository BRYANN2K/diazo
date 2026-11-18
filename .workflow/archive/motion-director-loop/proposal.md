# Director loop v2 (backend)

## Problem

Animate work ran inside the ordinary resident loop under an inferred
"no progress" watchdog: a canvas-wide signature decided whether the last N
turns changed anything, and delivery was decided by generic progress, not by
the film. The two reviews (`/tmp/reviews/animate-astra-2.md`,
`/tmp/reviews/animate-turn-budget-3.md`) reproduced the failure modes:
regenerated ids defeated the signature, a film write completed an unrelated
ordinary card, equivalent paid filings billed twice, a no-op save delivered,
and a live job wait was read as a stall.

## Scope

M0-BE of `/tmp/plans/motion-pro-master.md` §3: a staged Animate run owned by
the server — `plan → build → refine × P → finish` — with per-stage and run
call budgets the model can see, gate-checked `end_stage`, paid filing
idempotency, metered `wait_for_job`, machine rubric from `check_scene`, pass
restore on regression, and a server-computed delivery verdict. Animate cards
are isolated from ordinary card queues; ordinary design runs keep their 24 /
40 turn behavior unchanged. Small API/UI wiring only: the existing Animate
button sends the kind and page metadata.

## Decisions and open questions

- Branch `feat/motion-director-loop` is based on `origin/feat/motion-elements-p0`
  because `origin/dev` does not yet contain `shared/motionElementPresets.ts`
  (flagged in the report).
- The base had no `shared/canonicalJson.ts`; it was added (key-sorted
  stringify) and flagged.
- The migration is numbered 0085; 0083/0084 were left free for the branches
  that own them, matching the renumber precedent of commit `3cb86bb8`.
- `end_stage` is resident-only; `wait_for_job` is on MCP and resident.
