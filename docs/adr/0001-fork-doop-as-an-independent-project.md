# 0001. Fork doop as an independent project

One architecture decision for Diazo. Read by anyone, human or agent, about to change the relation with upstream doop.

## Status

Accepted, 2026-11-12.

## Context

doop (`kgoedecke/doop`, AGPL-3.0) is a multiplayer design canvas for humans and agents. Bryan needed it to stay fast on canvases of 5,000+ frames and to grow features for builders (libraries, checks, code links) faster than upstream review allows. Several useful upstream pull requests were open and unmerged.

## Decision

We keep a fork in `BRYANN2K/diazo` (`origin`), with `kgoedecke/doop` as `upstream`. We merge chosen upstream pull requests one by one, resolving conflicts by hand to keep both intents, and we never push to upstream. The fork builds its own features on top. On 2026-11-12 it merged #412, #314, #434–#437, #439, #399, #456, #277, #390, #505, #462, #476, #457 and #506, and dropped #299.

## Alternatives rejected

- Contribute everything upstream and wait. Rejected: the pace and the scope (a non-commercial, self-hosted tool for builders) differ from upstream's.
- Start a new canvas from scratch. Rejected: doop already has the realtime room, the MCP server and the renderer, and they work.

## Consequences

- Good: the fork ships at its own pace and keeps doop's tested core.
- Good: upstream fixes can still come in, by PR or by merge.
- Bad: every resync costs conflict work, more as the fork diverges ([runbooks/upstream-resync.md](../runbooks/upstream-resync.md)).
- Bad: upstream-only machinery (CLA, release-please, iOS signing) must be switched off or removed in the fork.
