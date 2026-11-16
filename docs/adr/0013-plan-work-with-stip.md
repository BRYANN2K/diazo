# 0013. Plan and track work with Stip

One architecture decision for Diazo. Read by anyone, human or agent, about to change how work is planned, specified or verified.

## Status

Proposed, updated 2026-11-16.

## Context

Work was planned in `.context/specs/` and `.context/plans/`, an upstream convention, with status kept by hand in the files and an index lint. Nothing tied a plan to approval or to evidence. Bryan's other projects use Stip.

## Decision

Every change lives in `.workflow/changes/<id>/` (proposal, spec with `AC-n` criteria, optional tasks, evidence, state) and goes through stip-explore, validate, apply, check, docs and archive. Accepted behaviour lives in `.workflow/specs/`. The old specs are migrated there as prose contracts; the old plans are archived by hand with a note.

## Alternatives rejected

- Keep `.context/`. Rejected: no approval or evidence step, and a second convention beside Bryan's other repositories.
- OpenSpec, as in Cartouche. Rejected: Stip is Bryan's own workflow and the one his newer projects use.

## Consequences

- Good: one change per branch, with approval and evidence on record.
- Bad: migrated specs have no `AC-n` lines until a change targets them.
- Bad: in-flight branches predate Stip, so their changes start as drafts that need approval and a check.

## Links

[.workflow/project.md](../../.workflow/project.md).
