# Motion pro — the 18 missing WebGL2 bodies

Date: 2026-11-17. Status: validated work order, implementing.

`shared/motionFx.ts` registers 43 effects and `GL_EFFECT_IDS` names the 25
`src/lib/motion/gl.ts` can draw; lint MO-14 reports the other 18 on every
stack that names them. This change ships original GLSL bodies for all 18 —
bloom, curves, lens blur; the mattes (luma matte, feather, choke); the lights
(lens flare, god rays); the optics and warps (lens distortion, rolling
shutter, whip blur, displacement map, turbulent displace, slit stretch); and
the generators (gradient ramp, fractal noise, grid, solid fill) — so the
whole registry draws.

While wiring them, two latent pipeline gaps surface and are fixed here:

- Select params were bound `Number(def)` — `NaN` for string defaults. Selects
  now bind their option index, as the uniform contract documented.
- About a dozen existing bodies read uniforms the spec never declares
  (`u_length`, `u_strength`, `u_monochrome`, …): their programs fail to
  compile and `apply` skipped them silently. Bodies now use exactly the
  declared `u_<param>` names and honor every spec param.
- The mix stage could bind a texture as both source and target (feedback
  loop) on the second mixed effect; the pipeline now tracks free buffers and
  gains a third scratch texture for the effect-input snapshot (`u_tex2`) and
  the mix output.

Shaders stay original implementations of the standard algorithms, as the
existing ones are — `THIRD-PARTY-LICENSES` already covers EffectCraft's role
as algorithm reference and needs no new entry.
