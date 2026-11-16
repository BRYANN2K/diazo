# Split the model picker's model and effort controls

Status: active, updated 2026-11-16

## Intent

Replace the flat model list and its bottom slider with two quiet pills — model
and effort — in the composer foot and on each duel slot.

## Acceptance criteria

- AC-1: The composer foot renders two pills: the picked model (connection mark +
  name) and, only when the picked connection has an effort dial, the current
  effort (dial glyph + name). Nothing else changes in the foot.
- AC-2: The model menu shows a search field on top that filters as you type
  (name and id), keeps ↑/↓/↩ keyboard navigation, and groups models per
  connection. Each group lists its `recommended` entries — the aliases
  ("Latest …", "… default") and live-confirmed curated rows — or every model
  when none is flagged; the rest fold under "Older (N)" per group and expand in
  place. The pick wears a check, "Model settings…" ends the menu, and no row
  carries a covering tooltip. The menu caps near 420px and scrolls inside, the
  search and the foot staying put.
- AC-3: The effort pill opens a radio list of the connection's effort levels
  with their `effortLabels` blurbs, plus a "Default" row when the connection
  has none configured; a "Faster ◂ ▸ Smarter" caption sits under the list. The
  pill's dial glyph reads quarter / half / three-quarter / full. The StepSlider
  no longer appears in the model menu.
- AC-4: Duel slots split the same way: a model button (caption, mark, name,
  Clear in its menu, Delete/Backspace clears) plus an effort button where the
  slot's connection has a dial. `RunnerPick`, `doop:agent-runner`, the Settings
  default resolution and `knownModelName` keep their semantics; the "· Desktop
  app not running" hint stays on the group caption.
- AC-5: en and pt-BR catalogs cover the new strings; typecheck, oxlint
  type-aware, ESLint and Prettier pass; `modelPickerRunners` and `duelDialog`
  tests are updated and extended with search, Older-fold and effort-pill
  coverage; before/after screenshots land in /tmp/visual-qa/model-picker; a PR
  draft is written to /tmp/pr-drafts/model-picker-split.md.
