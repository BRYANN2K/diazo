# Architecture decision records

Index of the architecture decisions for Diazo. Read by contributors and agents before changing an area.
Status: current, updated 2026-11-16

## Rules

- **Write an ADR** when a choice shapes structure, interfaces, dependencies, data, security or the toolchain, or is costly to reverse.
- **Skip it** for small, local or temporary choices. Those stay in the Stip change proposal.
- A change-level decision that outlives its change becomes an ADR at the stip-docs step.
- Format: Status, Context, Decision, Alternatives rejected, Consequences. Start from [TEMPLATE.md](TEMPLATE.md).
- Files are named `NNNN-imperative-short-title.md`. Numbers run in order, with no gaps and no reuse.
- Status records the decision only: Proposed, Accepted, Superseded by NNNN, or Withdrawn. Implementation progress lives in the Stip evidence.
- **Never edit an accepted ADR.** Write a new one that supersedes or amends it, then update both rows here. Only its Status line may change (Superseded by NNNN) and typos may be fixed.
- A withdrawn number stays in this table as Withdrawn, with the reason.
- Agents propose (Proposed). Bryan accepts.

ADRs 0001 to 0012 record decisions Bryan made before this index existed; their dates are the day the decision was made or merged.

## Index

| ADR                                                                   | Decision                                                                           | Status                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| [0001](0001-fork-doop-as-an-independent-project.md)                   | Fork doop as an independent project                                                | Accepted, 2026-11-12         |
| [0002](0002-rename-the-fork-to-diazo.md)                              | Rename the fork to Diazo and keep internal doop identifiers                        | Accepted, 2026-11-15         |
| [0003](0003-keep-agpl-and-stay-non-commercial.md)                     | Keep the AGPL-3.0 licence and stay non-commercial                                  | Accepted, 2026-11-15         |
| [0004](0004-expose-the-instance-over-tailscale-only.md)               | Expose the owner instance over Tailscale only                                      | Accepted, 2026-11-12         |
| [0005](0005-use-pglite-when-no-database-is-configured.md)             | Use an embedded PGlite when no database is configured                              | Accepted, 2026-11-14         |
| [0006](0006-merge-through-dev-staging-and-main.md)                    | Merge through dev, staging and main by pull request                                | Accepted, 2026-11-16         |
| [0007](0007-ship-the-desktop-app-from-our-own-releases.md)            | Ship the desktop app from the fork releases, unnotarized, through a curl installer | Accepted, 2026-11-15         |
| [0008](0008-run-local-cli-agents-over-acp-through-the-desktop-app.md) | Run local CLI agents over ACP through the desktop app                              | Accepted, 2026-11-15         |
| [0009](0009-store-one-motion-composition-per-page.md)                 | Store one motion composition per ordinary page                                     | Accepted, 2026-11-15         |
| [0010](0010-adopt-the-hyperframes-contract-with-a-waapi-runtime.md)   | Adopt the HyperFrames timing contract with a WAAPI and CSS runtime, without GSAP   | Accepted, 2026-11-15         |
| [0011](0011-reach-blender-through-the-desktop-app.md)                 | Reach Blender as an MCP server through the desktop app                             | Accepted, 2026-11-15         |
| [0012](0012-self-host-the-ui-fonts.md)                                | Self-host the UI fonts (Direction B Hyperlegible)                                  | Accepted, 2026-11-15         |
| [0013](0013-plan-work-with-stip.md)                                   | Plan and track work with Stip                                                      | Accepted, updated 2026-11-16 |
| [0014](0014-run-speech-engines-on-the-desktop-or-the-server.md)       | Run speech engines on the desktop or the server, voice-over on ElevenLabs too      | Proposed, 2026-11-16         |
