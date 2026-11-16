<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/diazo/lockup-horizontal-dark.svg">
    <img src=".github/assets/diazo/lockup-horizontal.svg" alt="Diazo" width="300">
  </picture>
</p>

# Diazo

Diazo is a free, self-hosted design canvas for builders: people whose AI agents design the screens and then write the code. Frames are live HTML, humans and agents work on the same canvas in real time, and the design flows into your repo.

Diazo started as a fork of doop, the open-source multiplayer design canvas by Kevin Goedecke, and is now its own project. The desktop app and the server are in this repository. The live instance runs on its owner's server, reachable over Tailscale only.

**Status: alpha.** Expect missing features and breaking changes. Updated 2026-11-16.

## Install

Diazo runs on your own machine or your own server. Your canvases, uploads and keys stay there.

### All in one (Mac): the server and the app

```sh
curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install.sh | sh
```

Sets up the server on `127.0.0.1:4400` (Apple `container`, data in `~/.diazo`), starts it at every login, installs `Diazo.app` pointed at it, and opens the app on the sign-up screen: the first account is the admin. Needs Apple silicon, macOS 26 and `container` 1.0 or later; the script says where to get `container` when it is missing.

It also installs the `diazo` command: `diazo start|stop|restart|status|logs|update|open|uninstall [--purge]`. The app's menu has the same controls under Diazo → Local Server. Options: `--app-only`, `--server-only`, `--use-local` (point the app at this Mac's server even if another one is chosen), `--version X.Y.Z` (the app's release), `--dry-run`, `--uninstall [--purge]`. Run it again, or `diazo update`, to update both. Canvases, secrets and the app's server choice are kept.

The two parts also install on their own, as below.

### Desktop app (Mac)

```sh
curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.sh | sh
```

Installs `Diazo.app` (Apple silicon and Intel) into `/Applications`. The app then updates itself from this repository's releases. To use your own server, click the cog on the sign-in screen. Windows and Linux installers are attached to each `desktop-v*` release.

### Why macOS doesn't ask

Diazo is free and not notarized by Apple, because notarization needs a paid Apple developer membership. The install script avoids the first-open warning because curl does not mark the download as quarantined. It checks the release's SHA-256, and its signature when `minisign` is installed.

### Local server (Mac)

```sh
curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-local.sh | sh
```

One container with Apple's `container` on `127.0.0.1:4400`, data in `~/.diazo`. Run it again to update; `diazo-local` starts, stops, updates or uninstalls it. It does not start at login (the all-in-one install adds that). Needs macOS 26 and `container` 1.0 or later.

### Your own server

```sh
docker run -d --name diazo -p 4400:4400 -v diazo-data:/app/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e SECRETS_ENCRYPTION_KEYS="main:$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=http://localhost:4400 \
  ghcr.io/bryann2k/diazo:latest
```

Keep both secrets: a new `SECRETS_ENCRYPTION_KEYS` cannot read keys stored with the old one. Postgres is optional; without `DATABASE_URL` the server uses an embedded one. `docker compose up -d` builds from source with Postgres. Every variable is in [docs/doop-reference.md](docs/doop-reference.md#deploy).

## What it does today

The canvas holds frames that render real HTML. People edit them in the browser or the desktop app; agents edit them through the built-in MCP server, and everyone sees cursors, presence and the activity feed live.

### Canvas and editor

- The interface follows the 2026-11 "Cyanotype bench" redesign: a graphite palette, one colour for people and one for agent work, self-hosted fonts and named motion tokens.
- Diazo has its own marks, wordmark and agent face; `@diazo` mentions reach the agent.
- Sixteen upstream pull requests are merged ahead of doop, among them off-screen frame culling, level of detail when zoomed out, a self-healing renderer, frame cut and paste, image placement at native size and external stylesheets in frames.
- Agents can add a font file to a font library over MCP.

### Agents and models

- Claude Code, Codex, Cursor or any MCP client connects over OAuth and works on the canvas as you; headless agents use an agent key.
- The Diazo Agent answers a brief with a plan card you approve before anything is designed.
- It runs on an account you connect: a Claude or OpenAI key, a ChatGPT subscription, Gemini, OpenRouter, DeepSeek, Kimi or a custom provider.
- In the desktop app it also runs on subscriptions you already pay for: the Claude Plan (Claude Code), and the Devin and Grok CLIs over ACP.
- The Chat tab holds threads, a composer with a model picker per ask, suggestion chips and a thinking row while the agent works.
- Canvas skills give each canvas named know-how the agent loads on its own, or you load with `/name`.
- A reference library pins design items to a plan card for the agent to follow.
- A duel sends one brief to two or three models into sibling frames, then compares their renders, cost, time and lint score.

### Design libraries

- A canvas converts into a library without changing a frame: items and variants get a kind, a category and tags from their names and markers.
- The Libraries page lists them, and each gallery filters by kind, category and search, lays every variant side by side and renders its thumbnails in the background.
- ⌘F searches this canvas, a library or everything, from any page, knows UI synonyms, and previews the match live: its animations and hover states play under the pointer.
- Insert drops a scoped copy into the selected frame — the item's HTML and only its CSS, fresh ids, its SVG defs, nothing that runs — by click or by drag, with Adapt and Undo beside the copy.
- Every import is checked against all your libraries first; the same page, a known copy or a near-duplicate is shown before a second copy lands.
- Organise with AI folds several canvases into one deduplicated category tree you review, then builds a new tidy library; the source canvases are not touched.
- A new library can also start empty, with starter categories you type or your model suggests.
- "Add to library…" on a frame shows a dry run first, and a low lint score keeps the item a draft.
- An inserted block knows its item and offers Update when a newer revision exists; a frame holding a component goes in as a linked instance.
- Sharing is set per library: named people, the workspace, or every account when the instance opts in.
- Agents search, read, insert and write libraries over MCP and can start a curation run; `scripts/pull-library.ts` copies a library from another instance.

### Design to code

- The desktop app links a canvas to a project folder; the agent reads and searches it, and any write waits for a native confirmation.
- A frame marked ready for dev becomes a Stip change pack, written into the repo after a dialog lists every file.
- Components and frames map to their files in the repo, and the Inspector suggests the file.
- Token sync reads the repo's CSS variables and Tailwind theme, shows the diff and applies the ticked values in either direction as a reviewed patch.
- A frame exports as a React or Astro component — token values become `var(--token)`, mapped components import from their files — previewed as a diff first.
- A live frame can show a local dev server on the canvas, snapshotted at the frame's size.
- Drift review compares a frame with a live URL: pixel score, drift cards and a CI webhook.
- A preview-deploy webhook fills a Built page: each route is captured beside its designed frame and scored for drift.
- The `diazo` CLI links a folder to a canvas and pulls or pushes frames as HTML; `diazo mcp install` wires Claude Code, Codex or Devin.

### Quality

- Each frame is laid out at 375, 768 and 1440 px and walked with the keyboard: overflow, clipped text, tap targets, WCAG AA contrast and focus order, stored as a badge on the frame.
- An anti-slop lint flags lazy patterns on every frame, and the agent fixes lint errors before finishing.
- Every run lands in a ledger with its tokens, time and cost; the Usage tab totals per run and per model.
- A run replays its timeline with each frame before and after, and rolls back in one undo step.

### Motion Studio

- Any page gains a seekable timeline: duration, fps and size, a camera lane with keys and shots, and a track per element.
- Playing or scrubbing moves the editor's own view through the camera's shots.
- "Key the camera here" keyframes the current view; "Animate storyboard" asks the Diazo Agent to turn the page's frames into shots and camera moves.
- Every pixel is a function of time — the player seeks instead of running clocks — and a motion lint flags markup that is not seek-safe.
- Compositions save per page, copy with it and broadcast live; agents read and write them over MCP.
- Export renders MP4 or WebM in the browser, or frame by frame through the desktop app and ffmpeg.
- A bridge to an allowlisted Blender is built in, off by default.

### Self-hosting and updates

- The all-in-one install above sets up the server, the app, login start and the `diazo` command in one step; the app's Local Server menu shows and controls the server.
- The desktop app updates itself from this repository's releases, checked against their SHA-256 and signed with the fork's own updater key.
- The server checks GitHub at most hourly for a newer build and shows admins an "Update available" card with the command for their install.
- Docker images for amd64 and arm64 publish on every push to `main`; k3s manifests cover a VPS deploy.
- The owner's instance is reachable over Tailscale only, by design.

### Coming next

- Motion Studio phases 2 to 5: element keyframes and code export, video and audio layers with transcription and voice-over, 3D and server-side renders. See [.workflow/changes/motion-studio/proposal.md](.workflow/changes/motion-studio/proposal.md).
- Orca integration: a ready-for-dev frame opens a worktree with a coding agent, its status live on the frame. See [.workflow/changes/orca-integration/proposal.md](.workflow/changes/orca-integration/proposal.md).
- Agent scripts: typed query and run tools that collapse routine agent work into one call, adopted only if a quality benchmark says they are at least as good.
- Desktop 0.16.0, which ships the Local Server menu and the ACP and repo commands that need a shell release.

The full list of what Diazo adds on top of doop is in [docs/FEATURES.md](docs/FEATURES.md).

## Usage

Open `http://localhost:4400`, create an account and a canvas, then connect your coding agent:

```sh
claude mcp add --transport http diazo http://localhost:4400/mcp
```

A browser window asks you to approve; the agent then works as you. Headless agents use an agent key from Settings → Agent keys. From a terminal, the `diazo` CLI links a project folder to a canvas and pulls or pushes frames as HTML: [docs/cli.md](docs/cli.md).

## Developer notes

The web app is in `src/`, the server (Express, WebSocket room, MCP server) in `server/`, shared types in `shared/`, the Tauri desktop shell in `desktop/`, the CLI in `cli/`. `bun install && bun run dev` starts everything with an embedded Postgres. `scripts/seed-demo.ts` boots a seeded demo with a stand-in model, so the agent, library and repo features run without a provider. Work goes through pull requests into `dev`, then `staging`, then `main` ([CONTRIBUTING.md](CONTRIBUTING.md)); before a commit run `bun run typecheck && bun run lint && bun run test`. Details in [AGENTS.md](AGENTS.md), [docs/RELEASE.md](docs/RELEASE.md) and [docs/TECHSTACK.md](docs/TECHSTACK.md).

## Credits

Diazo started as a fork of doop, created by Kevin Goedecke with the doop contributors. Most of the code in this repository is theirs.

## License

Diazo is free software, licensed under the GNU Affero General Public License version 3 (AGPL-3.0), like doop. See LICENSE. Some parts carry the licenses of their original authors (fonts, icons and others).

Diazo is its own project. It is not affiliated with doop or doop.design. doop's name and logo are trademarks of their owner and are not used here; brand names and logos shown in the app belong to their owners and only identify the services they name.
