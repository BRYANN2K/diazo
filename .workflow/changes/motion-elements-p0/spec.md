# Motion elements P0 — backend

## Intent

Element tracks become drawable layers: an element track may carry an effect stack,
a blend mode and a `LayerSpec`; shared planning code decides promotion, raster and
transform strategy and budgets; 26 blend modes get a CPU reference and a GLSL
implementation; 56 element presets plus seeded staggering write ordinary editable
keyframes; the tool surface (MCP + resident) exposes all of it under one contract;
lint and check_scene report layer plans and motion variety; the server render
runs on SwiftShader and refuses over-budget films at job creation.

## Acceptance criteria

- AC-1 (BE half): `add_effect` with `frame_id` + `element_id` and `fx: 'glow'`
  succeeds, creates the element track when missing, and works on an existing
  element track. The pixel half (snapshot shows the glow on that element only)
  needs P0-FE1.
- AC-2 (BE half): `FxSpec.alpha` and `FxSpec.grow` exist for all 43 effects with
  the family assignments the plan names; the render path accepts stacks on
  element tracks. Golden frames per effect are P0-FE1.
- AC-3 (BE half): the 26 colour blend modes exist in `BLEND_MODES`;
  `blendPixel`/`compositePixel` implement the c.6 formulas against literal test
  values on a 5×5 grid, identities and alpha 0/1 edges; `BLEND_GLSL` covers the
  same modes. GL-vs-CPU ±1/255 is P0-FE1.
- AC-4: `planLayers` marks a layer with only transform/opacity keyframes
  `content: 'static'` (one raster for the whole render); the raster counter is
  P0-FE1.
- AC-5: unverified here — preview/render parity is the compositor's (P0-FE1).
- AC-6: the shared code stays pure — plans, matrices and blends are functions of
  (composition, t) only (covered by the node tests' determinism cases).
- AC-7: `apply_element_preset` with `stagger` on 6 elements writes editable
  keyframes on element tracks; the 56 presets pin rest values at their
  boundaries; `staggerOffsets` is deterministic per seed and honours
  `from` distributions.
- AC-8: films with no layers produce bit-identical output — `parseTrack`/`parseOp`
  accept old bodies unchanged and the render-cost logic only charges what draws;
  existing goldens untouched.
- AC-9: a layer budget breach (count per frame/film, pad > 512) is refused at job
  creation with MO-15, not mid-render.
- AC-10: MCP and the resident agent expose the same new tool names
  (`agentToolParity.test.ts`).
- AC-11: unverified here — preview fps target is P0-FE1/FE2 evidence.
- AC-12 (BE extras): lint MO-15/19/20/21 fire on the described cases (MO-16
  dangle checks belong to the measured-scope phase per the plan);
  `check_scene` returns `layers` and `motion_variety`; `RENDER_GL=swiftshader`
  (default) passes the SwiftShader flags to Chromium; docs and the change's
  evidence are current; `typecheck`, `lint`, `format:check`, `doc-lint` and the
  touched tests pass.
