# 0003. Keep the AGPL-3.0 licence and stay non-commercial

One architecture decision for Diazo. Read by anyone, human or agent, about to change licensing, billing or what Diazo sells.

## Status

Accepted, 2026-11-15.

## Context

doop is AGPL-3.0, and its CLA lets its maintainer offer it under other terms. The fork inherits AGPL code it cannot relicense. It also inherits a Stripe Team plan. Motion Studio's proposal states that Diazo is not commercialised and that the only costs are the user's own.

## Decision

Diazo stays AGPL-3.0, with third-party parts under their own licences (see [NOTICE](../../NOTICE) and [THIRD-PARTY-LICENSES](../../THIRD-PARTY-LICENSES)). Diazo is not sold: no paid plan, no feature behind payment. The fork has no CLA; a contribution is licensed AGPL-3.0 like the rest.

## Alternatives rejected

- Dual licensing with a CLA, like upstream. Rejected: the fork does not own upstream's code and has no commercial plan.
- A paid hosted tier. Rejected: the product is self-hosted by design.

## Consequences

- Good: users keep the four freedoms, network users included.
- Good: no CLA friction for contributors.
- Bad: the inherited billing code stays dormant until it is removed (PRD Q2).
