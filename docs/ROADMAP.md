# Diazo roadmap

What gets built, in what order, and where each piece stands. Read by Bryan and by agents choosing or checking the next change.

Status: active, updated 2026-11-16

Each row is a change in `.workflow/changes/<id>/`. Status is its workflow phase. No change below has been checked yet: the code on the branches exists, but its evidence is not recorded.

## Now

| Change                   | Outcome                                                                       | Serves | Depends on              | Status | Evidence                             |
| ------------------------ | ----------------------------------------------------------------------------- | ------ | ----------------------- | ------ | ------------------------------------ |
| `motion-studio-backend`  | A page carries a seekable composition; agents, REST and the desktop render it | G7     | –                       | draft  | none yet; PR to reopen against `dev` |
| `frontend-redesign`      | The Cyanotype bench UI, self-hosted fonts, the Motion Studio panel            | G1, G7 | `motion-studio-backend` | draft  | none yet; PR to reopen against `dev` |
| `mac-all-in-one-install` | One command installs the local server and the app, started at login           | G2     | –                       | draft  | none yet; PR #6                      |

## Next

| Change             | Outcome                                                                                                                                   | Serves | Depends on                                   | Status    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- | --------- |
| `orca-integration` | Ready for dev → an Orca worktree and coding agent, with live status on the frame                                                          | G4     | `frontend-redesign` (Inspector)              | exploring |
| `motion-studio`    | Phases 2 to 5: keyframes and code export, media and captions, 3D, server renders                                                          | G7     | `motion-studio-backend`, `frontend-redesign` | exploring |
| `agent-cost`       | Script tools and server-side checks: a canvas job in about 9 model turns instead of 24 to 52, with renders equal or better (quality gate) | G3, G5 | –                                            | draft     |

Motion Studio phases, from [its proposal](../.workflow/changes/motion-studio/proposal.md):

| Phase   | Scope                                                                                     | Done when                                                 |
| ------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 0       | Runtime with `--t`, markup contract, `MO-*` lint, snapshots and checks at any time        | An agent-written frame scrubs and snapshots at any time   |
| 1 (MVP) | Timeline on a page, storyboard, camera across frames, the agent animates, MP4 and WebM    | A 15 s film from three frames, with no tool outside Diazo |
| 2       | Layer keyframes and easing, transitions, text animator, masks, library clips, code export | A motion spec a developer can paste                       |
| 3       | Video and audio layers, transcript cuts, captions, beats, generated video                 | A narrated walkthrough cut inside Diazo                   |
| 4       | Blender link through the desktop app, three.js layers, 3D in ordinary frames              | A 3D hero that is also a shot in the film                 |
| 5       | Server renders, Lottie, HyperFrames import and export, motion duel                        | –                                                         |

Orca phases, from [its proposal](../.workflow/changes/orca-integration/proposal.md): 0 spike, 1 "Send to Orca" and the status light on this Mac and the VPS, 2 preview, drift review and remote hosts, 3 code duel, session search and automations.

## Later

- One brand pass over the shared components that still show doop's mark or name (`ShellTitle`, `Avatar kind=agent`, `StageBoard`).
- Desktop 0.16.0 release, which ships the Local Server menu and the ACP and repo commands that need a shell release.
- Acceptance criteria for the migrated prose specs in `.workflow/specs/`, written by the next change that targets each one.
- Decide the future of the inherited iOS app, browser and editor plugins, and the Team plan (PRD Q1, Q2).

## Pending checks

| Change                   | AC         | What is missing                                                          |
| ------------------------ | ---------- | ------------------------------------------------------------------------ |
| `motion-studio-backend`  | AC-1–AC-11 | Approval, then the change check on the branch: CI suite and Rust tests   |
| `frontend-redesign`      | AC-1–AC-7  | Approval, then screenshots in light and dark against the redesign frames |
| `mac-all-in-one-install` | AC-1–AC-9  | Approval, then a run on a clean Apple silicon Mac with macOS 26          |

## Done

Built before the change workflow and migrated by hand; each `archive-note.md` names the merge commits. No recorded evidence.

| Change               | Archived   | Spec                                    |
| -------------------- | ---------- | --------------------------------------- |
| `design-libraries`   | 2026-11-16 | `.workflow/specs/design-libraries.md`   |
| `ai-dev-features`    | 2026-11-16 | –                                       |
| `link-local-project` | 2026-11-16 | –                                       |
| `image-descriptions` | 2026-11-16 | `.workflow/specs/image-descriptions.md` |

## Parallel waves

```
Wave 1  motion-studio-backend   mac-all-in-one-install
Wave 2  frontend-redesign
Wave 3  orca-integration        motion-studio (phase 2)
```

## Not doing

- Natron, Friction, Synfig and similar tools as integrations: each is a second editor with its own model.
- Embedding the HyperFrames runtime: its default adapter is GSAP ([ADR 0010](adr/0010-adopt-the-hyperframes-contract-with-a-waapi-runtime.md)).
- Upstream PR #299 (an older component library): it would add a second component system.
- A public ingress, tunnel or Funnel for the owner's instance ([ADR 0004](adr/0004-expose-the-instance-over-tailscale-only.md)).
