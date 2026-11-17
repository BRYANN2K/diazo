# Tasks — motion-pro-shaders

Work order from Bryan on `feat/motion-pro-shaders` (worktree
`doop-wt/motion-shaders`), branched from `feat/motion-pro` after its review
fixes. Commit per group; commits stay local (no push, no PR).

- [ ] 1. Pipeline (`src/lib/motion/gl.ts`): selects bind option index, colors
      gain `u_<param>_a`, `u_tex2` second sampler, bodies may be ordered
      sub-pass lists, `tex[2]` input snapshot, mix-stage feedback fix,
      `apply` returns failed fx ids; repair existing bodies reading
      undeclared uniforms. Commit `fix(motion): …`.
- [ ] 2. Group 1: `bloom`, `curves`, `lens-blur` + ids.
- [ ] 3. Group 2: `luma-matte`, `feather`, `choke` + ids.
- [ ] 4. Group 3: `lens-flare`, `god-rays` + ids.
- [ ] 5. Group 4: `lens-distortion`, `rolling-shutter`, `whip-blur`,
      `displacement-map`, `turbulent-displace`, `slit-stretch` + ids.
- [ ] 6. Group 5: `gradient-ramp`, `fractal-noise`, `grid`, `solid-fill` + ids.
- [ ] 7. Tests: `tests/motionPro.test.ts` (all 43 have bodies, uniforms cover
      spec params, MO-14 silent), `tests/motionGoldenBrowser.test.ts`
      (determinism for new ids, unregistered-id drop), goldens regen.
- [ ] 8. Docs: `docs/motion-fx.md`, `docs/FEATURES.md`, `docs/TECHSTACK.md`
      touch-ups; evidence.md; full check suite green.
