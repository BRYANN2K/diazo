# 0007. Ship the desktop app from the fork releases, unnotarized, through a curl installer

One architecture decision for Diazo. Read by anyone, human or agent, about to change the desktop app, its updates or its installer.

## Status

Accepted, 2026-11-15.

## Context

Shells installed from doop.design trust upstream's updater key and feed. Apple notarization needs a paid developer membership, and an unnotarized DMG opened from a browser download is blocked by Gatekeeper.

## Decision

`desktop-release.yml` builds the app on a `desktop-v*` tag and publishes it to this repository's releases, with `latest.json` copied onto the fixed `desktop-updates` prerelease the updater reads. Update packages are signed with the fork's own minisign key (id `B1375F7E88B8FC72`), whose private half lives only in the repository secrets. `scripts/install-desktop.sh` downloads the app with curl (no quarantine flag), checks `SHA256SUMS` and the minisign signature when available, and installs `Diazo.app` ad-hoc signed.

## Alternatives rejected

- Notarize through a paid Apple membership. Rejected: Diazo has no budget and is not sold.
- Keep upstream's feed. Rejected: the fork's builds and name differ.
- `releases/latest` as the feed. Rejected: any other release would take it over.

## Consequences

- Good: free distribution with signed updates and no Gatekeeper warning.
- Bad: a DMG downloaded in a browser still warns; the curl script is the supported path.
- Bad: losing the key means a new pair and one reinstall for every user (no data loss).

## Links

[RELEASE.md](../RELEASE.md).
