# Motion Pro backend and panel

## Intent

Direct and finish a deterministic film through the motion tools and the pro timeline panel. Preserve the shipped P0/P1 backend contract and complete its scene diagnostics.

## Acceptance criteria

- AC-1: `get_scene_snapshot` (MCP + resident) renders `times[]` (or `auto: 'beats'`) through the motion harness and returns one labelled contact sheet PNG plus numeric stats (mean luminance per cell, motion energy between cells, text bounding boxes); the server renderer gate reports `no_renderer` rather than guessing.
- AC-2: `check_scene` (MCP + resident) returns a JSON report: existing `MO-*` lint, legibility (text contrast via sampled frame), pacing stats, safe zones and the effect-cost budget.
- AC-3: `apply_camera_preset`, `apply_transition`, `apply_text_animation` (MCP + resident) wrap `cameraPreset()`, the transition kinds and `expandTextAnimator`; the result is ordinary editable keyframes/clips visible through `get_composition`. All 13 camera presets apply.
- AC-4: `Direction` is an additive persisted field on `Composition`; `set_direction`/`get_direction` round-trip it through REST and the tools.
- AC-5: The guide's `MOTION` block is the director's brief (treatment, shot list, look mandatory; the vocabulary named; notes are intent not script) and `animate_storyboard` accepts `direction`: with `beats` the built composition has non-equal shot lengths and at least one non-cut transition, still deterministic, verified by a builder test.
- AC-6: `critique_scene` returns the fixed rubric (`intent_coverage`, `hierarchy`, `legibility`, `pacing`, `motion_quality`, `continuity`, `polish`, `brand` — each a score + issue list) plus the pass budget; `direction.passes` defaults to 3 and is hard-capped at 5.
- AC-7: Every new/changed tool is registered in both `server/mcp.ts` and `server/resident.ts` with matching schemas, enforced by the parity test.
- AC-8: `shared/motionFx.ts` ships ≥ 25 effects with complete registry entries and `EffectInstance` validation (unknown id, out-of-range param, bad type refused with reasons).
- AC-9: `set_effects` and the `add_effect`/`update_effect`/`remove_effect`/ `reorder_effects` ops apply an effect stack to a track; `fx:` keyframes animate any numeric param through the same easings; `apply_look` writes a named look as an `adjustment` track.
- AC-10: The WebGL2 layer compositor renders the same `paintAt` entry for preview, browser/desktop harness and server harness; the Canvas 2D fallback runs without GL and `check_scene` flags the effects it cannot show.
- AC-11: `check_scene` flags an unknown effect id and an out-of-range param (`MO-13`/`MO-14`) and reports the per-composition effect-cost budget. New subtypes identify unknown IDs and invalid parameters without changing the existing meanings of the two rule families. A caller can check a candidate without persisting it.
- AC-12: Motion blur evaluates `frameStateAt` at fixed sub-times inside the shutter window and averages; `shutter: 0` output equals the no-blur frame exactly (test).
- AC-13: ≥ 8 built-in looks (cinematic polish, 16 mm film, VHS, neon night, clean product, dreamy bloom, mono noir, …) apply as one-call bundles.
- AC-14: Seek determinism: same `t` twice, and `t` reached from two different seek paths, are pixel-identical; golden-frame browser tests render each effect at fixed `t` within ±2/255.
- AC-15: EffectCraft-derived algorithms carry MIT notices in `THIRD-PARTY-LICENSES` with the pinned source commit; our registry ids are ours, no EffectCraft marks.
- AC-16: `shared/motionGraph.ts` exposes the graph-editor model (value/speed curves, bezier handles, spring params, easing presets) with unit tests — no contract change.
- AC-17: Server render refuses effect loads above the cost cap with a clear error, and the cap is reported by `check_scene`.
- AC-18: `docs/motion-api.md`, `docs/motion-fx.md` and `docs/TECHSTACK.md` document the new contract; `agentToolParity` and the affected vitest files pass.
- AC-19: The Effects, Looks, Film and Direction tabs edit the selected page. A reload shows the resulting stack, adjustment look, shutter settings and beat edits. The cost meter agrees with the server and actions above the cap explain the refusal.
- AC-20: At 1280 and 1440 pixels with Layers and Agents open, a keyboard user can open the panel, reach every entry of a ten-effect stack, change tabs at their top, and read distinct ruler labels. The toggle reports whether the panel is shown.
- AC-21: Adding an effect to a film without a camera, then undoing it after another writer adds camera keys, preserves those keys. Undoing a beat edit preserves separately edited treatment, look and palette.
- AC-22: Rapid field edits arrive in order, collapse a repeat burst into one undo step and survive one concurrent revision change. A second conflict or final refusal visibly explains failure and retains the history entry.
- AC-23: Effect names, params, options, looks and refusal reasons are readable in English and pt-BR with keyboard and touch. Removing a middle beat preserves the right row draft and a long note is accessible.
- AC-24: On the reviewed integration diff, the panel has no stale translation keys or unused helpers identified in the prior review. A fresh browser review records the tested viewport, locale, theme and branch revision.

## Review findings folded in

| Finding                                                   | Criterion | Branch evidence or remaining work                                                   |
| --------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| 1–2. Panel hidden at 1280, long stack clipped             | AC-20     | layout change 6ee5d0a7. Integration unverified.                                     |
| 3–4. Camera-key loss and discarded undo                   | AC-21     | writer revision 25fa36da, repeat conflict case under AC-22. Integration unverified. |
| 5. Fast writes conflict                                   | AC-22     | writer revision 25fa36da. Integration unverified.                                   |
| 6. Beat undo overwrites direction                         | AC-21     | repeat collaborative edit. Integration unverified.                                  |
| 7–8. Tab scroll and ruler overlap                         | AC-20     | layout change 6ee5d0a7. Integration unverified.                                     |
| 9–11. Refusal accessibility, labels and beat row identity | AC-23     | labels at 044e2e18, rerun keyboard and draft cases. Integration unverified.         |
| 12. Dead code                                             | AC-24     | inspect integration diff. Integration unverified.                                   |
| Backend AC-11 and rule-ID collision                       | AC-11     | partial in archived evidence below. Integration unverified.                         |

## Out of scope

The M1 live layer preview, gallery, expressions, generation and later M2–M5 layer/editor work have separate changes. Desktop offload of contact sheets remains outside P0.
