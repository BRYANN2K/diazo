# Evidence

Status: current, updated 2026-11-17

## Root cause

Two grants reached doop.design. `capabilities/default.json` listed
`https://doop.design` and `https://www.doop.design` as remote URLs (and
`motion-render.json` did too). `tauri.conf.json` `frontendDist` was
`https://doop.design`, and in a release build Tauri treats a page relative
to a `frontendDist` URL as local (`is_local_url` in `tauri` 2.11.5,
`webview/mod.rs`), so doop.design got every permission a local page gets.

## AC-1, AC-2 — no remote origin bundled

`server::tests::the_bundled_capabilities_grant_no_remote_origin_but_loopback_renders`
and `server::tests::the_config_loads_no_remote_page_as_local` read the
capability files and both `tauri.conf.json` with `include_str!`.

## AC-3 — the grant set

`granted_origin` is the pure rule behind `grant`.
`server::tests::grants_ipc_to_the_open_server_only`: release default and
chosen servers granted by exact origin, a debug build's dev server none,
doop.design and www.doop.design never. `grants_the_bundled_permissions_to_the_chosen_origin`
keeps the runtime capability's permissions equal to the bundled file's.

## AC-4 — the default server

`APP_URL` falls back to `local_server::LOCAL_URL`.
`server::tests::opens_the_server_on_this_computer_by_default`.

## AC-5 — doop.design refused

`normalize` refuses it, which covers `server_choose` and `chosen` (a saved
`server.json`). `server::tests::refuses_doop_design_as_a_server`, including
look-alike hosts that stay allowed.

## AC-6 — launch check and chooser page

`check_on_launch` and `chooser_url` in `src/server.rs`,
`desktop/src-tauri/shell-dist/index.html`. `app_hosts` keeps
`tauri.localhost` in the window for Windows.
`server::tests::reads_the_launch_dialog_by_its_buttons`,
`keeps_the_chosen_hosts_in_the_window`. The dialog and the page themselves
are unverified without a built app (AC-10).

## AC-7 — updater

`the_config_loads_no_remote_page_as_local` asserts the feed URL in both
configs; `updates_enabled` is `!debug && OFFICIAL_BUILD`
(`updates::tests::debug_builds_never_update`).

## AC-8 — docs

`desktop/README.md`, `docs/RELEASE.md` (Server choice), `CHANGELOG.md`
(Security), the `ServerStatus.defaultUrl` comment in `src/lib/desktopServer.ts`.

## AC-9 — checks

- `cargo test --locked` in `desktop/src-tauri`: 102 passed.
- `bun run typecheck`: exit 0. `bun run lint`: exit 0.
- `bunx prettier --check` on changed files: clean.
- `bunx vitest run tests/serverSettings.test.tsx tests/desktopLinks.test.ts tests/localServerRow.test.tsx --maxWorkers=2`:
  3 files, 11 tests pass.
- `bun run doc-lint`: passed.

## AC-10 — unverified

No desktop app was built, and the Chromium shell was not compiled here (it
shares these sources and capabilities through `build.rs`). The change
reaches people only with a desktop release.
