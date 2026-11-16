# Reliable zoomed-out frame previews

Status: active, updated 2026-11-16

## Intent

Make zoomed-out frames show reliable stored pictures without increasing live documents or loading deferred client HTML.

## Acceptance criteria

- AC-1: A write during the first render cannot label old bytes current or immutable under the new version; only fresh stage images enter the current-version cache. Stored objects carry the render version.
- AC-2: A restart and a position-only move reuse unchanged stored pictures without rendering. An actual design edit remains stale across a restart, including a missed freshness notification.
- AC-3: Restyling a live frame leaves it able to persist pictures. Deleted-frame guards expire after pending renders settle. Derived-object deletion has bounded concurrency.
- AC-4: Requests handle 429, 503 and network failures with bounded retries and Retry-After. Failed and stale markers are bounded and a returning frame can retry.
- AC-5: Cache satisfaction includes format. Inactive pictures on the open page can be evicted despite subscribers, with a 400-entry and 64 MiB compressed-byte budget. Visible holders can exceed the budget until released.
- AC-6: Cache notifications batch per animation frame. Initial picture arrivals do not animate separately and decoded images remain retained while displayed.
- AC-7: Browser regressions cover painted pictures, deferred HTML, edit replacement, stale responses, transparent shapes, and a single cover fade followed by a painted live document. The cover expires if its runtime never replies.
- AC-8: HTTP regressions cover immutable fresh versioned images, no-store stale images, short caching for other versions, and invalid width rejection.
- AC-9: Measure first zoom-out longest main-thread task and count above 50 ms, distinguish camera work from picture arrivals, and report any unmet performance bar rather than claiming success from summed duration.
- AC-10: Update standing documentation, change evidence and the local pull request draft; run required checks before a scoped local commit. Never push, open a pull request or build container images.
