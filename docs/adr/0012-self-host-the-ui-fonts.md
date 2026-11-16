# 0012. Self-host the UI fonts (Direction B Hyperlegible)

One architecture decision for Diazo. Read by anyone, human or agent, about to change fonts or the design foundations.

## Status

Accepted, 2026-11-15.

## Context

The UI loaded Inter, Hanken Grotesk and Geist Mono from Google Fonts. The redesign picked Direction B: Atkinson Hyperlegible Next and Mono for the chrome and values, Familjen Grotesk for headings. A request to Google on every page load leaks the visitor's address and fails offline.

## Decision

The UI's faces ship as variable woff2 files (latin and latin-ext) in `src/assets/fonts`, with their OFL licence files beside them. The UI makes no Google Fonts request for its own faces. The `Doop Keys` symbol subset stays inlined in `src/styles.css`.

## Alternatives rejected

- Keep Google Fonts. Rejected: third-party requests and no offline use.
- System fonts only. Rejected: the redesign's hierarchy depends on these faces.

## Consequences

- Good: private, offline-capable, and the same rendering everywhere.
- Bad: a font update is a file change in the repo; the bundle grows by the font files.

## Links

Change `frontend-redesign` (commit `1d2ea805`); [THIRD-PARTY-LICENSES](../../THIRD-PARTY-LICENSES).
