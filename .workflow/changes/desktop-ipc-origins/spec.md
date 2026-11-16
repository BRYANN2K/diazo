# Stop granting the desktop shell's IPC to doop.design

Status: active, updated 2026-11-17

## Intent

Only the server the desktop shell opens can use its IPC, and doop.design
never can.

## Acceptance criteria

- AC-1: `capabilities/default.json` has no `remote` section, and every
  remote URL in `motion-render.json` and `live-snapshot.json` is a loopback
  pattern.
- AC-2: Neither shell's `tauri.conf.json` has a URL as `frontendDist`; both
  load the bundled `shell-dist/` folder.
- AC-3: A release build grants the shell capability (and the motion-render
  one) at runtime to exactly the origin the launch opens, default or chosen;
  a debug build on its dev server grants none; doop.design and
  www.doop.design are never granted.
- AC-4: With nothing chosen and no `DOOP_APP_URL`, the shell opens
  `http://127.0.0.1:4400`.
- AC-5: doop.design and www.doop.design (any case, any path) are refused
  as a server, typed or saved; look-alike hosts such as
  `doop.design.example.com` are not.
- AC-6: When the server does not answer at launch, a native dialog offers
  Try Again and either the default (for a chosen server) or "Choose a
  Server…" (for the default), which opens the bundled page; that page
  calls `server_choose` only.
- AC-7: The updater still points at
  `https://github.com/BRYANN2K/diazo/releases/download/desktop-updates/latest.json`
  in both configs and stays on for builds without `DOOP_APP_URL`.
- AC-8: Docs updated: `desktop/README.md`, `docs/RELEASE.md`, `CHANGELOG.md`.
- AC-9: Required checks pass: `cargo test` in `desktop/src-tauri`,
  typecheck, lint, Prettier on changed files, affected vitest files,
  `bun run doc-lint`.
- AC-10: A built app opens the default server with IPC working, refuses
  doop.design in the server settings, and shows the bundled page from
  "Choose a Server…" (WebKit and Chromium shells). Needs a desktop build.
