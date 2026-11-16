# Tasks

- [x] Storage module `src/lib/composerDrafts.ts`: debounced write, read,
      clear, prune (AC-1, AC-3).
- [x] Store and composer wiring: persist on `setComposerDraft`, hydrate on
      PromptBar mount, flush on `pagehide` (AC-1, AC-2).
- [x] Home handoff keeps working (AC-4).
- [x] Tests for persistence, restore, clear-on-send, per-canvas drafts and
      pruning (AC-6).
- [x] Checks, evidence, PR draft and scoped commit (AC-5, AC-7).
- [x] Review: scope the key by account, purge on every sign-out path
      (account menu, account deletion, session ending), reset in-memory
      drafts on an account change (AC-8).
- [x] Review: prune before write, 20,000-character cap, flush on
      `visibilitychange` hidden (AC-9).
