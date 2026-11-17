# Releasing Diazo

How a Diazo release is versioned, built, published and verified: the server image, the local and desktop installers, and the desktop app. Read by Bryan and by agents that cut a release or change the pipeline.
Status: last desktop release `desktop-v0.15.0` (2026-11-15), unverified under Stip; updated 2026-11-16

## At a glance

| Item             | Value                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artefacts        | image `ghcr.io/bryann2k/diazo` (`:staging`, `:main`, `:latest`, `:sha-<short>`); `Diazo_<v>_universal.dmg`, `Diazo_<v>_universal.app.tar.gz`, Windows setup, Linux AppImage, .deb and .rpm, `SHA256SUMS`, `latest.json` |
| Published to     | GHCR; GitHub Releases of `BRYANN2K/diazo` (`desktop-v*` and the fixed `desktop-updates` prerelease); the curl installers on `main`                                                                                      |
| Pipeline         | `.github/workflows/docker.yml` on pushes to `staging` and `main`; `desktop-release.yml` on `desktop-v*` tags                                                                                                            |
| Version lives in | the server: `package.json`; the desktop: `desktop/package.json`, both `tauri.conf.json`, both `Cargo.toml` and their `Cargo.lock` lines                                                                                 |
| Secrets          | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the repository secrets (names only)                                                                                                                |

## Versions and tags

- [SemVer](https://semver.org/): `fix` = patch, `feat` = minor; both packages are `0.y.z`, so a breaking change bumps the minor.
- The server has no release tag: every merge into `main` is a release, and its image carries its commit (`DOOP_BUILD_SHA`).
- The desktop app is tagged `desktop-vX.Y.Z` on `main`. `desktop/scripts/updater-config.sh` refuses a tag whose version differs from both `tauri.conf.json`.
- Never push `ios-v*` tags: `ios-release.yml` needs upstream's signing secrets.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); [CHANGELOG.md](../CHANGELOG.md) and `desktop/CHANGELOG.md` are written by hand.

## Before you merge into `main` or tag

- [ ] The change went `dev` → `staging` by pull request and CI is green on `staging` ([ADR 0006](adr/0006-merge-through-dev-staging-and-main.md)).
- [ ] The VPS ran the `:staging` image and the flows it touches work ([runbooks/k3s-deploy.md](runbooks/k3s-deploy.md)).
- [ ] `## [Unreleased]` in `CHANGELOG.md` lists the user-visible changes; a desktop release also has its `desktop/CHANGELOG.md` section.
- [ ] Desktop only: the version is bumped in `desktop/package.json`, both `tauri.conf.json`, both `Cargo.toml` and the package line of each `Cargo.lock`.

## Cut a desktop release

1. Merge `staging` into `main` by pull request. Expect: `docker.yml` and CI pass on `main`.
2. `git tag desktop-vX.Y.Z origin/main && git push origin desktop-vX.Y.Z`. Expect: `desktop-release.yml` starts.
3. Wait for the universal DMG (Chromium/CEF, about an hour), the Windows setup and the Linux packages. Expect: release `desktop-vX.Y.Z` with every artefact, `SHA256SUMS` and `latest.json`, and `latest.json` copied onto `desktop-updates`.

## Verify after publish

- `shasum -a 256 -c SHA256SUMS` in a folder with the downloaded artefacts. Expect: `OK` for each.
- `curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.sh | sh` on a Mac with the previous version. Expect: the new version in Diazo → About.
- An installed app offers the update within 24 hours, or at once with Diazo → Check for Updates…
- `curl -s <instance>/api/version` after a server release. Expect: the merged commit.

## Roll back

- Fix forward: ship `X.Y.Z+1`. The desktop job refuses to put an older version back on `desktop-updates`.
- Server: revert on `staging`, then `main`, by pull request; or pin `:sha-<short>` on the instance ([runbooks/k3s-deploy.md](runbooks/k3s-deploy.md#rollback)).
- Lost updater key: generate a new minisign pair, set the two secrets, put the public half in both `tauri.conf.json` (`plugins.updater.pubkey`) and `PUBKEY` in `scripts/install-desktop.sh`; every user reinstalls once with the curl script. No data is lost.

Taking changes from upstream doop is a separate procedure: [runbooks/upstream-resync.md](runbooks/upstream-resync.md).

## Self-hosted server (Docker)

`docker.yml` builds `ghcr.io/bryann2k/diazo` for `linux/amd64` and `linux/arm64` on native runners on every push to
`staging` (tag `staging`) and `main` (tags `main`, `latest`, `sha-<short>`), and merges the digests into one
multi-arch tag. `docker compose up` (`docker-compose.yml` + `Dockerfile`) builds the image locally instead and runs it
on port 4400 beside a `postgres:16-alpine` container; migrations apply at boot (`server/db/index.ts`). CI (`ci.yml`)
validates every push to `dev`, `staging` and `main` and every pull request (typecheck, lint, format:check, doc-lint,
build, tests). The CI build uses `bun run --bun build` to match the `oven/bun` Docker build stage,
where `node` commands run with Bun. Extension tests also build with both runtimes
and run the Bun-built archive under Node, including its nested runtime dependencies.

## Local install on a Mac (Apple `container`, this fork)

`scripts/install-local.sh` (POSIX sh, served from `raw.githubusercontent.com` on
`main` of `BRYANN2K/diazo` as `curl -fsSL … | sh`) runs one container, `diazo`, of
`ghcr.io/bryann2k/diazo:main` with Apple's `container` CLI on `127.0.0.1:4400`.
No `DATABASE_URL`: PGlite and uploads live in `~/.diazo/data`, mounted at `/app/data`.
The install backs its PGlite data dir up to `~/.diazo/data/backups/` itself — a
`pg-<date>.tar.gz` dump plus an asset manifest before every migrating boot and once
a day while running, keeping the newest seven (`server/backup.ts`).
`BETTER_AUTH_SECRET` and `SECRETS_ENCRYPTION_KEYS` are generated on the Mac into
`~/.diazo/diazo.env` (mode 600). An install from before the rename keeps `~/.doop` and its
`doop.env` where they are (nothing is moved; `DOOP_HOME` overrides), and its old `doop` container
is replaced only when it runs this fork's former image. Re-running it updates the image and
recreates the container, keeping both. It copies itself to `<home>/bin/diazo-local` (start, stop,
restart, status, logs, update, uninstall), with `doop-local` as a link to it. `.github/workflows/docker.yml` builds the image for `linux/amd64` and
`linux/arm64` on native runners and merges the digests; without an arm64 manifest the script
runs the amd64 image under Rosetta, and `--build` builds it locally. Tests:
`installLocal.test.ts` (stub `container`, `uname`, `curl`; no container is started).
The container also gets `TRUSTED_ORIGINS=http://127.0.0.1:<port>`, the origin the app opens;
`--keep-data` makes `uninstall` keep the data folder without asking.

### All in one (`scripts/install.sh`)

`curl -fsSL …/scripts/install.sh | sh` runs `install-local.sh install` and then
`install-desktop.sh` (the copies beside it in a checkout, else downloaded from `main`; never
duplicated), after checking Apple silicon, macOS 26+ and `container` 1.0+ (otherwise the
download link, an `--app-only` offer on a terminal, and nothing installed). Around them: a
LaunchAgent `~/Library/LaunchAgents/dev.bryann2k.diazo.server.plist` (`launchctl bootout` then
`bootstrap gui/<uid>`; at login `diazo autostart` starts the services and the container when
`/healthz` does not answer; logs in `~/Library/Logs/Diazo`), the app's `server.json` set to
`http://127.0.0.1:4400` unless another server is chosen (`--use-local` replaces it; the shell's
identity migration keeps it), and the `diazo` command (this script in `<home>/bin/diazo`, the
two installers in `<home>/lib`, linked into `/usr/local/bin` or `~/.local/bin`):
`start|stop|restart|status|logs|update|open|uninstall [--purge]`. `update` downloads the three
scripts again and updates what `<home>/install.conf` records. Flags: `--app-only`,
`--server-only`, `--use-local`, `--version`, `--dry-run`, `--uninstall [--purge]`. The app's
Diazo → Local Server menu (`local_server.rs`) needs desktop 0.16.0. Tests: `install.test.ts`
(stub `container`, `launchctl`, `curl`, `uname`, `sw_vers`, `open`, `osascript`).

## All-in-one Mac install (server + app, this fork)

`scripts/install.sh` (`curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install.sh | sh`)
does not copy the two other installers: it runs `install-local.sh install`, then `install-desktop.sh` (the
neighbouring copies in a checkout, else downloaded from `main`). The server needs Apple silicon, macOS 26+ and
`container` 1.0+; otherwise the script prints the download link, offers `--app-only` on a terminal and exits
with code 1 without installing anything.

- A LaunchAgent, `~/Library/LaunchAgents/dev.bryann2k.diazo.server.plist` (`launchctl bootout`, then
  `bootstrap gui/<uid>`, idempotent), runs `diazo autostart` at login: it starts the `container` services and
  the container when `/healthz` does not answer. Logs go to `~/Library/Logs/Diazo/server.log`.
- The app's `server.json` (`~/Library/Application Support/dev.bryann2k.diazo`) is set to
  `http://127.0.0.1:4400` unless another server is already chosen (including one in a not-yet-migrated
  `design.doop.desktop`); `--use-local` overrides it. The container gets
  `TRUSTED_ORIGINS=http://127.0.0.1:4400`, since better-auth only trusts `BETTER_AUTH_URL` (`localhost`). The
  shell's identity migration treats a folder holding only that `server.json` as empty and keeps the file.
- The `diazo` command (the script itself, copied to `~/.diazo/bin/diazo`, with both installers in
  `~/.diazo/lib` and a link in `/usr/local/bin` or `~/.local/bin`): `start`, `stop`, `restart`, `status`,
  `logs`, `update`, `open`, `uninstall [--purge]`. `update` downloads the three scripts again and updates what
  `~/.diazo/install.conf` lists (server, app or both). `diazo-local` / `doop-local` stay.
- `--dry-run` prints the steps and changes nothing. `--uninstall` keeps data, secrets and the app's session;
  `--purge` removes everything.
- In the app: Diazo menu → Local Server (`local_server.rs`, desktop 0.16.0) and a status row in Settings →
  General → About. It reaches users with the `desktop-v0.16.0` tag.
- Tests: `tests/install.test.ts` (stubbed `container`, `launchctl`, `curl`, `uname`, `sw_vers`, `open`,
  `osascript`) and the Rust tests in `local_server.rs`.

## Build identity and the update check (this fork)

`docker.yml` passes `DOOP_BUILD_SHA=${{ github.sha }}` and `DOOP_BUILD_DATE` as build args;
the Dockerfile turns them into env in its last layer, so `GET /api/version` and Settings →
About name the commit. A compose build gets the commit only with
`DOOP_BUILD_SHA=$(git rev-parse HEAD) docker compose up -d --build`; a checkout asks git. A
running instance announces a newer image to its admins once the `docker.yml` run of a newer
`main` commit has succeeded (`server/updateCheck.ts`), never from a push alone. Each install
declares how it updates through `DOOP_INSTALL`: `local` (`install-local.sh` →
`diazo-local update`), `docker` (compose → `docker compose pull && docker compose up -d`),
`kubernetes` (`deploy/k3s/doop.yaml` → `kubectl -n doop rollout restart deploy/doop`, which
re-pulls `:main` under `imagePullPolicy: Always`). The desktop shell's own updates come from
this fork's releases (next section).

## Desktop app (Tauri: macOS DMG + Windows NSIS installer + Linux AppImage/.deb/.rpm)

Driven by `.github/workflows/desktop-release.yml`; every desktop job shares the toolchain setup
in `.github/actions/setup-desktop`:

- Push a tag matching `desktop-v*` -> `dmg-macos` builds a universal (Apple Silicon + Intel) DMG
  with `bunx tauri build --target universal-apple-darwin --bundles app,dmg`, `nsis-windows` builds
  `Diazo_<version>_x64-setup.exe` with `bunx tauri build --bundles nsis`, `linux` builds the
  x64 AppImage, .deb and .rpm on `ubuntu-22.04` (the oldest runner, for a low glibc floor) with
  `bunx tauri build --bundles deb,rpm,appimage`, and a final `release` job (`needs` all three)
  attaches them to one GitHub Release - so a tag is never published with an installer missing.
- The AppImage is repacked after the build by `desktop/scripts/appimage-drop-wayland.sh` (pinned
  `appimagetool` and type2 runtime, both checksummed), which drops the bundled `libwayland-*`: copies from the 22.04 runner are older
  than current distros' Mesa and make WebKitGTK abort with `EGL_BAD_PARAMETER`. Tauri passes
  linuxdeploy no extra flags, so `--exclude-library` cannot do it. The script re-signs the
  updater `.sig` when the key is set.
- Self-update (`tauri-plugin-updater`, `desktop/src-tauri/src/updates.rs`): with the
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets set, every build also
  emits signed updater packages, and the `release` job writes `latest.json` and `SHA256SUMS`,
  attaches them and copies `latest.json` onto the fixed `desktop-updates` prerelease of the repo it
  runs in, which `plugins.updater.endpoints` names directly (this fork:
  `https://github.com/BRYANN2K/diazo/releases/download/desktop-updates/latest.json`; a fixed
  prerelease rather than `releases/latest`, which any other release would take over). A tag fails
  without the key, or when its version is not the one in both `tauri.conf.json`
  (`desktop/scripts/updater-config.sh`). Installed official
  shells check at launch and daily, download in the background and offer a restart: in the
  page's "Update available" card (`src/components/UpdateCard.tsx`, `src/lib/desktopUpdate.ts`;
  bottom right above the zoom pill, shaped like the canvas's getting-started card),
  which claims the offer through `update_card_ready` once it listens for `update-ready` and answers
  with `update_restart`, or in a native dialog while no page has claimed it (each page load resets
  the claim, so an older web build still gets the dialog). Its ✕ (Not now) keeps the download for the
  next check and, on macOS, installs it on quit. This fork's key pair (minisign id
  `B1375F7E88B8FC72`) exists only in the `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` secrets of
  `BRYANN2K/diazo` (created as `BRYANN2K/redoop`); its public half is `plugins.updater.pubkey` (and `PUBKEY` in
  `scripts/install-desktop.sh`). Shells installed from doop.design trust upstream's key and feed:
  they move over with one run of the curl installer below.
- Mac install (`scripts/install-desktop.sh`, POSIX sh, piped from `raw.githubusercontent.com` on
  `main` into `sh`, the README's Desktop app line): reads the version from the feed (or `--version`), downloads `Diazo_<v>_universal.app.tar.gz` from
  `desktop-v<v>`, checks it against `SHA256SUMS` (and its `.sig` with `minisign` when installed),
  quits a running app (`osascript`, by bundle id `dev.bryann2k.diazo`), swaps `Diazo.app` in `/Applications` or
  `~/Applications` through a staging folder on the same volume, clears `com.apple.quarantine` and
  relaunches the app if it was running. A file curl downloads has no quarantine flag, so the
  ad-hoc-signed app opens without Apple signing. Same version and our key in the binary: nothing
  to do (`--force` reinstalls); `--uninstall` removes the app and keeps Application Support. A
  `doop.app` from this fork's earlier releases (its binary carries our updater key) is removed once
  `Diazo.app` is in place, never asked to quit (its bundle id is the official app's too); the
  official doop app is never touched. Releases before 0.15.0 have no Diazo package.
  Tests: `installDesktop.test.ts` (stub `curl`, `uname`, `pgrep`, `osascript`, `xattr`, `open`,
  `minisign`).
- `workflow_dispatch` or a PR touching the workflow file itself -> same builds, uploaded as
  workflow artifacts instead (keeps the pipeline validated without cutting a release).
- macOS signing/notarization: none in this repository, which has no `APPLE_*` secrets ([ADR 0007](adr/0007-ship-the-desktop-app-from-our-own-releases.md)). The workflow signs and notarizes automatically once the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` repo secrets exist (see
  `desktop/README.md`). Without them the DMG is unsigned - it still works, but downloaders must
  approve it via System Settings -> Privacy & Security.
- Windows signing: none in this repository, which has no `AZURE_*` variables, so the installer is unsigned. The
  mechanism, as upstream set it up: Azure Artifact Signing (account `Doop`, East US, profile `doop-public`). The
  `nsis-windows` job runs in the `desktop-release` environment, logs in through OIDC (app
  registration `doop-desktop-signing`, federated on that environment; `AZURE_CLIENT_ID` /
  `AZURE_TENANT_ID` repo variables, no secret) and passes a CI-only `signCommand` to Tauri
  (`desktop/scripts/sign-windows.ps1`: signtool + the pinned `Microsoft.ArtifactSigning.Client`
  dlib), so the app exe, installer and uninstaller are signed; `signtool verify` gates the job. PR
  builds and repos without the variables stay unsigned. Setup: `desktop/README.md`.
- Connecting an OAuth integration (Meta, Linear, Slack) from the app opens the
  provider in the system browser and returns over a `doop://integration/<id>` link; the app
  finishes it under its own session (`shared/desktopConnect.ts`). This is web-only: shells from
  0.2.1 already deliver any `doop://` link, and older shells open Integrations in the browser.
- The macOS menu bar is the page's (`desktop/src-tauri/src/app_menu.rs`, `src/lib/appMenu.ts`, gated
  on `window.__DOOP_APP_MENU__`, macOS only): the page sends File, Edit, View, Object, Text, Arrange
  and Help from the action registry (`app_menu_set`, labels in its language, each chord as the key
  equivalent) and then only changed enabled/checked state (`app_menu_state`); the shell keeps the
  app menu, Close Tab, the system Undo/Cut/Copy/Paste/Select All that text fields need, Full Screen
  and Window. A pick returns as `app-menu` `{ id, key }`; the webview sees a key before the menu, and
  a key the menu does get keeps the canvas keyboard's rules (nothing while typing or presenting).
  Until a page sets it the bar is the old fixed one, whose View menu (`view_menu.rs`,
  `src/lib/viewMenu.ts`, `__DOOP_VIEW_MENU__`) an older page still drives. Needs a desktop release.
- Server choice (`desktop/src-tauri/src/server.rs`, `src/components/ServerSettings.tsx`): the
  sign-in screen's cog (shells advertising `__DOOP_SERVER_CHOOSE__`) points an official build at a
  self-hosted server. With nothing chosen an official build opens `http://127.0.0.1:4400`, the
  server on this computer (`APP_URL`, `DOOP_APP_URL` overrides it). `capabilities/default.json`
  names no remote origin and `frontendDist` is the bundled `shell-dist/` page, so the only site
  with IPC is the one a launch opens, granted at runtime (`grant`); doop.design and www.doop.design
  are refused as a server and never granted. `server_choose` normalizes the address to an origin (https, or http on loopback only),
  checks `/api/locale-config` answers and takes the origin any redirect lands on, confirms natively, writes `server.json` in the app data dir and
  restarts; at launch the chosen origin gets `capabilities/default.json` as a runtime capability
  and the navigation allowlist. A server that does not answer at launch gets a native dialog
  (`check_on_launch`, every platform): Try Again, then "Use this computer’s server" for a chosen one or
  "Choose a Server…" for the default, which opens the bundled page; macOS also has "Use this computer’s
  server…" in the app menu. Official builds (no `DOOP_APP_URL`) keep updating from this fork's feed
  whatever server is chosen. Needs a desktop release. Tests: the Rust unit tests in
  `server.rs`, `serverSettings.test.tsx`.
- The shell tells the page its platform via `window.__DOOP_DESKTOP_PLATFORM__` (read in
  `src/lib/shell.ts`); only macOS gets the overlay title bar / traffic-light inset.
- Desktop app version is tracked separately from the root `package.json` and bumped by hand (see
  "Before you merge"); tag `desktop-vX.Y.Z` after the merge into `main`.
- The macOS app is the Chromium (CEF) build in `desktop/src-tauri-chromium`; Windows and Linux
  stay on the WebKit build. It ships as `Diazo` / `dev.bryann2k.diazo` (from 0.15.0; `doop` /
  `design.doop.desktop` before) with the executable `doop-desktop`, as the WebKit app did, so the
  updater swaps the bundle in place and relaunches it by its old path. On its first launch under
  the new identifier `src/identity_migration.rs` copies `server.json`, `cli.json` and the CEF
  profile from the old identifier's folders when the new ones are empty, never deleting them. The Tauri 3 CLI bundles CEF for one architecture at a time
  (its universal target ships one architecture's framework), so `dmg-macos` runs
  `desktop/scripts/macos-universal.sh` as Electron apps do: an unsigned app per architecture
  (`bun run build:chromium --target … --no-sign`, ninja from brew, CEF cached under
  `~/Library/Caches/tauri-cef`), merged by `@electron/universal` (`scripts/universal-app.mjs`),
  signed inside out (framework libraries, framework, five helpers, app) with the CEF entitlements
  (allow-jit, allow-unsigned-executable-memory, disable-library-validation) under the hardened
  runtime, notarized, packed with `create-dmg`, and tarred and signed with `tauri signer` for the
  updater. The outputs are `Diazo_<version>_universal.dmg` and `Diazo.app.tar.gz`, which the
  release job renames `Diazo_<version>_universal.app.tar.gz`; the app is about
  600 MB, Chromium for both architectures. The first Chromium launch brings the
  WebKit app's cookies and localStorage over (`src/webkit_migration.rs`), so the switch keeps
  people signed in. Each Chromium security release needs a CEF bump (`tauri-runtime-cef`) and a
  desktop release. Rolling back means publishing a WebKit macOS build with a higher version to
  the feed; it starts from its old WebKit store, as it was before the switch.
  Bump the Chromium `tauri.conf.json` and `Cargo.toml` with the WebKit shell's.

## Claude Desktop extension

`bun run build:claude-extension` packages `claude-extension/manifest.json`, the Diazo app icon,
license and pinned `mcp-remote` runtime into `public/claude-extension/doop.mcpb`. Both `dev`
and `build` run it automatically; Vite copies the download into the production `dist/`.
Connect AI → Claude offers a prefilled **Add to Claude** link for public HTTPS servers.
The shared endpoint check filters common local addresses while allowing public IPv6
and numeric-prefixed DNS names; the connecting client checks actual reachability.
In updated desktop shells it prepares the extension, prefills the current `/mcp` URL,
and invokes `claude_add_extension` to open Claude's installer. Native installation
requires a desktop release; the online link ships with the web app. Manual downloads
remain a collapsed fallback for older shells and local browser sessions.
OAuth requests for consent open `/oauth/consent`. The approval screen resolves the client
from a code bound to the signed-in account; `/api/mcp-consent/:code` handles approval and
denial through better-auth. This also supports other MCP clients that request consent.

`tests/claudeExtension.test.ts` extracts the actual archive outside the repository and checks
tools, resources, OAuth and reconnecting against a fresh Diazo server. Before releasing,
also install it in Claude Desktop on macOS and Windows. Installation, build and release
notes live in [`claude-extension/README.md`](../claude-extension/README.md). No directory
submission or publication is performed by the build.

## Codex desktop setup

Connect AI → Codex can register Diazo directly in the shared Codex config through
`codex_add_mcp`. Browser sessions hand off to the installed app with a `doop://connect/codex`
link; the app opens a review screen and writes only after the user clicks Add to Codex.
The native capability marker gates older shells. Release the updated desktop binary
and frontend together; no downloadable integration bundle is built. Codex still owns
the separate OAuth approval. Config preservation, conflict handling and handoff checks
are covered by Rust/frontend tests; desktop CI now runs the Rust tests on macOS, Windows and Linux.
See [`desktop/README.md`](../desktop/README.md#add-to-codex) for release smoke checks.

## Cursor marketplace plugin

`cursor-plugin/` is a standalone Cursor plugin directory; `.cursor-plugin/marketplace.json` at
repo root indexes it. It contains the hosted MCP connection, the scoped `doop-design` skill,
metadata, logo, and license. It needs no build artifact or release download. The app's
**Connect AI → Cursor → Add to Cursor** uses Cursor's MCP install link for the current Diazo
instance and is available independently of marketplace publication.

Diazo does not publish this plugin to Cursor's marketplace. Publishing would need a public listing source and
Cursor's review; nothing in this repository submits it. Bump the version in
`cursor-plugin/.cursor-plugin/plugin.json` for plugin updates; setup and reviewer steps are in
`cursor-plugin/README.md`.

## Other workflows

- `.github/workflows/desktop.yml` - desktop app CI (build/check) outside of the release path, when `desktop/` changes.
- `.github/workflows/ios.yml` - iOS build check when `ios/` changes; nothing is published.
