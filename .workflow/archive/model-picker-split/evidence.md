# Evidence

Status: collected — all ACs passed (`check` run 2026-11-16, subject digest
f8f8d6826c04b7cdc1baaf4095d77dbef3bc475a8d5334a21d9db66becd686d7).

- Contract: this change follows the owner's written design brief (two pills,
  grouped search menu with Older fold, effort radio popover, duel split).
- AC-1 (two pills): `ModelPicker` renders `ModelMenu` + `EffortMenu`
  (src/components/ModelPicker.tsx); the effort pill renders nothing without a
  dial — test "hides the effort pill where the connection has no dial".
  Shots: /tmp/visual-qa/model-picker/after-foot-{light,dark}.png.
- AC-2 (model menu): search filters name+id, ↑/↓/↩ from the field, groups per
  connection list `recommended` (or all), the rest under "Older (N)" expanding
  in place; check via the radio group; "Model settings…" at the foot; no row
  tooltips; ~420px cap scrolling inside. Tests: "folds the non-recommended
  entries", "opens a fold on its own when the pick sits inside it", "filters
  the rows as the search types", "takes the search's first row on Enter".
  Shots: after-menu-_, after-menu-fold-_, after-menu-search-* (light+dark).
- AC-3 (effort popover): `EffortMenu` radios the levels with `effortLabels`
  blurbs, a "Default" row where none is configured, "Faster ◂ ▸ Smarter"
  caption; `EffortGlyph` dial quarter→full; no StepSlider in the menu. Tests:
  "opens the effort's own menu", "picks an effort from its own menu, or
  Default which sends none". Shots: after-effort-{light,dark}.png.
- AC-4 (duel split + semantics): each slot is a card with a model button and
  an effort pill; Clear in the model menu's footer, Delete/Backspace clears;
  `runnerPick.ts`, `doop:agent-runner`, `resolveRunnerPick` and
  `knownModelName` unchanged; "· Desktop app not running" on the group
  caption. Tests: duelDialog.test.tsx. Shot: after-duel-filled-{light,dark}.png.
- AC-5 (catalogs, checks, artifacts): en + pt-BR keys added. `bun run
typecheck` clean; `bunx oxlint --type-aware --deny-warnings` clean; `bunx
eslint . --max-warnings 0` clean; `bunx prettier --check` clean on changed
  files; `bunx vitest run tests/modelPickerRunners.test.tsx
tests/duelDialog.test.tsx tests/acpAgentRunners.test.tsx --maxWorkers=2` →
  28 passed; `bun run doc-lint` passed. Before/after shots in
  /tmp/visual-qa/model-picker; QA driver scripts/qa-model-picker.ts; PR draft
  /tmp/pr-drafts/model-picker-split.md.
