# Tasks — motion-elements-p0 (P0-BE)

- [x] 0. Change folder (proposal, spec, tasks, state)
- [x] 1. `shared/motion.ts`: LayerSpec, LAYER_TRANSFORM_PROPS, set_layer op (+ set_matte/mask ops), parsers, layer limits, BLEND_MODES → 26
- [x] 2. `shared/motionBlend.ts`: blendPixel, compositePixel, BLEND_GLSL
- [x] 3. `shared/motionFx.ts`: FxSpec.alpha/grow for 43 effects, layerPad, area-weighted effectCost
- [x] 4. `shared/motionLayers.ts`: isLayer, planLayers, layerMatrix, layerCss
- [x] 5. `shared/motionElementPresets.ts`: 20+20+16 presets, staggerOffsets, seeded
- [x] 6. Tools: element-track effects via frame_id+element_id, set_layer, get_layer_plan, list/apply_element_preset; MCP + resident + guide
- [x] 7. Lint MO-15/19/20/21 (MO-16 reserved for the measured plan); check_scene layers + motion_variety
- [x] 8. RENDER_GL env + SwiftShader flags; budget refusal at job creation
- [x] 9. Tests: motionLayers, motionBlend, motionElementPresets, motionProTools, agentToolParity
- [x] 10. Docs: motion-api.md, motion-fx.md, FEATURES.md, TECHSTACK.md, .env.example, CHANGELOG
- [x] 11. Checks: typecheck, lint, format:check, doc-lint, touched tests; evidence.md
- [ ] 12. Conventional commits; push -u origin feat/motion-elements-p0
