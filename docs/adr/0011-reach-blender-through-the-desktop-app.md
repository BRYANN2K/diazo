# 0011. Reach Blender as an MCP server through the desktop app

One architecture decision for Diazo. Read by anyone, human or agent, about to change Blender, 3D or the desktop bridge.

## Status

Accepted, 2026-11-15.

## Context

Motion Studio's 3D phase needs Blender scenes in frames and Blender renders for 3D shots. Blender is GPL, runs on the user's machine, and its MCP servers run unsandboxed Python.

## Decision

The desktop shell finds Blender and spawns or attaches to an allowlisted Blender MCP server on loopback, like the local agents. Diazo's agents and editor use it through the app, with a native approval per kind of action; running arbitrary Python and saving over a `.blend` always ask. Diazo never bundles Blender or its code. The bridge is off unless `DOOP_BLENDER_BRIDGE` is set. Which Blender MCP server is decided after a licence check; Mac first.

## Alternatives rejected

- Blender on the server. Rejected: GPU-bound, heavy, and outside the user's control.
- A Diazo add-on inside Blender as the only link. Rejected: it would be GPL code to maintain; it may come later in its own repository.

## Consequences

- Good: no GPL code in Diazo, and the user's Blender and GPU do the work.
- Bad: 3D works only in the desktop app.

## Links

[.workflow/changes/motion-studio/proposal.md](../../.workflow/changes/motion-studio/proposal.md), sections 8 and 12.
