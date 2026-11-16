# Persist the composer draft per canvas

Status: active, updated 2026-11-16

## Problem and authorized scope

An unsent prompt in the Agents tab composer lives only in memory
(`composerDrafts` in `src/lib/store.ts`, keyed by canvas). It survives
in-page navigation, but a reload, a hard redirect (session-expiry reload,
desktop sign-in handoff, `location.href` exits) or a desktop relaunch
wipes it. The owner asked for per-browser persistence of the unsent text.

Scope: persist each canvas's draft text in `localStorage` under
`doop:composer-draft:<canvasId>`, debounced, pruned by age and count,
restored when the composer mounts. Attachments stay in memory only. No
schema, dependency, migration, release or publication work. Never push,
open a pull request or build container images.

## Decisions

Keep `composerDrafts` as the live in-memory copy; `localStorage` is the
parked copy written on a trailing debounce and removed when the card
queues. A mount-time hydration pulls the parked text back when memory has
no entry for the canvas, so a session draft always wins over a parked one.
Entries carry `{ text, at }`; a write pass drops malformed, 30-day-old and
over-50-canvas entries. A `pagehide` flush saves the last keystrokes
before a reload.

## Approval source

The owner's bug report specifies the storage key, the debounce, the prune
bounds (30 days, 50 canvases), the clear-on-queue behaviour and the test
expectations. This contract records that scope; it adds no product
decisions.
