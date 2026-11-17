# Diazo product requirements

What Diazo is, who it is for, and what it must do. Read by Bryan and by agents before they write a change proposal.

Status: active, updated 2026-11-16

## Problem

- Builders now ask AI agents to design screens and then write the code, but the design lives in a tool the agent cannot edit, and the code drifts from it the day it ships.
- Design tools draw vectors. An agent writes HTML. Turning one into the other loses the real fonts, states and layout.
- A solo builder pays for a hosted design tool per seat and keeps their designs, uploads and model keys on someone else's server.
- The agent's work is invisible: no record of what a run cost, what it changed, or how two models compare on the same brief.
- Design kits pile up across canvases with duplicates, and nobody, human or agent, can find the right block quickly.
- Product films and UI motion specs are made in another tool, and stop following the design.

## Users

- **Builder.** A developer or product engineer who designs with agents and ships the code; usually alone, on a Mac. The primary user.
- **Coding agent.** Claude Code, Codex, Cursor, Devin or any MCP client that reads and writes the canvas as the person it acts for.
- **Diazo Agent.** The built-in agent that answers a brief on the canvas with a plan, then designs.
- **Collaborator.** Someone invited to a canvas or a workspace to view, comment or edit.
- **Instance admin.** The person who runs a Diazo server: locally, in Docker, or on a VPS.

## Goals

- G1: A frame is real HTML that people and agents edit together in real time, with the same plumbing for both.
- G2: Diazo runs on the user's own machine or server; canvases, uploads and keys stay there.
- G3: Any MCP agent can work on the canvas as the person who connected it, and the built-in agent runs on accounts the user already pays for.
- G4: A design flows into the repo: tokens, components and exports land as reviewed patches, and drift between design and build is visible.
- G5: Agent work is accountable: every run records its cost, time and changes, and can be replayed, rolled back or compared in a duel.
- G6: A design library is searchable by people and agents, and says when something already exists.
- G7: A page can become a film whose every pixel is a function of time (Motion Studio).

## Non-goals

- NG1: Diazo is not sold. No paid plan, no hosted SaaS run by the project (ADR 0003).
- NG2: No public exposure of the owner's instance: no ingress, no tunnel, no Funnel (ADR 0004).
- NG3: No doop branding in anything a user sees (ADR 0002).
- NG4: Not a vector illustration tool and not a general video editor; generated video and 3D are layers on the HTML spine.
- NG5: No server-side storage of a linked repo's files; the desktop app reads them on the user's machine.

## Scope

Order and status live in [ROADMAP.md](ROADMAP.md).

| Area              | Release                       | What the user gets                                                                                    |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Canvas and frames | current (from doop)           | Live HTML frames, pages, components, tokens, prototypes, comments, versions, share links              |
| Agents            | current                       | MCP server with OAuth and agent keys; the Diazo Agent on the user's own model accounts or local CLIs  |
| Plan-first chat   | current                       | A brief gets a plan card to approve before anything is designed                                       |
| Design libraries  | current                       | Libraries of items and variants, ⌘F everywhere, gallery, AI curation, duplicate checks                |
| Checks            | current                       | Anti-slop lint and responsive and accessibility checks per frame                                      |
| Runs              | current                       | Usage meter, run replay and rollback, model duel                                                      |
| Code              | current                       | Linked local project, code mapping, token sync, frame → React or Astro, Built page, drift review, CLI |
| Install           | current; all-in-one in flight | Desktop app, local server, Docker image, k3s; update check                                            |
| Redesign          | in flight                     | The Cyanotype bench UI                                                                                |
| Motion Studio     | in flight (phases 0–1)        | A timeline on a page, storyboard to film, MP4 and WebM export                                         |
| Orca integration  | proposed                      | Ready-for-dev frame → Orca worktree and coding agent, with live status                                |

The full feature list is in [FEATURES.md](FEATURES.md).

## Key user flows

### Design with an agent

1. The builder opens a canvas and connects their agent (`claude mcp add --transport http diazo <server>/mcp`) or types a brief in the Chat tab.
2. The Diazo Agent answers with a plan card; the builder approves it.
3. The agent streams frames onto the canvas while everyone watches; checks and lint run on each frame.
4. The builder compares models with a duel when unsure, and keeps the pick.

### Ship a design into the repo

1. The builder links the canvas to a project folder in the desktop app.
2. Tokens sync both ways and components are mapped to files.
3. A frame marked ready for dev exports as a component, written only after a native dialog shows the diff — or launches an Orca dev task, which reads its brief over MCP.
4. A preview deploy lands on the Built page beside its design, with a drift score.

### Reuse from a library

1. The builder turns a canvas into a library, or organises several with AI.
2. ⌘F finds an item across libraries and previews it live.
3. Insert places a scoped copy; Diazo says when the item is already in a library.

## Success measures

| ID  | Measure                                                     | Target                         | Verified by                                             |
| --- | ----------------------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| M1  | A new Mac reaches a signed-in canvas on a local server      | one command                    | `.workflow/changes/mac-all-in-one-install/spec.md` AC-1 |
| M2  | A film made from three frames exports without leaving Diazo | 15 s film, MP4 or WebM         | `.workflow/changes/motion-studio/spec.md` AC-2          |
| M3  | ⌘F answers from a large library                             | 10,000 items within the budget | `.workflow/specs/design-libraries.md` (budget tests)    |
| M4  | Every agent run is accounted for                            | tokens, time and cost recorded | usage meter tests; no spec yet                          |

## Principles

- Humans and agents go through the same actions layer; nothing an agent does is invisible to the room.
- An agent never writes to the user's repo or machine without a native confirmation that shows what changes.
- Costs are the user's own (their model accounts, their GPU) and are shown, never hidden.
- Agent activity is shown in the agent colour with a mark, never by colour alone.

## Open questions

- Q1: Does the fork keep the iOS app, the Chrome extension and the editor plugins it inherited, or retire them? — blocks: nothing.
- Q2: Is the inherited Team plan (Stripe) removed, or kept dormant? — blocks: nothing.
- Q3: Does the fork still resync from upstream doop, or only cherry-pick? — blocks: nothing. See [runbooks/upstream-resync.md](runbooks/upstream-resync.md).

## Related docs

- Architecture: [TRD.md](TRD.md)
- Plan and status: [ROADMAP.md](ROADMAP.md)
- Decisions: [adr/README.md](adr/README.md)
- Accepted behaviour: `.workflow/specs/`
