# 0009. Store one motion composition per ordinary page

One architecture decision for Diazo. Read by anyone, human or agent, about to change Motion Studio data or pages.

## Status

Accepted, 2026-11-15.

## Context

Motion Studio needs a place for a film's timeline. Its frames already live on a page, and pages already copy, version and broadcast. A new page type would split every page feature in two.

## Decision

An ordinary page gains a timeline: at most one composition per page (duration, fps, size, poster time, tracks), stored in `compositions` with up to 20 versions in `composition_versions`, copied with its page or canvas and deleted with its page. The page's frames are the stage.

## Alternatives rejected

- A new "film" page type. Rejected: Bryan's decision Q1; it duplicates page features.
- Keyframes only inside frame HTML. Rejected: a camera across frames needs page-level state.

## Consequences

- Good: storyboard, frames and film are the same page; copy and history come for free.
- Bad: a page cannot hold two films; a second film is a second page.

## Links

[.workflow/changes/motion-studio/proposal.md](../../.workflow/changes/motion-studio/proposal.md), sections 7.3 and 12; change `motion-studio-backend`.
