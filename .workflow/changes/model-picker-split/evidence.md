# Evidence

Status: collected after the review fixes, 2026-11-17. Not checked by `stip-check`
yet: the contract awaits the owner's sign-off.

- AC-1 (two pills): `ModelPicker` renders `ModelMenu` + `EffortMenu`; the effort
  pill renders nothing without a dial (test "hides the effort pill where the
  connection has no dial"). The model pill opts out of `MenuButton`'s
  `flex-none` (`flex-initial`) and truncates; under a 330px `@container/foot`
  the effort pill keeps only its dial. Shots: after-foot-{light,dark}.png (340px
  Agents panel), after-foot-narrow.png (300px), after-foot-pt-BR.png: the send
  button is whole in each.
- AC-2 (model menu): tests "folds the non-recommended entries", "opens a fold on
  its own when the pick sits inside it", "filters the rows as the search types",
  "takes the search's first row on Enter", "does nothing on Enter with an empty
  search", "focuses the search on open, and ↓ / ↑ from it land on the first /
  last row", "sends what is typed on a row back to the search", "matches a
  connection's name in the search", "lists a pick the catalog does not know
  without writing it into the catalog". Shots: after-menu-{light,dark} (closed),
  after-menu-fold-{light,dark} (Claude Plan's Older (13) open),
  after-menu-search-{light,dark} ("opus" typed with focus on the fold row; the
  script fails unless the field holds it), after-menu-nomatch-{light,dark}.
- AC-3 (effort popover): tests "opens the effort's own menu", "picks an effort
  from its own menu, or Default which sends none". Blurbs wrap
  (`whitespace-normal` on the dropdown description); the caption's arrows are
  lucide chevrons. Shots: after-effort-{light,dark}, after-effort-pt-BR,
  after-effort-narrow.
- AC-4 (duel): duelDialog.test.tsx. Shots: after-duel-{light,dark},
  after-duel-filled-{light,dark}, after-duel-repeat-{light,dark} (Model 3 equals
  Model 2: warning, Start held back).
- AC-5: en + pt-BR keys; typecheck, oxlint type-aware, ESLint, Prettier and
  doc-lint pass; `vitest run tests/modelPickerRunners.test.tsx
tests/duelDialog.test.tsx tests/acpAgentRunners.test.tsx --maxWorkers=2`.
  Shots in /tmp/visual-qa/model-picker (driver `scripts/qa-model-picker.ts`);
  PR draft /tmp/pr-drafts/model-picker-split.md.
