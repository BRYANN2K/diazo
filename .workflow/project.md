# Diazo — project map

Repository: `BRYANN2K/diazo` (formerly `BRYANN2K/redoop`). Product: **Diazo**, a free, self-hosted design canvas for builders whose AI agents design screens and then write the code. Built-in agent: the **Diazo Agent** (`@diazo`). Started on 2026-11-12 as a fork of doop (`kgoedecke/doop`, AGPL-3.0) and now its own project. Not commercialised.

## Intent

A canvas holds frames that render real HTML. People edit in the browser or the desktop app; agents edit through the built-in MCP server; everyone sees the same room live. Diazo adds what builders need around that canvas: design libraries, checks, run history and duels, the link from a frame to the code in a repo, and next a timeline (Motion Studio). Product intent: [docs/PRD.md](../docs/PRD.md). Architecture: [docs/TRD.md](../docs/TRD.md). Decisions: [docs/adr/README.md](../docs/adr/README.md).

## Map and evidence

| Area                                                      | Status                                                            | Evidence / decision                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Web app (React, Vite, Tailwind 4, zustand)                | established                                                       | `src/`; design rules in `docs/DESIGN.md`; Storybook in `.storybook/`                                                                      |
| Server (Express, `ws` rooms, MCP at `/mcp`, better-auth)  | established                                                       | `server/`; `docs/TECHSTACK.md`; `docs/doop-reference.md`                                                                                  |
| Data (Postgres or PGlite, drizzle migrations at boot)     | established                                                       | `server/db/`; ADR 0005                                                                                                                    |
| Desktop shell (Tauri; Chromium/CEF on macOS, WebKit else) | established                                                       | `desktop/`; `desktop/README.md`; ADR 0007                                                                                                 |
| CLI (`diazo`, alias `doop`)                               | established                                                       | `cli/`; `docs/cli.md`                                                                                                                     |
| Design system and UI primitives                           | established; redesign in flight                                   | `src/components/ui/`, `src/styles.css`, `docs/DESIGN.md`; change `frontend-redesign`                                                      |
| Accepted behaviour specs                                  | incomplete                                                        | `.workflow/specs/`: migrated from `.context/specs/`, prose contracts without `AC-n` lines yet                                             |
| Automated tests                                           | established                                                       | `tests/` (vitest, browser tests in Chromium); CI runs them in four shards                                                                 |
| CI and delivery                                           | established                                                       | `.github/workflows/ci.yml`, `docker.yml`, `desktop.yml`, `desktop-release.yml`; `docs/RELEASE.md`                                         |
| Hosted instance (k3s on the VPS, Tailscale only)          | established                                                       | `deploy/k3s/`; `docs/runbooks/k3s-deploy.md`; ADR 0004                                                                                    |
| Motion Studio (Rostrum)                                   | incomplete: backend phases 0–1 on a branch, UI in the redesign    | changes `motion-studio`, `motion-studio-backend`                                                                                          |
| Orca integration                                          | missing: proposal only                                            | change `orca-integration`                                                                                                                 |
| iOS app (`ios/`), browser and editor plugins              | inferred: inherited from upstream, not maintained by the fork yet | `ios/`, `chrome-extension/`, `claude-extension/`, `cursor-plugin/`, `chatgpt-plugin/`; `ios-release.yml` needs upstream's signing secrets |
| Product analytics                                         | not-applicable by default                                         | PostHog is off unless `VITE_POSTHOG_KEY` is set at build time; `docs/PRIVACY.md`                                                          |
| Billing                                                   | inferred: inherited, unused                                       | Stripe Team plan code from upstream (`server/billing.ts`); Diazo is not sold (ADR 0003)                                                   |

## Conventions

- TypeScript strict, Prettier (no semicolons, single quotes, 120 columns), oxlint plus a thin ESLint layer. Details in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Conventional Commits with lowercase subjects, enforced by commitlint. PR titles too.
- Branches `feat/*`, `fix/*`, `docs/*`, `chore/*` → PR into `dev` → `staging` → `main` (ADR 0006).
- Internal identifiers keep the old name (`data-doop-*`, `DOOP_*`, `doop:` keys, tables, MCP tool names, `doop://`). Only what a user sees says Diazo (ADR 0002).
- Code, commits and technical docs in English.
- Work is planned with Stip: one change per branch in `.workflow/changes/<id>/`.

## Commands

- `bun install` — install dependencies and the git hooks.
- `bun run dev` — server and web app with an embedded PGlite.
- `bun run typecheck` — `tsgo --noEmit`, exits 0.
- `bun run lint` — oxlint then ESLint, zero warnings.
- `bun run format:check` — Prettier check.
- `bun run doc-lint` — docs layout and relative links.
- `bun run test` — the full vitest suite (slow; CI shards it).
- `bunx vitest run tests/<file>.test.ts` — one test file.

## Extensions

Enabled because the repository has matching code: frontend-engineering, backend-engineering, desktop-engineering, ai-engineering, security-engineering, design-system, database-engineering, devops-delivery, release-management, accessibility, ux-design, cli-tooling. A change selects only the ones it touches.

## History

The work before Stip was planned in `.context/specs/` and `.context/plans/`. Built work is recorded under `.workflow/specs/` and `.workflow/archive/` (manual migration, see each `archive-note.md`); work in flight is under `.workflow/changes/`. The upstream merge log and the dropped PR are in [docs/runbooks/upstream-resync.md](../docs/runbooks/upstream-resync.md).
