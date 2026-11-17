# Tasks — Motion Studio Pro backend, P0 then P1

Built on `feat/motion-pro` (worktree `doop-wt/motion-pro`), branched from
`origin/dev`, with `feat/motion-backend-next` and
`fix/animate-storyboard-elements` merged in first (`7cbeec21`, `ea0381e2`).

## P0 — eyes and vocabulary

- [x] 0. Merge `feat/motion-backend-next` (`7cbeec21`) and
      `fix/animate-storyboard-elements` (`ea0381e2`); MOTION guide block kept;
      migrations stay ordered after Orca's 0073; merged tests green.
- [x] 1. `Direction` type + `direction` field on `Composition`
      (`shared/motion.ts`), `set_direction`/`get_direction` tools, REST round-trip.
- [x] 2. `apply_camera_preset`, `apply_transition`, `apply_text_animation`
      tools in `server/motionTools.ts`, MCP + resident.
- [x] 3. `get_scene_snapshot`: harness contact-sheet mode + server tool
      (renderer gate), stats.
- [x] 4. `check_scene`: lint + pacing + safe zones + legibility + cost report.
- [x] 5. `critique_scene`: fixed rubric + pass budget (default 3, max 5).
- [x] 6. Director brief in `server/guide.ts`; `animate_storyboard` consumes
      `direction` (non-equal beats, non-cut transitions).
- [x] 7. Parity + `tests/motionSnapshot.test.ts` + builder/direction tests.

## P1 — pro finish

- [x] 8. `shared/motionFx.ts`: `EffectInstance`, `FX_REGISTRY` (≥25 effects,
      GLSL source keys, param schemas, cost), validation, ops `add_effect` /
      `update_effect` / `remove_effect` / `reorder_effects`, `fx:` keyframes.
- [x] 9. Contract additions: `adjustment` track kind, `blend`, `motionBlur` on
      `Composition`; lint `MO-13`/`MO-14`; interchange "unsupported" lists; CSS
      export fallbacks.
- [x] 10. `src/lib/motion/gl/` WebGL2 layer compositor + GLSL effect modules;
      Canvas 2D fallback flags unshown effects.
- [x] 11. `list_motion_effects`, `set_effects`/`add_effect`, `apply_look`
      tools, MCP + resident.
- [x] 12. `shared/motionLooks.ts`: ≥ 8 built-in looks.
- [x] 13. Deterministic motion blur (sub-sample `frameStateAt`; `shutter: 0`
      identity).
- [x] 14. `shared/motionGraph.ts`: value/speed curves, bezier handles, spring
      params, easing presets.
- [x] 15. Golden-frame browser tests per effect + seek-determinism tests.
- [x] 16. `THIRD-PARTY-LICENSES`: EffectCraft MIT notice + pinned commit.
- [x] 17. Docs: `docs/motion-api.md`, `docs/motion-fx.md`, `docs/TECHSTACK.md`,
      FEATURES/CHANGELOG lines.
- [x] 18. Full verification (typecheck, lint, tests, doc-lint), PR draft at
      `/tmp/pr-drafts/motion-pro-backend.md`, evidence recorded.
