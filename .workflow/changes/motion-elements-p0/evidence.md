# Evidence — motion-elements-p0 (P0-BE)

Status: current, updated 2026-11-18

## Implementation notes

- `shared/motion.ts`: `LayerSpec`, `LayerMatte`, `LayerMask`, `blend`/`layer`/
  `matte`/`masks` on `MotionTrack`, `BLEND_MODES` at 26 (W3C Compositing and
  Blending Level 1 order — `BLEND_GLSL` indexes match), ops `set_blend`,
  `set_layer`, `set_matte`, `add_mask`, `update_mask`, `remove_mask`; parsers
  bound layer/mask fields by `MOTION_LIMITS`; layer data is element-track only.
  A `blend: null` / `layer: null` / `matte: null` op still clears a stored
  value on any kind (legacy cleanup); non-element writes refuse.
- `shared/motionLayers.ts`: `isLayer` (promotion table), `planLayers`
  (static/dynamic content, compositor/css transform, pad = author + stack
  growth ≤ MAX_LAYER_PAD, scale ≤ 4 from camera zoom × track scale × output
  ratio, texture size against `LayerGeometry`, document/paint order,
  MO-15/17/18 issues), `layerMatrix` (local matrix about the measured origin,
  parent chain premultiplied outermost-first), `layerIsolateCss` /
  `baseHideCss` / `layerRasterProps`, `layerPropsAt`. Measured geometry is the
  `PlanOptions.geometry` seam — `get_layer_plan` reports
  `geometry: 'unavailable'`.
- `shared/motionBlend.ts`: `blendPixel` (20 separable per-channel kernels + 6
  non-separable whole-colour modes through luminosity/saturation helpers),
  `compositePixel` (premultiplied source-over), `BLEND_GLSL` literal indexed
  by `BLEND_MODES` position.
- `shared/motionFx.ts`: `FxSpec.alpha` (family-derived, 'premult' default;
  'straight' on compositing/light/glitch effects that write their own
  channels), `FxSpec.grow` on resampling effects (blurs, glow/bloom, warps,
  displacement), `layerPad`, `effectCost(track, weight)` area-weighted.
- `shared/motionElementPresets.ts`: 56 specs (20 entrances / 20 exits / 16
  emphasis) in `ELEMENT_PRESET_IDS`; every preset pins rest values at its
  boundary (entrances end, exits start, emphasis both ends); seeded presets
  use mulberry32 via `seededRandom`; `staggerOffsets` covers each/amount ×
  start/end/center/edges/random/position-x/position-y/grid with optional
  easing; `orbit` snaps near-zero trig dust to a clean 0.
- Tools (`server/motionProTools.ts`, MCP `server/mcp.ts`, resident
  `server/resident.ts`, `server/guide.ts`): `add_effect`/`update_effect`/
  `remove_effect`/`set_effects` take `track_id` or `frame_id`+`element_id`
  (auto-creates a validated element track); new `set_layer`, `get_layer_plan`,
  `list_element_presets`, `apply_element_preset` — same names on both
  surfaces through `execMotionPro`.
- Lint (`shared/motionLint.ts`): MO-15 layer budgets (count side), MO-19
  nested layer inside an effect-carrying layer (needs `frameHtml`), MO-20
  undrawn effect/blend/layer data on the wrong track kind, MO-21 opacity-only
  element tracks. MO-16's code is declared but not emitted — the dangle checks
  need the measured phase per the plan. `check_scene` returns `layers` (the
  static plan) and `motion_variety` per shot.
- Render (`server/env.ts`, `server/screenshot.ts`, `server/motionJobs.ts`,
  `.env.example`): `RENDER_GL` = `swiftshader` (default, launches
  `--use-angle=swiftshader --enable-unsafe-swiftshader`) | `gpu` (no extra
  flags) | `off` (`--disable-3d-apis`); `createRenderJob` refuses a film whose
  static plan carries an MO-15 error at creation, not mid-render.

## AC-1 — passed (BE half)

`add_effect` accepts `frame_id` + `element_id`, validates the element exists in
the frame HTML, auto-creates a kind `element` track when missing and reuses it
when present. Same for `update_effect`/`remove_effect`/`set_effects`.
tests/motionProTools.test.ts covers create-and-reuse; the pixel half is P0-FE1.

## AC-2 — passed (BE half)

`FxSpec.alpha` and `FxSpec.grow` exist for all 43 registry effects (alpha is
family-derived, grow on the resampling effects). Element tracks accept effect
stacks through the parser, ops and tools. Golden frames are P0-FE1.

## AC-3 — passed (BE half)

`BLEND_MODES` holds the 26 modes; `blendPixel` implements the c.6 formulas
against literal values on a 5×5 grid, the identities and degenerate inputs,
`compositePixel` covers premultiplied source-over at alpha 0/1 and the edges,
`BLEND_GLSL` covers the same modes with matching indices.
tests/motionBlend.test.ts: 33 tests. GL-vs-CPU ±1/255 is P0-FE1.

## AC-4 — passed

`planLayers` marks a layer whose lanes are only transform/opacity (and `fx:`
param lanes) `content: 'static'`; non-transform lanes, scene frames and tracked
non-layer descendants mark it `dynamic` with reasons.
tests/motionLayers.test.ts. The raster counter is P0-FE1.

## AC-5 — unverified

Preview/render parity is the compositor's evidence (P0-FE1).

## AC-6 — passed

The shared code is pure: plans, matrices, blends and stagger offsets are
functions of (composition, t, seed). Determinism is pinned by the seeded-preset
and stagger tests plus the layer-plan tests.

## AC-7 — passed

`apply_element_preset` writes ordinary editable keyframes on element tracks,
with `stagger` offsets across elements. All 56 presets pin rest values at
their boundaries; `staggerOffsets` is deterministic per seed and honours the
eight `from` distributions. tests/motionElementPresets.test.ts + the
apply-path tests in tests/motionProTools.test.ts.

## AC-8 — passed

`parseTrack`/`parseOp` accept old bodies unchanged; a film with no layers
produces an empty plan and no layer cost. Existing golden files untouched —
the golden browser suite skips on this machine (no display); nothing in the
no-layer path changed behaviour.

## AC-9 — passed

`createRenderJob` plans the film's frames and refuses creation when an MO-15
error is present (per-frame count, film total, pad, texture side/memory).
tests/motionProTools.test.ts asserts the refusal happens at creation.

## AC-10 — passed

MCP and the resident agent register `set_layer`, `get_layer_plan`,
`list_element_presets`, `apply_element_preset` under the same names, both
dispatching through `execMotionPro`. tests/agentToolParity.test.ts passes.

## AC-11 — unverified

Preview fps is P0-FE1/FE2 evidence.

## AC-12 — passed

- Lint: MO-15 (budgets), MO-19 (nested layer in an effect-carrying layer, via
  `frameHtml`), MO-20 (undrawn data on the wrong kind), MO-21 (opacity-only
  element motion) fire on the described cases; MO-17/MO-18 exist for the
  measured plan; MO-16's code is declared for the measured-scope phase per the
  plan — the P0-BE table scopes it out.
- `check_scene` returns `layers` (the static plan) and `motion_variety`.
- `RENDER_GL=swiftshader` (default) passes `--use-angle=swiftshader
--enable-unsafe-swiftshader`; `gpu` and `off` behave per env.ts.
- Docs current: motion-api.md, motion-fx.md, FEATURES.md, TECHSTACK.md,
  .env.example, CHANGELOG.md, THIRD-PARTY-LICENSES (W3C spec reference).
- Checks: `bun run typecheck` clean; `bun run lint` clean; `bun run
format:check` clean; `bun run doc-lint` 0 warnings; `bunx vitest run` on the
  touched files — 129 tests green across motion.test, motionProTools.test,
  motionLayers.test, motionBlend.test, motionElementPresets.test and
  agentToolParity.test; the wider motion suite (~80 tests) ran green earlier
  in the session.

## Fixes folded in during verification

- `glitch-out` opacity lane starts at rest (1) per the boundary contract.
- `orbit` snaps near-zero trig dust so authored lanes end on a clean 0.
- `set_blend`/`set_layer`/`set_matte` allow a null clear on non-element
  tracks (legacy data scrub); writes still refuse.
- `stagger.from` is validated against the distribution names before planning.
- spec.md AC-12 corrected to MO-15/19/20/21 — it had listed MO-16, which the
  plan's P0-BE table assigns to the measured phase.

## Licence notes

Blend formulas are the W3C Compositing and Blending Level 1 equations plus
the common published Photoshop-era separable-mode definitions — mathematics,
clean-room written and recorded in THIRD-PARTY-LICENSES under "Specifications
followed" (W3C Document License).

## Review fixes — motion-elements-p0-astra

Every blocking finding in `/tmp/reviews/motion-elements-p0-astra.md` applied:

- **Atomic preset batches**: `applyElementPreset` builds provisional tracks
  in a request-local pass and lands `add_track` + keyframes in ONE
  `patchComposition` — a rejected batch (missing element, stagger past the
  film, bad duration) leaves zero tracks; a peer's racing `add_track`
  remaps onto the peer's track and retries (3 attempts). 6-element probe
  covered in tests.
- **Bounded preset generation**: `ELEMENT_PRESET_MAX_LOOPS` (64) and
  `ELEMENT_PRESET_MAX_DURATION` (3600); t/duration/direction validated
  before any loop; every loop site (swings, steps, bounces, counts,
  frequencies, octaves, turns, nested wiggle) clamps before expansion;
  stagger `each`·(n−1) and `amount` bounded as spans, not per-element.
- **Renderer compatibility (AC-8)**: `RENDER_GL` selects the backend ONLY
  for films with promoted element layers (`glForComposition`,
  `openLayerPage`, a second `createRenderer` pool); everything else —
  including every golden fixture — launches `legacy`, i.e. zero GL flags,
  the exact pre-P0 Chromium configuration. Byte-identity holds by
  construction; `glArgs`/`glForComposition` unit-tested.
- **Blend endpoints**: `color-burn`, `vivid-light` and `hard-mix`
  corrected to the W3C equations in the TS CPU reference AND the GLSL;
  literal endpoint tests + an independent formula oracle.
- **Planner**: ancestor matrices premultiply outer→inner (2-level probe);
  dynamic classification covers frame `data-doop-motion` blocks, text
  animators, CSS transform lanes and tracked non-layer descendants;
  `layerPadReach` reports honest reach — over the pad cap is MO-15, not a
  silent clamp; layers sort by measured paint order / markup order with
  `order` assigned after sorting; complex clips keep `transform: 'css'`,
  plain rect/rounded-rect pass; `baseHideCss` hides the whole subtree;
  matte sources promote with the consumer and report MO-16 on
  dangling/cross-frame/muted/cyclic sources.
- **Tool parity**: `element_ids` is the only public identifier on MCP and
  resident (singular shorthand removed); `set_layer` accepts the
  documented flat fields plus nested `layer`, conflicting duplicates
  refused, `motion_blur`↔`motionBlur` mapped; `masks` replaces atomically
  via `set_masks`; `list_motion_effects` reports `alpha`, `grow`, `scopes`.
- **Render jobs**: range refuses `NaN`/non-finite instead of silently
  defaulting; `0 ≤ start < end ≤ duration` enforced; MO-15 refusals carry
  `rule: 'MO-15'` to the API response; `sceneEffectBill` shared between
  `check_scene` and job creation — muted/`mode:'off'`/`visible:false`
  stacks bill nothing.
- **Lint**: MO-19 matches any quote/whitespace `data-doop-id` form and
  doesn't false-positive on lookalike ids; MO-21 is per-shot through
  `shotWindows`/`changingPropsIn`, counting interpolation that crosses a
  shot even when no keyframe lands strictly inside.

Tests: probes live in tests/motionLayers, motionElementPresets,
motionProTools, motion, motionElementCss, motionRenderGl and
motionBlend — each reproduces the failing behaviour without its fix.
