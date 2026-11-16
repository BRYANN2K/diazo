@.context/INDEX.md

This is a placeholder. Will need to be updated.
https://github.com/kgoedecke/doop

# Diazo

Diazo (this fork of doop, `kgoedecke/doop`) is a multiplayer design canvas for humans and AI
agents. Every design lives on a shareable Canvas (`/c/<id>`) holding Frames - artboards that
render real HTML in sandboxed iframes. People edit in the browser; AI agents edit through the
built-in MCP server, streaming designs in live. Everyone sees cursors, presence, frame edits, agent
status, and an activity feed in realtime over one WebSocket room per canvas.

## Fork rules (BRYANN2K/diazo)

- Branches: `feat/*` (or `fix/*`, `docs/*`…) → PR into `dev` → `staging` (deployed to the VPS for
  testing) → `main` (public: the curl installers and the `:main` / `:latest` image). Nothing is
  pushed to `dev`, `staging` or `main` directly, and every PR is shown to Bryan as a local draft
  first. Never push to `upstream` (`kgoedecke/doop`); `origin` is `BRYANN2K/diazo` (formerly
  `BRYANN2K/redoop`).
- Read `FORK.md` first: merged and dropped upstream PRs, the resync recipe, the k3s deploy.
- The fork's own features are listed in `docs/FEATURES.md` (the README's "What it does" sums them
  up). Update it when you add one. The project is presented as **Diazo**, its built-in agent as
  the **Diazo Agent** (`@diazo`). doop's name and Disc-D logo are its owner's trademarks: never put
  them back in anything a user sees. Marks come from `src/components/Logo.tsx` (rules in
  `.context/DESIGN.md`, Marks).
- Internal identifiers keep the old name on purpose, so data and integrations do not break:
  `data-doop-*` attributes, `doop:` storage keys, `DOOP_*` env vars, `doop-secrets` and the `doop`
  namespace, DB tables, MCP tool names, the `doop://` scheme, the `doop-desktop` executable, crate
  and package names, the `Doop Keys` font, `.doop.json`. Do not rename them in a branding pass.
- The instance is Tailscale only (`tailscale serve`, k3s `ClusterIP`). Never add an ingress,
  cloudflared or Funnel.
- Never write secrets into the repo or to disk; `doop-secrets` lives in the cluster only.
- Before a commit: `bun run typecheck && bun run lint && bun run test`.

## Tech stack

TypeScript/React/Express/Postgres (drizzle), realtime over `ws`, MCP server for agent access, Tauri
desktop shell. Full details in `.context/TECHSTACK.md`, which `.context/INDEX.md` links.

Always use the `clean-code:typescript` skill when writing or reviewing TypeScript code in this
repo.

## First-time setup after clone

```bash
bun install
bun run dev   # zero-config: embedded Postgres (pglite), server + web concurrently
```

Or self-host via Docker: `docker compose up` (real Postgres, port 4400).

## Project layout

```
src/               - React frontend (Vite entry: index.html)
src/components/ui/ - shadcn-generated UI primitives
src/pages/         - route-level pages
src/hooks/         - React hooks
src/lib/           - client-side utilities
server/            - Express backend, WebSocket room, MCP server, better-auth
server/db/         - drizzle-orm schema (schema.ts, auth-schema.ts) and migrations
shared/            - types/utilities shared between server and client
desktop/           - Tauri desktop app wrapper
cli/               - the `diazo` command line (`bun run diazo`, `doop` kept as an alias; talks to /mcp)
desktop/src-tauri/ - Rust side of the desktop app
scripts/           - repo maintenance scripts
tests/             - vitest test suite
```

## Language

TypeScript. Always use the `clean-code:typescript` skill when writing or reviewing TypeScript
code. Formatter and lint rules are captured in `.context/CODESTYLE.md`, which `.context/INDEX.md`
links.

@AGENTS.md
