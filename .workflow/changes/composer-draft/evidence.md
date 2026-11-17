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
one write 400 ms after the last one, under `doop:composer-draft:<userId>:<canvasId>`
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

`bunx vitest run tests/composerDrafts.test.ts tests/promptComposer.test.tsx tests/homePrompt.test.ts --maxWorkers=2` —
3 files, 35 tests, all pass (after the review fixes).
`bunx vitest run tests/accountMenu.test.tsx tests/deleteAccount.test.tsx tests/composerDrafts.test.ts --maxWorkers=2` —
3 files, 24 tests, all pass.

## AC-8 — drafts belong to the account

`setComposerDraftOwner` (`src/lib/composerDrafts.ts`) is called by
`src/App.tsx` during render once the session has resolved without error:
the composer hydrates in a mount effect, which runs before App's effects.
A new account removes every key not under its own id; the owner going
from an account to null purges all keys. An owner change also resets the
store's in-memory `composerDrafts` (App effect). `purgeComposerDrafts` is
called after `authClient.signOut()` in `src/components/DashShell.tsx` (the
only sign-out call in `src/`) and in `leaveDeletedAccount` in
`src/components/DeleteAccount.tsx`. Signed out, writes and reads are
no-ops. Keys from before the account prefix (no `:` after the prefix) are
pruned.

Tests: `tests/composerDrafts.test.ts` "the composer draft owner" (scoping,
signed out, session end, sign-out purge across accounts, same owner kept,
legacy keys); `tests/promptComposer.test.tsx` "never shows one account the
draft another parked".

## AC-9 — limits

`store()` prunes (keeping a seat for the key being written) before
`setItem`; `MAX_PARKED_CHARS` is 20,000; `src/main.tsx` flushes on
`visibilitychange` to hidden. Tests: "the composer draft limits" (length
cap drops the shorter copy; a storage refusing writes until an expired
entry is pruned accepts the write).

## AC-7 — checks

- `bun run typecheck` — exit 0.
- `bunx oxlint --type-aware --deny-warnings .` — exit 0.
- `bunx eslint . --max-warnings 0` — exit 0.
- `bunx prettier --check` on changed files — clean after one format fix.
- `bun run doc-lint` — passed, 0 warnings.
