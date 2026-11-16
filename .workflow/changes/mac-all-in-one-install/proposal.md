# All-in-one Mac install

## Problem

A Mac user who wants Diazo on their own machine runs two installers, then points the app at the local server by hand, and the server does not start at login.

## Scope

- In: `scripts/install.sh` (checks, calls `install-local.sh` and `install-desktop.sh`, LaunchAgent, server choice, health wait, opens the app), the `diazo` command, `TRUSTED_ORIGINS` for the local origin, the desktop 0.16.0 Local Server menu and the status row in Settings → About.
- Out: Intel Macs and macOS before 26 for the server part (the app alone still installs); notarization (ADR 0007).

## Where the work is

- Branch `feat/mac-all-in-one`, three commits from `2e9bf275` to `c5db9d92`, PR #6 open against `main`; it should target `dev` under the branch flow.
- PR #6 edits `.context/RELEASE.md`, `FORK.md` and `README.md`, which this repository rework moves or removes. Rebase it onto the rework and move its new "All in one" section into `docs/RELEASE.md`; drop its `FORK.md` hunk (the same facts are in `docs/RELEASE.md`).
- Not yet run through Stip: no approval and no evidence are recorded.

## Decisions and open questions

- The installer calls the two existing scripts and never copies them.
- The Local Server menu runs fixed `container` commands on the `diazo` container only; the page only reads the status.
