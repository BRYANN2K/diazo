# Runbook: take changes from upstream doop

How to bring commits or pull requests from `kgoedecke/doop` into Diazo, and what the fork has already taken or refused. Read by Bryan and by agents before a resync.
Status: last resync 2026-11-12 (the PR merges below), not run end to end since the branch flow; updated 2026-11-16

Never push to `upstream`. `origin` is `BRYANN2K/diazo`.

## Purpose

- Runs: a merge of upstream work into the fork, through the branch flow ([ADR 0006](../adr/0006-merge-through-dev-staging-and-main.md)).
- Open this when: an upstream fix or feature is wanted, or before a long gap makes the merge harder.

## Resync

```sh
git fetch upstream
git switch -c chore/upstream-sync origin/dev
git merge upstream/main
# Expect: conflicts listed. Resolve them keeping both intents, and the rules below.
bun install && bun run typecheck && bun run lint && bun run test
# Expect: all pass
git push origin chore/upstream-sync
# Expect: a branch to open as a pull request into dev, shown to Bryan as a local draft first
```

To take one upstream pull request instead: `git fetch upstream pull/<n>/head:pr-<n>`, merge `pr-<n>` into a `chore/upstream-pr-<n>` branch from `dev`, then the same checks.

## Rules while resolving

- Keep Diazo's names in everything a user sees, and upstream's `doop` in internal identifiers ([ADR 0002](../adr/0002-rename-the-fork-to-diazo.md)).
- The fork removed upstream's CLA (`CLA.md`, `.github/workflows/cla.yml`). A conflict on them resolves by keeping them deleted.
- `release-please.yml` stays, guarded to run upstream only; its config and manifest come in unchanged.
- Upstream's `CHANGELOG.md` entries do not come in; `CHANGELOG.md` is the fork's.
- `ios-release.yml` needs upstream's signing secrets: never push an `ios-v*` tag in the fork.
- Update [docs/FEATURES.md](../FEATURES.md) ("Merged upstream PRs") with each PR taken.

## Pull requests merged on 2026-11-12

### Performance (canvas and zoom)

| PR   | What it brings                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #412 | Per-page lazy loading of frame HTML and culling of off-screen frames (iframes out of view are unmounted and replaced by placeholders).                    |
| #314 | Level of detail: a budget of live frames, the rest drawn as server images (`frameLod.ts`, `useFrameLods`), on top of #412: `live` / `image` / `none`.     |
| #434 | Render optimisation while zooming.                                                                                                                        |
| #435 | The stage bounding box is read once per wheel flush instead of once per event.                                                                            |
| #436 | More zoom and pan optimisation.                                                                                                                           |
| #437 | Camera CSS variables are written on the node that reads them (`world`); `--zoom` stays exposed to rulers and guides through a `display:contents` wrapper. |
| #439 | No more whole-page style invalidation on every pan step.                                                                                                  |

### Reliability

| PR   | What it brings                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #399 | Recovery of a wedged Chromium renderer (relaunch and retry), folded into #456's `createRenderer` / `withPage`; `tests/renderBrowser.test.ts` covers it. |
| #456 | Hardened renderer: remote browser, page leases, queues, pixel and concurrency limits (`renderLimits.ts`), `/healthz/renderer`.                          |
| #277 | `edit_frame_source`: literal replacement in frame HTML. The existing `editFrameSource` helper was kept and the PR's test added.                         |
| #390 | No ghost presences when two joins overlap.                                                                                                              |
| #505 | Hardening: frame CSP, non-root container, gated agent style-guide writes.                                                                               |

### Features

| PR   | What it brings                                                                   |
| ---- | -------------------------------------------------------------------------------- |
| #462 | Cut (⌘X) frames and layers, through a shared canvas clipboard.                   |
| #476 | Image placement at native size, HTTP upload-and-place endpoint.                  |
| #457 | OpenCode in the Connect AI picker (brand mark and icon).                         |
| #506 | External stylesheets synced into frames, with their `url()`s and fonts resolved. |

## Pull requests refused

| PR   | Reason                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #299 | An older component library (about 10k lines), written before upstream shipped its own (`componentActions`, `componentEngine`, `componentTools`, `ComponentsPanel`, migration `0052_components.sql`). Merging it would remove the current implementation and add a second, parallel system. |
