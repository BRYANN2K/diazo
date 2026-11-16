# Diazo technical requirements and architecture

How Diazo is built, what it depends on, and what limits it. Read by Bryan and by agents before they design or review a change.

Status: active, updated 2026-11-16

Intent is in [PRD.md](PRD.md), decisions in [adr/](adr/README.md), accepted behaviour in `.workflow/specs/`, status in [ROADMAP.md](ROADMAP.md). The module-by-module reference, with every library version and test name, is [TECHSTACK.md](TECHSTACK.md).

## Constraints

- **AGPL-3.0, inherited from doop.** Every change stays AGPL; a network user can get the source. See [ADR 0003](adr/0003-keep-agpl-and-stay-non-commercial.md).
- **No doop marks.** User-facing text and art say Diazo; internal identifiers keep `doop`. See [ADR 0002](adr/0002-rename-the-fork-to-diazo.md).
- **Tailscale only for the owner's instance.** The k3s Service is `ClusterIP`, exposed by `tailscale serve`; no ingress, cloudflared or Funnel. See [ADR 0004](adr/0004-expose-the-instance-over-tailscale-only.md).
- **Zero-config local run.** Without `DATABASE_URL` the server uses an embedded PGlite. See [ADR 0005](adr/0005-use-pglite-when-no-database-is-configured.md).
- **No paid signing.** The macOS app is ad-hoc signed and installed by a curl script; updates are signed with the fork's own minisign key. See [ADR 0007](adr/0007-ship-the-desktop-app-from-our-own-releases.md).
- **Secrets never on disk in the repo.** Instance secrets live in env files the installers generate or in the cluster's `doop-secrets`.

## Quality goals

1. **Live collaboration:** a frame edit, human or agent, reaches everyone in the room through one broadcast path, with no full-document reload of the frame.
2. **Agent safety:** an agent acts with the permissions of the person who connected it; writes to a repo or the machine go through a native confirmation.
3. **Big canvases stay usable:** canvases of 5,000+ frames open on one page and lazy-load the rest; off-screen frames are culled or drawn as images.
4. **Renderer resilience:** headless Chromium work is gated, queued and bounded; a wedged browser is killed and retried.
5. **Deterministic motion:** a composition's frame at time t is a pure function of t.

## Architecture

```
person (browser / Diazo.app) ──ws + REST──┐
coding agent (MCP client) ───── /mcp ─────┤
                                          ▼
                    server (Node, tsx, one process on :4400)
                    Express REST · ws rooms · MCP · better-auth
                    store (in-memory canvases, write-through)
                      │            │              │
               Postgres/PGlite   assets       headless Chromium
               (drizzle)         (disk or S3)  (local or remote CDP)
                      │
     model providers (Anthropic, OpenAI, Gemini, OpenRouter…) on the user's accounts
     desktop shell ─ device bridge ─ local repo, local CLIs (Claude, Devin, Grok), ffmpeg, Blender
```

### Web app (`src/`)

React 18, Vite, Tailwind 4 and zustand. `src/components/ui/` holds every styled primitive; screens compose them. Frames render in `<iframe sandbox="allow-scripts">`; new HTML is posted in and DOM-morphed in place (`src/lib/frameRuntime.ts`). The design rules are in [DESIGN.md](DESIGN.md).

### Server (`server/`)

Express REST API, one WebSocket room per canvas, presence and the activity feed (`server/index.ts`). `server/store.ts` keeps canvases in memory and writes through to the database; frame HTML loads per canvas and is evicted when idle. `server/actions.ts` is the shared mutation layer: every REST, room and MCP write goes through it, so humans and agents get identical broadcasts. `server/mcp.ts` serves the MCP server over streamable HTTP at `/mcp`; `server/resident.ts` is the Diazo Agent. It must never trust page-supplied paths or run commands on the host.

### Shared (`shared/`)

Wire types and pure logic used by both sides: the room protocol, prototypes, pages, libraries, motion.

### Desktop shell (`desktop/`)

Tauri. macOS ships the Chromium (CEF) build in `desktop/src-tauri-chromium`; Windows and Linux ship WebKit (`desktop/src-tauri`). The shell loads the web app from a chosen server and adds native commands the page asks for through capability markers (`__DOOP_*__`): sandboxed repo reads and one approved write path, local agents over ACP, live frames on loopback, the motion render, and later Blender and Orca. Details: `desktop/README.md`.

### CLI (`cli/`)

`bun run diazo` (alias `doop`). Talks to `/mcp` with an agent key; links a folder through `.doop.json`. See [cli.md](cli.md).

## Data stores

| Store            | Holds                                                        | Location / format                                                          | Owner       | Notes                                                                |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Database         | accounts, canvases, frames, versions, libraries, runs, tasks | Postgres 16 (`DATABASE_URL`) or PGlite in `data/pg`; `server/db/schema.ts` | server      | Migrations in `server/db/migrations`, applied at boot                |
| Sealed secrets   | model keys and tokens, integration tokens, webhook secrets   | `sealedText` columns, AES-256-GCM                                          | server      | Keys from `SECRETS_ENCRYPTION_KEYS`; losing them loses those secrets |
| Assets           | uploads, fonts, rendered media                               | `data/assets` on disk, or any S3-compatible bucket                         | server      | Served by unguessable id at `/a/<id>`                                |
| Local install    | env file and data                                            | `~/.diazo` (`diazo.env` mode 600, `data/`)                                 | user's Mac  | Older installs keep `~/.doop`                                        |
| Desktop app data | server choice, CLI config, browser profile                   | `~/Library/Application Support/dev.bryann2k.diazo`                         | desktop app | Copied once from `design.doop.desktop`, never deleted                |
| k3s instance     | Postgres volume, uploads volume                              | namespace `doop` on the VPS                                                | Bryan       | [runbooks/k3s-deploy.md](runbooks/k3s-deploy.md)                     |

## External dependencies

| Dependency                     | Used for                                | Pin / licence                   | If it fails                                               |
| ------------------------------ | --------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| Model providers                | the Diazo Agent, curation, descriptions | user's own accounts             | the agent reports the provider error; nothing else breaks |
| Chromium (local or remote CDP) | frame images, checks, PDF, imports      | Puppeteer; `REMOTE_BROWSER_URL` | `RendererBusyError` (503 + Retry-After)                   |
| GitHub REST API (anonymous)    | update check                            | ≤ 2 requests an hour            | state `unknown`; nothing else breaks                      |
| GitHub Releases                | desktop updates and installer           | `desktop-updates` prerelease    | the app keeps its version                                 |
| SMTP (optional)                | verification, reset, comment mail       | any provider                    | without it, sign-up is not verified                       |
| Pexels, Brandfetch (optional)  | photo and logo search for agents        | API keys                        | the tool says it is off                                   |
| PostHog (optional, off)        | product analytics                       | build-time key                  | off by default                                            |
| MuPDF                          | PDF import                              | `mupdf` npm, AGPL-3.0           | PDF import fails with a message                           |

## Security and trust boundaries

- Frame HTML is untrusted: it runs in a sandboxed iframe with a CSP meta, never same-origin with the app. Saves with executable content from `doop:edited` are refused.
- MCP clients authenticate by OAuth (1 h access, 30-day refresh) or by agent keys; an agent acts as its owner and sees only what the owner can.
- Share links carry a role (view, comment, edit) enforced on REST, the room and MCP.
- Outbound webhooks and URL imports screen targets against private addresses.
- The desktop bridge exposes typed commands only, each with its own allowlist and native confirmation; no command passthrough.
- Secrets are never logged; sealed columns are never filtered on. See [../SECURITY.md](../SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Deployment and operations

- Image `ghcr.io/bryann2k/diazo`, amd64 and arm64, built by `docker.yml` on `staging` and `main`.
- Owner's instance: k3s on the VPS, Tailscale Serve, `DOOP_UPDATE_BRANCH=staging` for tests. Procedure: [runbooks/k3s-deploy.md](runbooks/k3s-deploy.md).
- Releases: [RELEASE.md](RELEASE.md).

## Phases

1. Motion Studio backend — the contract the redesign's Motion UI needs. Roadmap: `motion-studio-backend`.
2. Frontend redesign — replaces its motion adapter with the backend contract. Roadmap: `frontend-redesign`.
3. Orca integration — after the redesign settles the Inspector. Roadmap: `orca-integration`.

## Risks and technical debt

- Frame HTML in memory: about 12 GB of V8 heap for 6.4 GB of HTML on the largest instance (2026-11-09). Mitigated by lazy loading and idle eviction.
- Inherited surfaces the fork does not maintain: iOS app, browser and editor plugins, the Team plan. See PRD Q1 and Q2.
- Source comments and docs still say "doop" in places; user-facing ones are a bug, internal ones are intended.

## Open technical questions

- TQ1: Which Blender MCP server, after a licence check — blocks: `motion-studio` phase 4.
- TQ2: GSAP's licence clause on animation tools, before any HyperFrames import of GSAP timelines — blocks: `motion-studio` phase 5.
