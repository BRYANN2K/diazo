# 0002. Rename the fork to Diazo and keep internal doop identifiers

One architecture decision for Diazo. Read by anyone, human or agent, about to change names, marks or identifiers.

## Status

Accepted, 2026-11-15.

## Context

doop's name and Disc-D logo are its owner's trademarks, and its reference asks derived services to rebrand. The fork was first called redoop. Renaming everything, including code identifiers, would break stored data, MCP clients, desktop deep links and existing installs.

## Decision

The product is **Diazo** and its agent the **Diazo Agent** (`@diazo`). Everything a user sees says Diazo: UI strings, emails, the agent guide, the marks in `src/components/Logo.tsx`, `Diazo.app` (`dev.bryann2k.diazo`), the installers and the image `ghcr.io/bryann2k/diazo`. Internal identifiers keep `doop`: `data-doop-*` attributes, `doop:` storage keys, `DOOP_*` env vars, `doop-secrets` and the `doop` namespace, tables, MCP tool names, `doop://`, the `doop-desktop` executable, crate and package names, the `Doop Keys` font, `.doop.json`. Aliases stay: `@doop`, `doop-instructions`, the `doop` CLI command, `doop-local`.

## Alternatives rejected

- Keep the doop name. Rejected: it is a trademark of its owner.
- Rename the internal identifiers too. Rejected: it breaks data, integrations and installed apps for no user benefit.

## Consequences

- Good: no trademark use, and no migration of user data.
- Bad: contributors see `doop` in code and must not "fix" it in a branding pass.
- Bad: shells ≤ 0.14 and doop.design installs need one reinstall through the curl script to follow the new feed.

## Confirmation

Review rule in [AGENTS.md](../../AGENTS.md): no doop mark or name in user-facing text or art.
