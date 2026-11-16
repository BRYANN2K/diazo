# 0004. Expose the owner instance over Tailscale only

One architecture decision for Diazo. Read by anyone, human or agent, about to change deployment or networking of the hosted instance.

## Status

Accepted, 2026-11-12.

## Context

The owner's instance runs on k3s on a VPS that also hosts other private services. It holds design work, model keys and agent access through MCP. Signup is open until the first account exists.

## Decision

The Service stays `ClusterIP`. The host exposes it with `tailscale serve` on the tailnet only (`:8850` → `svc/doop:4400`). No ingress, no cloudflared, no Tailscale Funnel.

## Alternatives rejected

- A public ingress with TLS and auth. Rejected: a larger attack surface for a single-owner tool.
- A Cloudflare tunnel or Funnel. Rejected: same exposure, plus a third party in the path.

## Consequences

- Good: only tailnet devices reach the server, the MCP endpoint included.
- Bad: agents and people must be on the tailnet; public share links do not work from outside.
- Bad: preview deploys and webhooks from public CI cannot reach the instance.

## Links

[runbooks/k3s-deploy.md](../runbooks/k3s-deploy.md).
