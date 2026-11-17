# Motion Studio Pro — backend, phases P0 and P1

## Intent

The storyboard is intent. Animate makes the agent a creative director: it can
see its render, apply the existing camera/transition/text vocabulary through
tools, record a `Direction` on the composition, and loop a bounded critique.
Then the film gets a pro finish: a per-layer WebGL2 effects stack (~25 curated
effects ported from EffectCraft's algorithms in GLSL under our own ids), looks,
adjustment layers, deterministic motion blur, and the graph-editor data model.

Every pixel stays a pure function of `(composition, t)` plus seeded id hashes —
identical between the browser preview, the desktop render and the server render.

Backend only: `shared/` contracts, `server/`, MCP + resident tools, the render
runtime in `src/lib/motion/` (BE-owned for the render path). The `src/` UI is a
later change.

## Shared contracts the frontend will consume

- `shared/motion.ts`: `Direction` on `Composition`; `effects?: EffectInstance[]`,
  `blend?: BlendMode` on `MotionTrack`; `MotionTrackKind` + `'adjustment'`;
  `motionBlur` on `Composition`; `fx:<instanceId>.<param>` keyframe namespace;
  patch ops `add_effect`, `update_effect`, `remove_effect`, `reorder_effects`,
  `set_direction`, `set_motion_blur`.
- `shared/motionFx.ts`: `FX_REGISTRY` — id, name, category, description, param
  schema `{type, min, max, default, unit, description}`, `cost` 1–5, `seedable`,
  `lookback`, GLSL source key. Drives Effect Controls, the agent catalog, lint
  and export "unsupported" lists. One source.
- `shared/motionLooks.ts`: built-in looks as named `EffectInstance[]` bundles.
- `shared/motionGraph.ts`: graph-editor model — value and speed curves over a
  lane, bezier handles per keyframe (mapped to `cubic-bezier`), spring
  parameters, easing presets. No contract change.
- `src/lib/motion/gl/`: WebGL2 layer compositor, same `paintAt` entry as the
  Canvas 2D compositor; GLSL as TS string modules shared by preview, browser
  render, desktop harness and server harness.
- Tool result shapes in `docs/motion-api.md` (contact sheet, check report,
  rubric, effect catalog).

## Acceptance criteria — P0 (eyes and vocabulary)

- AC-1: `get_scene_snapshot` (MCP + resident) renders `times[]` (or
  `auto: 'beats'`) through the motion harness and returns one labelled contact
  sheet PNG plus numeric stats (mean luminance per cell, motion energy between
  cells, text bounding boxes); the server renderer gate reports `no_renderer`
  rather than guessing.
- AC-2: `check_scene` (MCP + resident) returns a JSON report: existing `MO-*`
  lint, legibility (text contrast via sampled frame), pacing stats, safe zones
  and the effect-cost budget.
- AC-3: `apply_camera_preset`, `apply_transition`, `apply_text_animation`
  (MCP + resident) wrap `cameraPreset()`, the transition kinds and
  `expandTextAnimator`; the result is ordinary editable keyframes/clips visible
  through `get_composition`. All 13 camera presets apply.
- AC-4: `Direction` is an additive persisted field on `Composition`;
  `set_direction`/`get_direction` round-trip it through REST and the tools.
- AC-5: The guide's `MOTION` block is the director's brief (treatment, shot
  list, look mandatory; the vocabulary named; notes are intent not script) and
  `animate_storyboard` accepts `direction`: with `beats` the built composition
  has non-equal shot lengths and at least one non-cut transition, still
  deterministic, verified by a builder test.
- AC-6: `critique_scene` returns the fixed rubric (`intent_coverage`,
  `hierarchy`, `legibility`, `pacing`, `motion_quality`, `continuity`,
  `polish`, `brand` — each a score + issue list) plus the pass budget;
  `direction.passes` defaults to 3 and is hard-capped at 5.
- AC-7: Every new/changed tool is registered in both `server/mcp.ts` and
  `server/resident.ts` with matching schemas, enforced by the parity test.

## Acceptance criteria — P1 (pro finish)

- AC-8: `shared/motionFx.ts` ships ≥ 25 effects with complete registry entries
  and `EffectInstance` validation (unknown id, out-of-range param, bad type
  refused with reasons).
- AC-9: `set_effects` and the `add_effect`/`update_effect`/`remove_effect`/
  `reorder_effects` ops apply an effect stack to a track; `fx:` keyframes
  animate any numeric param through the same easings; `apply_look` writes a
  named look as an `adjustment` track.
- AC-10: The WebGL2 layer compositor renders the same `paintAt` entry for
  preview, browser/desktop harness and server harness; the Canvas 2D fallback
  runs without GL and `check_scene` flags the effects it cannot show.
- AC-11: `check_scene` flags an unknown effect id and an out-of-range param
  (`MO-13`/`MO-14`) and reports the per-composition effect-cost budget.
- AC-12: Motion blur evaluates `frameStateAt` at fixed sub-times inside the
  shutter window and averages; `shutter: 0` output equals the no-blur frame
  exactly (test).
- AC-13: ≥ 8 built-in looks (cinematic polish, 16 mm film, VHS, neon night,
  clean product, dreamy bloom, mono noir, …) apply as one-call bundles.
- AC-14: Seek determinism: same `t` twice, and `t` reached from two different
  seek paths, are pixel-identical; golden-frame browser tests render each
  effect at fixed `t` within ±2/255.
- AC-15: EffectCraft-derived algorithms carry MIT notices in
  `THIRD-PARTY-LICENSES` with the pinned source commit; our registry ids are
  ours, no EffectCraft marks.
- AC-16: `shared/motionGraph.ts` exposes the graph-editor model (value/speed
  curves, bezier handles, spring params, easing presets) with unit tests — no
  contract change.
- AC-17: Server render refuses effect loads above the cost cap with a clear
  error, and the cap is reported by `check_scene`.
- AC-18: `docs/motion-api.md`, `docs/motion-fx.md` and `docs/TECHSTACK.md`
  document the new contract; `agentToolParity` and the affected vitest files
  pass.

## Out of scope

- Timeline/effects/graph UI in `src/` (frontend change).
- Gallery backend, 2.5D/3D camera, expressions, mattes, particles, shader
  transitions, time remap, edit planner, generation, Blender recipes (P2–P4).
- Desktop-device offload of `get_scene_snapshot` beyond reusing the same
  harness contract; the server renderer path is the deliverable.
