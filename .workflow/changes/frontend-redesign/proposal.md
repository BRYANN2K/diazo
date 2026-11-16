# Frontend redesign, part 1

## Problem

The web app still wears doop's white UI system, and several screens added by the fork were never designed as one product. The redesign frames on the canvas "redoop — Redesign 2026-11" (`bIK8evKpnI`) are the source of truth: the Cyanotype bench direction, one signal blue for people and one orange for agents.

## Scope

- In, done on the branch: foundations (light and dark palette, self-hosted fonts, type scale, radii, elevation, motion tokens in `src/lib/motion.ts`), primitives restyled after "01 Foundations" with stories, the floating editor shell, chat and composer, Home, and the Motion Studio UI (timeline, camera track, "Animate storyboard", MP4 and WebM export).
- In, done after the PR was closed: duel slots, the ⌘F palette sheet, libraries expand, settings connection cards, usage roll, frame check badges, token sync rows, comment pins, the sign-in sheet, compact update cards, stacked toasts, the page picker.
- Out: zones of the redesign not yet built; the design of screens the canvas does not cover.

## Where the work is

- Branch `feat/frontend-redesign`, from `1d2ea805`; it merged `feat/motion-backend` (`2fdd8c6b`) and `origin/dev` (`cda02310`). Worktree under `.claude/worktrees/` of the main checkout.
- PR #5 was closed unmerged against `main`; it must be reopened against `dev`.
- The Motion UI now reads the contract of `motion-studio-backend` directly (`src/lib/motion/contract.ts` re-exports it) and follows the canvas room.
- Evidence is recorded in `evidence.md` and the steps in `tasks.md`; no approval is recorded yet.

## Decisions and open questions

- Fonts: Direction B Hyperlegible, self-hosted ([ADR 0012](../../../docs/adr/0012-self-host-the-ui-fonts.md)).
- Older token names stay as aliases of the new roles so unmigrated screens keep working.
- Done in the merge: the branch's design and techstack notes now live in `docs/DESIGN.md` and `docs/TECHSTACK.md`.
- Open: tasks 21 to 23 (zoom and settings island, Memory panel, duel running and results cards), in this change or a part 2.
