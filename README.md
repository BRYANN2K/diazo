# redoop

A self-hosted doop for developers and their AI agents: design and code in one loop.
Status: alpha, updated 2026-11-14

<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-111110" alt="License: AGPL-3.0"></a>
<a href="https://github.com/kgoedecke/doop"><img src="https://img.shields.io/badge/fork%20of-kgoedecke%2Fdoop-2743EE" alt="Fork of kgoedecke/doop"></a>

## What it does

redoop is a fork of [doop](https://github.com/kgoedecke/doop), the open-source multiplayer design
canvas for humans and AI agents, rebuilt for people who build. The design is decided on the canvas,
the code is built in your repo, and agents carry it between the two.

- **Design to code.** A frame marked ready for dev becomes a Stip change pack written into your
  linked repo. Components and frames point at the files that implement them, so the coding agent
  knows what to change.
- **Code back to design.** A live frame shows your local dev server next to the mockup. A drift
  review scores a shipped page against its approved frame. Preview deploys land on a "Built" page.
- **Agents that know your canvas.** Any MCP client designs on the canvas. Agents search every
  page and canvas with `find_in_canvas`, load the canvas's skills ("how we do a pricing page
  here"), and each run is metered and can be replayed or rolled back.
- **A library you build from.** Turn a canvas into a design library: its frames become items
  with variants, categories and tags. ⌘F finds a component and its variants, previews them live,
  and drops a scoped copy into your frame; agents search the same index. Frames are checked for anti-slop rules,
  responsive layout and accessibility.
- **Yours to run.** One command on a Mac, or your own server behind Tailscale. Your canvases,
  uploads and keys live on your machine or your server.

Every feature this fork adds, and the upstream pull requests it merged early, are listed in
[docs/FEATURES.md](docs/FEATURES.md).

<p align="center">
  <img src=".github/assets/canvas.png" alt="A canvas with three frames for a travel app (landing hero, mobile itinerary and a booking card) and two collaborators' live cursors" width="100%">
</p>

## Requirements

- **Local install:** a Mac with Apple silicon, macOS 26 and Apple's
  [`container`](https://github.com/apple/container/releases/latest) 1.0 or later.
- **Hosted install:** Docker with Compose, or a Kubernetes cluster, and Postgres 16 (the Compose
  file starts one).
- **From source:** Bun 1.3.10 (pinned in `package.json`) and Node.js. `bun run dev` needs no
  database: it starts an embedded Postgres (PGlite).
- **Desktop-only features** (live frames on `localhost`, the linked local project, writing a
  handoff into your repo) need the doop desktop app.

## Install

### Local (Mac, lightweight)

```sh
curl -fsSL https://raw.githubusercontent.com/BRYANN2K/redoop/main/scripts/install-local.sh | sh
```

One container on `127.0.0.1:4400`, with the database and uploads in `~/.doop/data` and secrets
generated on your Mac. Run it again to update. `~/.doop/bin/doop-local` starts, stops, updates or
uninstalls it. What the script does, step by step, is in
[.context/RELEASE.md](.context/RELEASE.md#local-install-on-a-mac-apple-container-this-fork).

### Hosted

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) docker compose up -d   # app + Postgres on :4400
```

This fork's own instance runs on k3s and is reachable over Tailscale only: manifests in
`deploy/k3s/`, steps in [FORK.md](FORK.md). Other hosts and every environment variable:
[docs/doop-reference.md](docs/doop-reference.md#deploy).

### From source

```sh
bun install
bun run dev   # web app on :4300, server on :4400, embedded Postgres
```

## Usage

Open `http://localhost:4400` (`:4300` when running from source), create an account and a canvas.
Then connect your coding agent:

```sh
claude mcp add --transport http redoop http://localhost:4400/mcp
# expected: a browser window asks you to approve; the agent then works as you
```

Ask it to design on your canvas and watch the frames stream in. Codex, Cursor, OpenCode and any
other MCP client connect the same way. Headless agents use an agent key from Settings → Agent keys.

From a terminal, the `doop` CLI links a project folder to a canvas, finds frames and pulls or
pushes them as HTML files: [docs/cli.md](docs/cli.md).

## Documentation

- [Features](docs/FEATURES.md): what this fork adds, and the upstream pull requests it merged.
- [Fork notes](FORK.md): the upstream resync recipe and the k3s deploy.
- [doop reference](docs/doop-reference.md): the editor, the MCP tools, accounts, deployment,
  environment variables, the REST API and the architecture.
- [Tech stack](.context/TECHSTACK.md), [specs](.context/specs/INDEX.md) and
  [plans](.context/plans/INDEX.md).
- [Changelog](CHANGELOG.md) (upstream releases).

## Development

Build, test and the change workflow are in [CLAUDE.md](CLAUDE.md) (agents and humans) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

redoop is a fork of [kgoedecke/doop](https://github.com/kgoedecke/doop). It is not affiliated
with doop or doop.design.
