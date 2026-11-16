# 0008. Run local CLI agents over ACP through the desktop app

One architecture decision for Diazo. Read by anyone, human or agent, about to change agent runners or the desktop bridge.

## Status

Accepted, 2026-11-15.

## Context

Builders already pay for Claude, Devin or Grok subscriptions and have their CLIs signed in on their Mac. The server cannot use those subscriptions, and storing their credentials on a server is out of the question.

## Decision

The desktop shell starts the CLI already installed on the computer (`devin acp`, `grok agent stdio`; the Claude Plan through Claude Code) and drives it over the Agent Client Protocol, with the run's Diazo MCP server attached. Each is its own runner connection (`devin-local`, `grok-local`). Permission requests are granted for Diazo's canvas tools only.

## Alternatives rejected

- Ask users for API keys instead. Rejected: double payment for people who already have a subscription.
- Run the CLIs on the server. Rejected: their credentials would leave the user's machine.

## Consequences

- Good: no new cost and no credential leaves the Mac.
- Bad: these runners work only while the desktop app is open, and new CLIs need a desktop release.
