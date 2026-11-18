# Motion elements P0 — backend: real effects, blends and rich motion on elements

## Problem

Elements on a film can only move and fade. An effect stack refuses every track but
camera and adjustment ("effects only draw on camera and adjustment tracks"), a track
`blend` parses but is refused on write, and there is no element-preset vocabulary —
so the owner cannot put a glow and a `screen` blend on a headline, and an agent
cannot write pops, wipes and staggers on elements.

## Scope

The backend half of the architect plan's P0 (`/tmp/plans/motion-elements.md`,
sections c.2–c.11, d.1–d.2, e/P0). Option B: promoted elements become isolated
layers rasterised with alpha; a WebGL compositor runs their effect stacks, blends
and transforms. This change lands the shared model, the plan, the blend maths, the
presets, the tools, the lint and the render gates — everything the layer engine
(P0-FE1, Opus) and the editor (P0-FE2, Opus) build against, and everything an MCP
agent can drive today.

P0-BE table, tasks 1–9:

1. `LayerSpec`, `LAYER_TRANSFORM_PROPS`, `set_layer` op, parsers, limits; extend
   `BLEND_MODES` to the 26 colour modes (`shared/motion.ts`).
2. `shared/motionLayers.ts`: `isLayer`, `planLayers`, `layerMatrix`, `layerCss`.
3. `shared/motionBlend.ts`: `blendPixel` CPU reference, `compositePixel`,
   `BLEND_GLSL`.
4. `FxSpec.alpha` / `FxSpec.grow` for all 43 effects, `layerPad`, area-weighted
   `effectCost` (`shared/motionFx.ts`).
5. `shared/motionElementPresets.ts`: 20 entrances, 20 exits, 16 emphasis,
   `staggerOffsets`, seeded.
6. Tools: element tracks accepted in `add_effect` / `set_effects` and friends with
   `frame_id` + `element_id`, `set_layer`, `get_layer_plan` (static part),
   `list_element_presets`, `apply_element_preset` — MCP and resident parity, guide.
7. Lint MO-15/16/19/20/21; `check_scene.motion_variety` and `layers`.
8. `RENDER_GL` env (SwiftShader default), layer-budget refusal at job creation.
9. Docs.

## Out of scope

P0-FE1 (`src/` layer engine: rasteriser, measure, GL compositor, harness
`__doopMotionPlan`) and P0-FE2 (editor panel, pickers, i18n) are Opus's. Where a
BE tool needs measured geometry (`get_layer_plan`), the static plan is returned
with `geometry: 'unavailable'` and the measured call is wired behind a feature
check.

## Decisions and open questions

- All data-model changes are additive on `tracks` (jsonb): no SQL migration.
- `LayerSpec` carries every field of the c.10 contract (mode, visible, transform,
  pad, scale, motionBlur — the last two draw in P1); `matte`/`masks` parse and
  store through `set_layer` so the tool contract is stable, and check_scene
  reports them as not-drawn until P1.
- Old compositions parse unchanged; films with no layers stay bit-identical
  (AC-8) — the existing goldens are untouched.
- Stagger `from: position-x|position-y|grid` orders by the element's frame
  position when elements span frames, else document order; measured element
  rects are a P0-FE1 seam.
- Blend formulas are the W3C Compositing and Blending Level 1 equations plus the
  common Photoshop-era definitions — maths, not code (Licences section).
