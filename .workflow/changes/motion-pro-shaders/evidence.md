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
