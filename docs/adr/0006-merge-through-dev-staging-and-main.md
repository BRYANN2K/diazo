# 0006. Merge through dev, staging and main by pull request

One architecture decision for Diazo. Read by anyone, human or agent, about to change branches, CI or the release path.

## Status

Accepted, 2026-11-16.

## Context

`main` is public: the curl installers read scripts from it and the `:main` / `:latest` image is built from it. Changes were landing on `main` directly, so a broken commit reached every installer at once and there was no place to test on the VPS first.

## Decision

Work happens on `feat/*`, `fix/*`, `docs/*` or `chore/*` branches. A branch goes by pull request into `dev`; `dev` goes into `staging`, whose image `:staging` the VPS runs for testing; `staging` goes into `main`. Nothing is pushed directly to `dev`, `staging` or `main`. Each pull request is shown to Bryan as a local draft first. CI runs on all three branches and on every pull request (PR #7).

## Alternatives rejected

- Trunk on `main` with feature flags. Rejected: `main` is what installers fetch, so it must only move after a test on the VPS.
- `main` plus release tags only. Rejected: no environment to try a build before users get it.

## Consequences

- Good: a broken build stops at `staging`.
- Bad: three merges per change; long-lived branches must be rebased onto `dev`.

## Confirmation

Branch protection on `dev`, `staging` and `main`; [CONTRIBUTING.md](../../CONTRIBUTING.md).
