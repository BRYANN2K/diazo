# Glossary

Plain definitions of the terms used in Diazo's code, UI, docs and specs. Read by contributors, agents and curious users.
Status: current, updated 2026-11-16

## How to use this glossary

- **One word per idea.** Code, UI, docs and commit messages use the term exactly as written here.
- If a term changes, rename it here first, then in code and docs in the same change.
- "Avoid" lists words that mean the same thing and must not be used. Agents replace them on sight.
- Define the term in the project's sense, not the dictionary's. Internal code names may keep `doop` ([ADR 0002](adr/0002-rename-the-fork-to-diazo.md)); the UI never does.

## Canvas and design

**Canvas.** A shareable board at `/c/<id>` that holds pages of frames, its tokens, components, guidelines and comments. One WebSocket room per canvas carries its live state.
Avoid: board, file, document.

**Page.** One sheet of a canvas, with its own frames, background colour and prototype flow start. A page can also carry a composition.

**Frame.** An artboard that renders a complete HTML document in a sandboxed iframe. People and agents edit the same HTML.
Code: `Frame`, `frames` table. Avoid: artboard (in UI copy), screen.

**Frame preview.** A stored picture of a frame at a dashboard size or a canvas width bucket. It stands in for a live document when a frame is too small to edit. A stale preview shows an older design while the current picture renders.

**Element.** A node inside a frame's HTML, addressed by its `data-doop-id` for picks, comments, links and keyframes.

**Component.** One design used in many places: a **main** and its **instances**, with props, enum variants, slots and overrides. Instances are materialized HTML kept in step by propagation. See `.workflow/specs/components.md`.
Code: `<doop-use>`.

**Token.** A typed design value (colour, spacing, radius, type scale…) stored per canvas and written into every frame as a CSS custom property. A **theme** gives a token a value per mode (light, dark…).
Code: `<style data-doop-tokens>`. Avoid: variable (in UI copy).

**Guideline.** A named style guide on a canvas (brand rules, style recipes) that every agent run reads in full.

**Skill.** Named know-how on a canvas with a "when to use it" line; agents load the matching skill on their own, or a person types `/name`.

**Reference.** A frame a person pinned as "more like this", or a library item attached to a plan card.

**Decision.** A design preference an agent saved on the canvas (`save_decision`), so later runs follow it. A duel's pick is kept as a decision.

**Prototype.** Interaction data attributes in frame HTML (triggers, actions, transitions) played from the page's flow start at `/c/<id>/proto`.

**Version.** A snapshot of a frame's HTML taken before a redesign, stream or restore replaced it.
Code: `frame_versions`.

**Approval.** A person's sign-off that a frame is ready for development; any HTML or size edit clears it.
Code: `approvalStatus` (`draft`, `ready_for_dev`, `needs_review`).

## Libraries

**Library.** A canvas whose frames are indexed as items, searched by ⌘F and the agent tools, and browsed in its gallery at `/l/<id>`. See `.workflow/specs/design-libraries.md`.
Avoid: kit, design system (for the canvas itself).

**Item.** One entry of a library: a family of variants with a kind, a category and tags.
Code: `data-doop-item`. Avoid: asset, block (for the indexed entry).

**Variant.** One version of an item (size, state, style), shown side by side in the item view.
Code: `data-doop-variant`.

**Curation.** An AI pass over several canvases that folds duplicates and proposes one category tree, applied by a person into a new library.

## Agents

**Diazo Agent.** The built-in agent that works on the canvas when asked in the Chat tab or by `@diazo`. It plans first, then designs.
Code: `server/resident.ts` (the "resident agent"). Avoid: Doop Agent, assistant, bot.

**Agent.** Any MCP client acting on the canvas as the person who connected it: Claude Code, Codex, Cursor, Devin, the Diazo Agent.

**Runner.** The connection a Diazo Agent run uses: a provider account (Claude, OpenAI, Gemini, OpenRouter…), a ChatGPT subscription, or a local CLI through the desktop app. A **runner pick** is provider, model and effort for one run.
Code: `RunnerPick`, `/api/agent-runners`. Avoid: backend, engine.

**Local agent.** A CLI already installed and signed in on the user's computer (Claude Code, Devin, Grok) that the desktop app drives over ACP for a run. See [ADR 0008](adr/0008-run-local-cli-agents-over-acp-through-the-desktop-app.md).

**Agent key.** A token from Settings → Agent keys that lets a headless agent or the CLI act as its owner.
Code: `dpk_…`.

**Task.** One request to the Diazo Agent, shown as a card, with its status and result.

**Plan card.** The Diazo Agent's proposed plan for a brief, approved with Go before anything is designed.

**Run.** One execution of an agent task, recorded with its tokens, time, cost and the frame versions it wrote.
Code: `agent_runs`.

**Run replay.** The timeline of one run with each frame before and after, and a one-step rollback.

**Duel.** One brief sent to two or three runner picks at once, each designing into its own sibling frame, compared side by side.
Avoid: battle, A/B.

## Code

**Linked project.** A folder on the user's Mac linked to a canvas through the desktop app; agents can list, read and search it, and write only through an approved patch.

**Code link.** A mapping from a component or frame to a file and export in the linked project.
Code: `code_links`.

**Handoff.** The Stip change pack built from a frame marked ready for dev, written into the linked project after a native confirmation.
Code: `create_handoff`, `repo_write_change`.

**Built page.** A page that receives the routes of a preview deploy, each beside its designed frame with a drift score.

**Drift review.** A comparison of a frame with a live URL: pixel score, drift cards and a compare modal.

**Live frame.** A frame that shows a local dev server (`localhost` only) in the desktop app.

**Check.** A frame check: layout at 375, 768 and 1440 px and a keyboard walk (overflow, tap targets, contrast, focus).
Avoid: audit, test.

**Lint.** The anti-slop rules engine that scores every frame; motion adds `MO-*` rules for seek safety.

## Motion

**Composition.** The timeline of one page: duration, fps, output size, poster time and tracks. A film is a page with a composition. See [ADR 0009](adr/0009-store-one-motion-composition-per-page.md).
Code: `compositions`. Avoid: scene (the proposal's earlier word), project.

**Track.** One lane of a composition: camera, element, clip, audio or caption.

**Clip.** A timed block on a track: a frame shot, a library Motion item or a media asset.

**Seek-safe.** Markup whose look at time t depends only on t: no wall clock, timers, unseeded random or free-running animation.

**Rostrum.** The codename of Motion Studio in specs and branches. Not shown to users.

## Instance and access

**Instance.** One running Diazo server and its data: a local install, a Docker host, or the owner's k3s deployment.

**Workspace.** A group of people with shared access to canvases and libraries, with roles.

**Share link.** A per-canvas link with a role: view, comment or edit.

**Device.** A signed-in desktop app the server can ask to run a native command (repo read, local agent, render).

## Workflow

**Change.** One unit of planned work in `.workflow/changes/<id>/`: proposal, spec with `AC-n` criteria, tasks, evidence and state. See [ADR 0013](adr/0013-plan-work-with-stip.md).

**Spec.** Accepted behaviour in `.workflow/specs/<capability>.md`, promoted from a change at archive.

## Acronyms

- **ACP.** Agent Client Protocol. See **Local agent**.
- **MCP.** Model Context Protocol, served at `/mcp`. See **Agent**.
- **ADR.** Architecture decision record, in `docs/adr/`.
