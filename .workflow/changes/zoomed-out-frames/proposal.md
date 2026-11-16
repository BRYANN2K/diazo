# Reliable zoomed-out frame previews

Status: active, updated 2026-11-16

## Problem and authorized scope

Resume the two existing branch commits and the in-progress review fixes. The owner explicitly requested completion of all blockers and should-fix findings in the supplied review, inexpensive nits, regression tests, a first zoom-out longest-task measurement, and an updated local pull request draft.

Keep width buckets, stored thumbnails, the shared loader, neutral placeholders and the live-document cross-fade. Do not mount more documents, load deferred HTML in the client, or pre-render every written frame. Keep render work demand-driven, with quiet-time refresh only for recently requested variants. No dependencies, migrations, release changes, publication or pushes.

## Decisions

Persist preview versions and a design fingerprint beside their image objects. The fingerprint excludes position and catches an edit even after a process stops before its freshness notification persists. Keep concurrent render work bounded. Retain decoded images, batch cache notifications per animation frame, and bound inactive cache entries by count and compressed bytes.

## Approval source

The continuation request authorizes finishing the supplied review brief within this existing approach. This contract records that scope; it does not add new product decisions.
