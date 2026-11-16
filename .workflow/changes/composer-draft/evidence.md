# Evidence

Status: current, updated 2026-11-16

## Root cause

`composerDrafts` in `src/lib/store.ts` is an in-memory map on the module
singleton. Nothing clears it on canvas change, so in-page navigation
already kept a draft — the report's "wiped on switch" is the store itself
going away: full reloads, a desktop relaunch, and the hard navigations in
`src/lib/ws.ts` (`location.reload()` on a 4401 close, `location.href` on
4403 / `canvas:deleted`), `src/lib/desktop.ts` (`location.assign` on the
sign-in and connect handoffs) and `src/pages/AuthPage.tsx`.

## AC-1 — parked on a debounce, cleared at once

`src/lib/composerDrafts.ts`: `writeComposerDraft` batches keystrokes into
one write 400 ms after the last one, under `doop:composer-draft:<canvasId>`
as `{ text, at }`. `clearComposerDraft` cancels a pending write and removes
the key immediately. `store.setComposerDraft` writes on non-empty text and
clears on empty — `sendPrompt` clears through it once the card is queued,
as before. `window` `pagehide` in `src/main.tsx` flushes pending writes so
the last keystrokes before a reload are not lost.

`tests/composerDrafts.test.ts`: debounce landing, keystroke coalescing,
clear-inside-the-window, on-demand flush.

## AC-2 — restored on mount

`store.hydrateComposerDraft(canvasId)` reads the parked draft only when
memory has no entry for the canvas; `PromptBar` calls it in a
`useLayoutEffect` so the text is there before paint. Covers reloads,
desktop relaunches and hard navigations; an in-memory draft always wins.

`tests/promptComposer.test.tsx`: "parks the draft and restores it after a
reload", "prefers an in-memory draft over an older parked one".

## AC-3 — pruned by age and count

`pruneComposerDrafts` drops unreadable, empty and over-30-day entries and
keeps only the 50 most recently touched canvases. It runs inside the
debounced write. `tests/composerDrafts.test.ts`: malformed/empty/expired
reads as absent; a 55-canvas write pass leaves the newest 50 and leaves
foreign keys alone.

## AC-4 — Home handoff

`Home.tsx` still calls `setComposerDraft` before opening the fresh canvas;
the draft sits in memory on arrival and is also parked. Test: "fills the
composer from a draft handed off before mount".

## AC-5 — attachments

`PromptBar`'s `attachments` state stays in memory only (object URLs cannot
survive a reload). Stated in the PR draft.

## AC-6 — tests

`bunx vitest run tests/composerDrafts.test.ts tests/promptComposer.test.tsx tests/homePrompt.test.ts tests/viewOptions.test.ts --maxWorkers=2` —
4 files, 31 tests, all pass.

## AC-7 — checks

- `bun run typecheck` — exit 0.
- `bunx oxlint --type-aware --deny-warnings --ignore-pattern '.claude/**' .` — exit 0.
- `bunx eslint . --max-warnings 0` — exit 0.
- `bunx prettier --check` on changed files — clean after one format fix.
- `bun run doc-lint` — passed, 0 warnings.
