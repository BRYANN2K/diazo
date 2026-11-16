# 0005. Use an embedded PGlite when no database is configured

One architecture decision for Diazo. Read by anyone, human or agent, about to change data storage or the local install.

## Status

Accepted, 2026-11-14.

## Context

`bun run dev` must work with no external service, and the local Mac install runs one container with no Postgres beside it. The server already speaks Postgres through drizzle.

## Decision

Without `DATABASE_URL`, the server uses `@electric-sql/pglite` with its files in `data/pg` (in the container `/app/data/pg`), and uploads in `data/assets`. With `DATABASE_URL`, it uses real Postgres 16. Migrations are the same and run at boot.

## Alternatives rejected

- SQLite. Rejected: a second SQL dialect and a second migration set.
- Always require Postgres. Rejected: the local install would need a second container and more setup.

## Consequences

- Good: one command starts a working server; the local install is one container.
- Bad: PGlite is single-process and slower on big canvases; hosted instances should use Postgres.
