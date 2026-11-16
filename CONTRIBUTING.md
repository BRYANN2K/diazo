# Contributing to Diazo

How to work on Diazo: how changes are planned, how a branch reaches `main`, and what a pull request needs. Read by contributors and agents.
Status: current, updated 2026-11-16

Diazo is an independent fork of doop, licensed AGPL-3.0. It keeps doop's code and credits its authors ([NOTICE](NOTICE)). It is not affiliated with doop and does not send pull requests to it.

## No contributor licence agreement

doop asks its contributors to sign a CLA. Diazo does not. A contribution to Diazo is licensed AGPL-3.0, like the rest of the code, and you keep its copyright ([ADR 0003](docs/adr/0003-keep-agpl-and-stay-non-commercial.md)).

## How work is planned

- Work is planned with Stip, in `.workflow/`. One change is one folder in `.workflow/changes/<id>/`: proposal, spec with `AC-n` acceptance criteria, tasks, evidence, state.
- Read [docs/PRD.md](docs/PRD.md) and [docs/TRD.md](docs/TRD.md) first. Decisions are in [docs/adr/](docs/adr/README.md). What is in flight is in [docs/ROADMAP.md](docs/ROADMAP.md).
- Open an issue before a large change. Do not start code for something that has no approved spec.

## Branches

- Branch from `dev`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>` or `chore/<topic>`.
- Open the pull request into `dev`. `dev` is merged into `staging`, which runs on the test instance; `staging` is merged into `main`, which is what the installers and the `:main` image ship ([ADR 0006](docs/adr/0006-merge-through-dev-staging-and-main.md)).
- Nobody pushes to `dev`, `staging` or `main` directly.
- Write the pull request first as a local draft and have the maintainer read it before it is opened.
- Do not move or rename source files while long branches are open on them.

## Commits

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/), with a lowercase subject. Commitlint checks them in a git hook and in CI.

```
feat(canvas): add frame snap guides
fix(server): close stale websocket rooms
docs(adr): record the font decision
```

Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `ci`, `chore`. One idea per commit.

## Checks

Run these before you ask for review. CI runs the same ones on every pull request and on `dev`, `staging` and `main`.

```sh
bun run typecheck      # tsgo, exits 0
bun run lint           # oxlint then ESLint; a warning fails like an error
bun run format:check   # Prettier
bun run doc-lint       # docs layout and relative links
bun run test           # the vitest suite; CI runs it in four shards
```

A pre-commit hook (husky and lint-staged) runs oxlint, ESLint and Prettier on staged files. The hooks install with `bun install`. Code style details: [docs/CODESTYLE.md](docs/CODESTYLE.md). UI rules: [docs/DESIGN.md](docs/DESIGN.md).

## Pull requests

- Write the description yourself, in plain words: one paragraph on why, short bullets on what changed, and how to review it.
- Say which acceptance criteria of the Stip change it covers and link its evidence.
- Keep the change inside its tasks. Every changed file should be explained by one.
- UI changes need screenshots in light and dark.
- A user-visible change adds a line to `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md); a new fork feature also goes in [docs/FEATURES.md](docs/FEATURES.md).
- Never commit a secret, a `.env` file or a key. Never rename an internal `doop` identifier (see [AGENTS.md](AGENTS.md)).

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Conduct

Be kind and direct. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
