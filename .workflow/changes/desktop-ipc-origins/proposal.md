# Stop granting the desktop shell's IPC to doop.design

Status: active, updated 2026-11-17

## Problem and authorized scope

The Diazo desktop shell still granted its full IPC capability set (Claude
Code runs, local fonts, repository reads and writes, Codex and Claude
settings, the ACP agents) to `https://doop.design` and
`https://www.doop.design`, origins this fork does not control. Two paths
did it: `capabilities/default.json` listed both as remote URLs, and
`tauri.conf.json` `frontendDist` was `https://doop.design`, which Tauri's IPC
check counts as a local origin in a release build. doop.design was also the
default server with nothing chosen.

Scope, from a security finding in the acp-connect review: the IPC grant
covers only the server a launch opens, never doop.design; pick the default
server; keep the updater on the fork's feed; Rust tests for the grant set;
docs. No dependency, CI, release or publication work. Never push.

## Decisions

- The default server is `http://127.0.0.1:4400`, the all-in-one install of
  `scripts/install.sh` (also the `docker compose up` port), unless the
  shell is built with `DOOP_APP_URL`.
- `capabilities/default.json` names no remote origin. At launch `grant`
  adds it for the exact origin the launch opens (default or chosen) in a
  release build; a debug build on its dev server needs none (devUrl is
  local). `motion-render.json` keeps only its loopback patterns.
- `frontendDist` is a bundled folder (`shell-dist/`) with one page that asks
  for a server's address, so no remote origin is ever "local". The launch
  check now also covers the default: when it does not answer, a native
  dialog offers Try Again or "Choose a Server…", which opens that page.
  Without it a person with no local server would have no page to choose one
  from.
- doop.design and www.doop.design are refused by `normalize`, so they can be
  neither chosen nor read back from a saved `server.json`, and `grant`
  refuses them again.
- Updates stay on for official builds, now meaning "built without
  `DOOP_APP_URL`" instead of "opens doop.design".

## Approval source

The owner's brief for this branch, after the reviewer's finding in
`/tmp/reviews/acp-connect.md`. This contract records that scope.
