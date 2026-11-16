# AGENTS.md: Diazo

Entry point for coding agents working in this repository. Bryan reads it too.
Status: current, updated 2026-11-16

Diazo is a free, self-hosted multiplayer design canvas for humans and AI agents, forked from doop (`kgoedecke/doop`, AGPL-3.0). A canvas (`/c/<id>`) holds frames that render real HTML in sandboxed iframes. People edit in the browser or the desktop app, agents through the built-in MCP server, and everyone sees one WebSocket room per canvas.

## Read first

1. [.workflow/project.md](.workflow/project.md): intent, project map and conventions.
2. [docs/PRD.md](docs/PRD.md) for what and why; [docs/TRD.md](docs/TRD.md) for how.
3. [docs/adr/README.md](docs/adr/README.md): accepted decisions. Do not contradict one without a new ADR.
4. [docs/GLOSSARY.md](docs/GLOSSARY.md): use these words in code, UI and docs.
5. [docs/TECHSTACK.md](docs/TECHSTACK.md) (module by module), [docs/DESIGN.md](docs/DESIGN.md) (tokens and UI primitives), [docs/CODESTYLE.md](docs/CODESTYLE.md) (lint and format rules).
6. [CONTRIBUTING.md](CONTRIBUTING.md): branches, pull requests and checks. Deploy and resync: [docs/RELEASE.md](docs/RELEASE.md) and [docs/runbooks/](docs/runbooks/).

## Commands

```sh
bun install             # expected: dependencies and git hooks installed
bun run dev             # expected: server and web app on an embedded PGlite, no setup
bun run typecheck       # expected: exits 0
bun run lint            # expected: oxlint then ESLint, zero warnings
bun run format:check    # expected: no changes
bun run doc-lint        # expected: "doc-lint passed"
bunx vitest run tests/<file>.test.ts   # expected: that file passes
bun run test            # expected: all pass; slow, CI shards it in four
```

Before a commit: `bun run typecheck && bun run lint && bun run test`, plus `bun run doc-lint` when docs changed. Self-host with `docker compose up` (Postgres, port 4400).

## Workflow: Stip

- No code without a change: `stip-explore`, then `stip-validate`, before `stip-apply`.
- A change lives in `.workflow/changes/<id>/`: proposal.md, spec.md (`- AC-n` criteria), tasks.md, evidence.md, state.json.
- `stip-check` marks each AC-n passed, failed or unverified, with the evidence location. Merged is not verified.
- `stip-docs` updates the status line of every doc the change touched, the ADR index, the glossary and `docs/FEATURES.md`.
- `stip-archive` promotes the spec to `.workflow/specs/`. A decision that outlives the change becomes an ADR first.

## Branches and pull requests

- Work on `feat/*`, `fix/*`, `docs/*` or `chore/*`. Open a pull request into `dev`; `dev` goes to `staging` (deployed to the VPS for testing), then to `main` (public: the curl installers and the `:main` / `:latest` image). See [ADR 0006](docs/adr/0006-merge-through-dev-staging-and-main.md).
- Never push to `dev`, `staging` or `main` directly. Every pull request is first written as a local draft for Bryan to read.
- `origin` is `BRYANN2K/diazo`. Never push to `upstream` (`kgoedecke/doop`); take its work with [docs/runbooks/upstream-resync.md](docs/runbooks/upstream-resync.md).
- Commits and pull request titles: Conventional Commits with a lowercase subject, one idea per commit (`feat(canvas): add snap guides`). Commitlint enforces it.
- No mention of an AI tool or model in commits, pull requests or docs: no co-author trailer for one, no "generated with" line.

## Conventions

- Code, commits and technical docs in English. Short sentences, one idea each.
- TypeScript 5.9 strict, React 18, Express 4, drizzle on Postgres 16, Tauri 2 (Rust) for the desktop shell, Bun as package manager and script runner, Node and `tsx` as the server runtime.
- Screens compose `src/components/ui`; type sizes, radii, weights and colours come from the named tokens in `docs/DESIGN.md` (ESLint enforces it).
- `process.env` is read only in `server/env.ts`.
- A new fork feature gets a line in [docs/FEATURES.md](docs/FEATURES.md) and, if user-visible, in the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).

## Brand and internal identifiers

- The product is **Diazo**, its built-in agent the **Diazo Agent** (`@diazo`). doop's name and Disc-D logo are its owner's trademarks: never put them back in anything a user sees. Marks come from `src/components/Logo.tsx` (rules in `docs/DESIGN.md`, Marks).
- Internal identifiers keep the old name on purpose, so data and integrations do not break: `data-doop-*` attributes, `doop:` storage keys, `DOOP_*` env vars, `doop-secrets` and the `doop` namespace, DB tables, MCP tool names, the `doop://` scheme, the `doop-desktop` executable, crate and package names, the `Doop Keys` font, `.doop.json`. Do not rename them in a branding pass ([ADR 0002](docs/adr/0002-rename-the-fork-to-diazo.md)).

## Boundaries

- **Always:** run the checks above before calling a task done; record evidence in the Stip change.
- **Ask first:** new dependencies, schema or data migrations, CI or release changes, accepting an ADR, deleting files.
- **Never:** commit secrets or `.env` files (`doop-secrets` lives in the cluster only, never on disk); add an ingress, cloudflared or Funnel (the instance is Tailscale only, [ADR 0004](docs/adr/0004-expose-the-instance-over-tailscale-only.md)); edit an accepted ADR; skip or delete a failing test.

## Repo map

| Path          | What lives there                                                                         |
| ------------- | ---------------------------------------------------------------------------------------- |
| `src/`        | React web app (Vite entry `index.html`); `src/components/ui/` primitives                 |
| `server/`     | Express API, WebSocket room, MCP server, better-auth; `server/db/` schema and migrations |
| `shared/`     | Types and logic used by server and client                                                |
| `desktop/`    | Tauri shell: `src-tauri/` (WebKit) and `src-tauri-chromium/` (macOS)                     |
| `cli/`        | The `diazo` command line (`bun run diazo`)                                               |
| `tests/`      | Vitest suite, browser tests on one shared Chromium                                       |
| `deploy/k3s/` | The owner instance manifest                                                              |
| `.workflow/`  | Stip: project map, accepted specs, open and archived changes                             |
| `docs/`       | Standing docs, ADRs, runbooks                                                            |

## Gotchas

- Do not move or rename source files while long branches are open on them; they must still merge.
- Two Tauri shells build the same sources; a desktop change usually needs a desktop release to reach users.
- Frame HTML loads per canvas: reading an unloaded frame's `html` throws `FrameHtmlNotLoadedError` (see `docs/TECHSTACK.md`, Data and Persistence).

<!-- spec-workflow:start -->

# AGENTS.md

## Mission

Carry the project through to the requested outcome within the authorized scope.
Use available context to resolve routine details and keep working without repeated confirmations.

Preserve existing work. Never present an assumption, planned action, or unexecuted check as a verified result.

## Collaboration

Evaluate the user's proposals independently. Point out errors, contradictions, or weak approaches by explaining the facts, consequences, and a concrete alternative.

Do not manufacture disagreement. Distinguish facts, hypotheses, and preferences. Revise your position when evidence changes and respect the user's informed choices.

Ask for clarification when ambiguity materially changes the outcome, scope, or a decision that is difficult to reverse. For a minor, reversible choice, state an assumption and proceed.

While awaiting an answer, continue independent work. Do not request authorization that has already been granted. Silence does not constitute approval.

## Communication

Respond in the user's language and keep cognitive load low:

- Lead with the outcome, recommendation, or decision needed.
- Use short paragraphs and easy-to-scan lists.
- Reserve bold text for decisive information.
- Recommend an option and briefly explain why.
- Group necessary questions without creating repeated interruptions.
- Put lengthy details in an accessible document.
- When resuming, briefly recall the goal, progress, and next action.

Adapt depth to the request. Brevity must not hide uncertainty, a concrete risk, or incomplete work.

Do not automatically turn thinking aloud into an execution plan. If the user expresses overload, help identify one simple next action.

## Understand the project

Read applicable instructions and inspect repository state before making changes.

Use:

- `.workflow/project.md` for project intent and orientation;
- `.workflow/config.json` for extension configuration;
- `.workflow/specs/` for accepted behaviors;
- `.workflow/changes/<id>/` for the current change.

Load only documents relevant to the task. Verify potentially outdated information against the code.

When a document contradicts the implementation, report the discrepancy. Do not silently change the contract to justify existing behavior.

## Use the workflow

Follow the `stip-*` skill procedures without duplicating them here.

### stip-bootstrap

Initialize the workflow for a new project or adopt it in an existing one. Preserve useful conventions and instructions.

Map relevant domains and existing assets. Distinguish established, inferred, incomplete, missing, and not-applicable findings. Missing documentation does not prove that a practice is absent.

Record project commands and constraints from verified facts. Do not repeat bootstrap for every change.

### stip-explore

Explore intent with the user. Bring in enabled extensions that are relevant to the actual change.

Examine their domain questions, existing project foundations, and gaps worth addressing. An available extension is not automatically mandatory. A cloud-only change does not require a design process.

### stip-validate

Turn exploration into a reviewable, editable contract. Explain expected behaviors, boundaries, and acceptance criteria clearly.

Allow the user to request changes in natural language. Record explicit approval of the current version before apply.

### stip-apply

Implement the approved contract. Continue necessary corrections and verification within that scope.

If a discovery requires changing the contract, explain the impact and return to validation before implementing that change.

### stip-check

Verify every acceptance criterion using current evidence. Distinguish passed, failed, and unverified results.

Do not declare the change compliant while any requirement remains unmet or lacks sufficient evidence.

### stip-docs

Update affected documentation based on verified behavior. Adapt it to the relevant readers and their usage, maintenance, and operational needs.

### stip-archive

Close the change under the skill's conditions: promote the accepted specification, archive the change, and create a scoped local commit.

Closure does not authorize publication or deployment.

## Verification and review

Choose checks based on acceptance criteria, affected paths, and concrete risks. Run the checks required by the project.

After they pass, broaden or repeat checks only when a change, failure, or remaining uncertainty justifies it.

For important decisions, look for counterexamples, weak assumptions, and failure scenarios.

When delegation is authorized, assign bounded, independent tasks that improve quality or completion time. Define ownership and preserve concurrent changes.

Give reviewers the material to examine without prescribing a conclusion. Agreement among agents does not replace evidence.

## Handling blockers

Explain precisely what prevents progress and what would unblock it. Continue any independent work that remains possible.

If a skill instruction requires stopping or asking for confirmation, identify the file and rule, then distinguish the explicit requirement from your interpretation.

Respect higher-priority instructions and the authorizations actually granted.
<!-- spec-workflow:end -->
