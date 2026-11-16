# Split the model picker's model and effort controls

Status: active, updated 2026-11-17

## Problem and authorized scope

On staging the model menu lists every pinned Claude and GPT version flat, and the
reasoning-effort StepSlider at its foot is ugly and badly placed. The owner chose a
two-pill design: a model pill opening a short grouped menu, and a separate effort
pill opening a radio popover. Rework `ModelMenu`, `ModelPicker` and the duel slots
to match, keep `RunnerPick` semantics, and carry the `recommended` flag through to
the client so each group can fold its older entries.

No dependencies, schema or data migrations, CI or release changes. No pushes, no
pull requests, no container images.

## Decisions

- `RunnerOption.recommended` rides the wire: the server stops stripping it, the
  Claude Plan aliases and each ACP curated menu mark it, and `modelCatalogFor`'s
  merge keeps flagging live-confirmed entries. A group shows flagged entries, or
  all of them when nothing is flagged; the rest fold under "Older (N)".
- The model menu keeps a search field on top, groups by connection, a check on
  the pick, "Model settings…" at the foot, a 420px cap with the list scrolling
  inside, and no row tooltips (they covered neighbouring rows on staging).
- The effort control is its own `DropdownMenu`: radio rows named and blurred by
  `effortLabels`, a "Default" row when the connection has none configured, a
  "Faster ◂ ▸ Smarter" caption, and a quarter/half/three-quarter/full dial glyph
  on the pill. It renders only when the picked connection has an effort dial.
- Duel slots split the same way: a model button plus an effort button, Clear and
  the Delete/Backspace shortcut kept on the model button.
- `knownModelName` names a picked id the menu does not list; `doop:agent-runner`
  storage, the Settings default resolution and `currentRunnerPick` are unchanged.

## Approval source

The task brief records the owner's chosen design (composer foot layout, group
fold, effort popover contents, duel split, file list, checks). The owner has not
yet signed off this contract; approval is his to record.

## Review fixes (2026-11-17)

A review asked for: the send button kept inside a narrow foot, wrapping effort
blurbs, the search keeping the keyboard, Enter with no query leaving the pick
alone, `splitModels` not mutating the store's list, corrected QA evidence, and
this change kept open until those land. The AC-1 and AC-2 wording above carries
the resulting behaviour.
