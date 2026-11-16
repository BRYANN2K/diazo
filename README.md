<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/diazo/lockup-horizontal-dark.svg">
    <img src=".github/assets/diazo/lockup-horizontal.svg" alt="Diazo" width="300">
  </picture>
</p>

# Diazo

Diazo is a free, self-hosted design canvas for builders: people whose AI agents design the screens and then write the code. Frames are live HTML, humans and agents work on the same canvas in real time, and the design flows into your repo.

Diazo started as a fork of doop, the open-source multiplayer design canvas by Kevin Goedecke, and is now its own project. The desktop app and the server are in this repository. The live instance runs on its owner's server, reachable over Tailscale only.

**Status: alpha.** Expect missing features and breaking changes. Updated 2026-11-15.

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

- **Agents.** Connect Claude Code, Codex, Cursor or any MCP client. The built-in Diazo Agent runs on an account you connect (Claude, OpenAI, Gemini, OpenRouter, a ChatGPT subscription), and in the desktop app on the Claude, Devin and Grok CLIs you already pay for. The chat answers a brief with a plan you approve before anything is designed.
- **Design libraries.** A canvas becomes a library of items and variants. ⌘F finds an item, previews it live, and inserts a scoped copy. Organise with AI merges old kits into one category tree on your own model account. Diazo tells you when something is already in your library.
- **Checks.** Each frame is laid out at 375, 768 and 1440 px and walked with the keyboard: overflow, tap targets, contrast, focus, plus an anti-slop lint.
- **Runs.** Every agent run records its tokens, time and cost, and can be replayed or rolled back. A duel sends one brief to two or three models side by side.
- **Code.** Link a canvas to a project folder. Tokens sync with the repo's CSS variables, and a frame exports as a React or Astro component, shown as a patch before it is written.
- **Updates.** Admins see when a newer build is out, and the command that updates their install.

Coming next: Motion Studio, where a page gains a timeline and the Diazo Agent animates a storyboard into seek-safe HTML. See [.workflow/changes/motion-studio/proposal.md](.workflow/changes/motion-studio/proposal.md).

The full list of what Diazo adds is in [docs/FEATURES.md](docs/FEATURES.md).

## Usage

Open `http://localhost:4400`, create an account and a canvas, then connect your coding agent:

```sh
claude mcp add --transport http diazo http://localhost:4400/mcp
```

A browser window asks you to approve; the agent then works as you. Headless agents use an agent key from Settings → Agent keys. From a terminal, the `diazo` CLI links a project folder to a canvas and pulls or pushes frames as HTML: [docs/cli.md](docs/cli.md).

## Developer notes

The web app is in `src/`, the server (Express, WebSocket room, MCP server) in `server/`, shared types in `shared/`, the Tauri desktop shell in `desktop/`, the CLI in `cli/`. `bun install && bun run dev` starts everything with an embedded Postgres. Work happens on `main`; before a commit run `bun run typecheck && bun run lint && bun run test`. Details in [CLAUDE.md](CLAUDE.md), [FORK.md](FORK.md) and [.context/TECHSTACK.md](.context/TECHSTACK.md).

## Credits

Diazo started as a fork of doop, created by Kevin Goedecke with the doop contributors. Most of the code in this repository is theirs.

## License

Diazo is free software, licensed under the GNU Affero General Public License version 3 (AGPL-3.0), like doop. See LICENSE. Some parts carry the licenses of their original authors (fonts, icons and others).

Diazo is its own project. It is not affiliated with doop or doop.design. doop's name and logo are trademarks of their owner and are not used here; brand names and logos shown in the app belong to their owners and only identify the services they name.
