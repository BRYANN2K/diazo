# Persist the composer draft per canvas

Status: active, updated 2026-11-16

## Intent

An unsent Agents-tab composer draft survives a canvas switch, a reload, a
hard navigation and a desktop relaunch, per browser, without holding more
than recent drafts.

## Acceptance criteria

- AC-1: Typing in the composer writes the draft to `localStorage` under
  `doop:composer-draft:<canvasId>` on a debounce; clearing the field or
  queueing the card removes the key immediately, including a pending
  debounced write.
- AC-2: A composer mounting for a canvas whose memory has no draft
  restores the parked text — covering reloads, desktop tab switches after
  a relaunch and hard navigations. An existing in-memory draft is never
  overwritten by a parked one.
- AC-3: Entries older than 30 days, malformed entries, and entries beyond
  the 50 most recently touched canvases are pruned on write.
- AC-4: The Home prompt's handoff draft (`setComposerDraft` before
  opening the fresh canvas) still pre-fills the composer.
- AC-5: Attachments are not persisted; the limitation is documented in
  the pull request draft.
- AC-6: Tests cover: type then come back to the canvas after a simulated
  reload (text restored), send (storage cleared), two canvases keeping
  separate drafts, and the prune rules.
- AC-7: Required checks run before a scoped local commit: typecheck,
  `oxlint --type-aware --deny-warnings`, `eslint --max-warnings 0`,
  Prettier on changed files, affected tests with `--maxWorkers=2`.
