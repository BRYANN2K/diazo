# Motion pro — WebGL2 bodies for the remaining 18 effects

## Intent

`shared/motionFx.ts` registers 43 effects; `src/lib/motion/gl.ts` ships GLSL
bodies for 25. Lint MO-14 reports the rest as undrawable. This change gives
every registered effect a deterministic WebGL2 body, so MO-14 goes silent for
all 43 — still reported for unregistered ids and missing programs.

Validated by Bryan's work order on `feat/motion-pro-shaders` (worktree
`doop-wt/motion-shaders`), built on `feat/motion-pro` after its review fixes.

## Contract

- Every body keeps the existing contract: `u_tex` is the incoming pass, the
  body writes `col`, `u_seed`/`u_res`/`u_t`/`u_fps` are bound, and every spec
  param arrives as `u_<param>` (float; `vec3` + a `u_<param>_a` alpha float for
  colors; `vec2` for points; option index for selects).
- `u_tex2` is a second sampler bound to the effect's own input — the second
  input `needsInput` effects read, and the original image a multi-pass effect
  composites onto. Until instance-level input binding lands, needsInput
  effects self-map.
- A body may be a list of sub-passes run in order over the ping-pong pipeline
  (bounded: fixed array length). Multi-pass effects (bloom, lens blur) use it;
  spec cost stays honest.
- Deterministic for a given (composition, t, seed): integer hash noise only,
  no `Math.random`, no accumulated state. Same render twice = same pixels.
- `apply` reports per-effect program failures so a broken shader is a named
  drop, never a silent skip.

## Acceptance criteria

- AC-1: All 43 registry ids are in `GL_EFFECT_IDS` and each has a `BODY`; a
  static test proves every `u_*` identifier a body reads is declared and every
  spec param maps to a used uniform.
- AC-2: The 18 ids ship bodies in the ordered groups: (bloom, curves,
  lens-blur), (luma-matte, feather, choke), (lens-flare, god-rays),
  (lens-distortion, rolling-shutter, whip-blur, displacement-map,
  turbulent-displace, slit-stretch), (gradient-ramp, fractal-noise, grid,
  solid-fill). One commit per group.
- AC-3: `lintComposition` reports no MO-14 for a stack covering all 43
  registered effects; it still fires for an unregistered id.
- AC-4: The browser golden harness covers all `GL_EFFECT_IDS`; each new effect
  renders the same hash twice at the same t; goldens regenerated
  (`DOOP_GOLDEN_UPDATE=1`).
- AC-5: `bun run typecheck && bun run lint && bun run format:check` and the
  motion test files pass; `docs/motion-fx.md` reflects the full coverage and
  the second-input/multi-pass contract.

## Non-goals

- Per-instance texture binding for `needsInput` effects (no field on
  `EffectInstance` exists yet; self-map documented as the interim semantics).
- Element-track GL stacks (they render through CSS filters today).
- New effects or registry changes beyond what GL support requires.
