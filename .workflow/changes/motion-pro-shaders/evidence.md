# Evidence

Recorded on `feat/motion-pro-shaders` (worktree `doop-wt/motion-shaders`).

- AC-1 **passed** — all 43 ids sit in `GL_EFFECT_IDS` with a `BODY`; the
  static uniform test lives in `tests/motionPro.test.ts` (`gl shader
coverage`) and passes.
- AC-2 **passed** — one commit per group, in order: `6281b7a2` (bloom,
  curves, lens-blur), `dad8c4d3` (matte set), `ebb5b0e0` (lens flare, god
  rays), `ff408482` (optics/warps), `3b4ddefd` (generators). Pipeline fix
  ahead of them: `826cae25`.
- AC-3 **passed** — `lintComposition` over a stack of all 43 effects yields
  zero MO-14 issues (test in `motionPro.test.ts`); the browser test still
  sees 'no shader in this build' for an unregistered id.
- AC-4 **passed** — `tests/motionGoldenBrowser.test.ts` renders each
  `GL_EFFECT_IDS` member twice at the same t and compares hashes; goldens
  regenerated via `DOOP_GOLDEN_UPDATE=1` (Chrome for Testing,
  `CHROME_PATH` set); all 7 golden tests pass in normal mode.
- AC-5 **passed** — `bun run typecheck`, `bun run lint`,
  `bun run format:check`, `bun run doc-lint` all clean; motion suites green:
  motionPro 22, motionGoldenBrowser 7, motion/motionPhase2/motionPhase5/
  motionProTools/motionServerRender/motionLint 89, motionStudio/
  motionTokens/motionPro 34. `docs/motion-fx.md` and `docs/FEATURES.md`
  updated to the 43-body coverage and the sub-pass/`u_tex2` contract.

Notes: `needsInput` effects self-map on `u_tex2` until instances can bind a
second texture (spec non-goal). `docs/motion-api.md` picked up a stray
prettier table-whitespace fix while normalizing the worktree.

## Review round 2 (rebased onto origin/dev)

The branch was rebased `--onto origin/dev 28a726fd`; the 16 commits replay
cleanly and four fix commits close both review documents.

- Multi-pass `mix < 1` blends against the `tex[2]` snapshot, not the
  ping-pong buffer the sub-passes overwrote; the snapshot copy skips when
  the input already sits on `tex[2]` (no self-sampling draw). A
  vignette/bloom/lens-blur chain plus a scratch-buffer chain render with
  zero drops and identical repeated hashes —
  `tests/motionGoldenBrowser.test.ts`, `f9417401`.
- The golden scene gained alpha (translucent third) and a bloom highlight;
  neutral defaults got visible params; every effect's grid must now differ
  from the untouched picture. Goldens regenerated —
  `tests/fixtures/motion-golden.json`, `f9417401`.
- 21 params are marked `unit: 'px'` and multiplied by the render scale
  (`job.width / comp.width`, passed through `paintShutter`/`paintAt`/
  `paintSceneFx` into `apply`) — `shared/motionFx.ts`, `src/lib/motion/`,
  `f9417401`.
- `list_motion_effects` reports `needs_input` and `self_mapped`; the
  contract is written down in `docs/motion-fx.md` — `d2bdafa9`.
- `parseTrack` refuses what the ops refuse — effects off
  camera/adjustment tracks and any non-null track blend — so whole-body
  writes meet the same contract as ops — `shared/motion.ts`, `7f29b6a2`.
- `notesOnly` refuses an ancestor that is or contains an
  img/picture/video/svg/canvas — `server/storyboard.ts`, `9e0e4bca`.
- `bunx drizzle-kit generate` reports "No schema changes, nothing to
  migrate"; `0081_motion_pro` sits after dev's `0080_motion_phase5` in the
  journal.
- Every look resolves into `GL_EFFECT_IDS` (test in `motionPro.test.ts`);
  all 43 effects draw with zero drops in the browser sweep.
- Verification: `bun run typecheck`, `bun run lint`, `bun run format:check`,
  `bun run doc-lint` clean; motion + storyboard suites green — 212 tests,
  including `motionGoldenBrowser` 8/8 against Chrome for Testing
  (`CHROME_PATH`).
