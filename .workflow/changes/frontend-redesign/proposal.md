# Frontend redesign, part 1

## Problem

The web app still wears doop's white UI system, and several screens added by the fork were never designed as one product. The redesign frames on the canvas "redoop — Redesign 2026-11" (`bIK8evKpnI`) are the source of truth: the Cyanotype bench direction, one signal blue for people and one orange for agents.

## Scope

- In, done on the branch: foundations (light and dark palette, self-hosted fonts, type scale, radii, elevation, motion tokens in `src/lib/motion.ts`), primitives restyled after "01 Foundations" with stories, the floating editor shell, chat and composer, Home, and the Motion Studio UI (timeline, camera track, "Animate storyboard", MP4 and WebM export).
- In, done after the PR was closed: duel slots, the ⌘F palette sheet, libraries expand, settings connection cards, usage roll, frame check badges, token sync rows, comment pins, the sign-in sheet, compact update cards, stacked toasts, the page picker.
- Out: zones of the redesign not yet built; the design of screens the canvas does not cover.

## Where the work is

- Branch `feat/frontend-redesign`, 19 commits from `1d2ea805` to `00186484`, worktree under `.claude/worktrees/` of the main checkout.
- PR #5 was closed unmerged against `main`; it must be reopened against `dev`.
- The branch's Motion UI uses an adapter (`src/lib/motion/contract.ts`) to be replaced by the contract of `motion-studio-backend`.
- Not yet run through Stip: no approval and no evidence are recorded.

## Decisions and open questions

- Fonts: Direction B Hyperlegible, self-hosted ([ADR 0012](../../../docs/adr/0012-self-host-the-ui-fonts.md)).
- Older token names stay as aliases of the new roles so unmigrated screens keep working.
- After merge, the branch's lines that cite `.context/DESIGN.md` and `.context/TECHSTACK.md` must point at `docs/DESIGN.md` and `docs/TECHSTACK.md`, including the ESLint messages.
- Open: which redesign zones are left after part 1, and whether they ship in this change or a part 2.
