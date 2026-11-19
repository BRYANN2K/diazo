# Motion effects — the layer stack

Motion Studio pro (P1) gives every timeline track an ordered effect stack.
`shared/motionFx.ts` is the registry the agent tools, the lint and the
compositor all read; `docs/motion-api.md` lists the tool surface.

## Model

- `EffectInstance { id, fx, params, enabled?, seed?, mix?, blend? }` lives on
  `MotionTrack.effects` — element track = that element, clip track = its
  clips, camera track = the whole scene, `adjustment` track = everything
  below it over the clip windows its `adjustment` clips open.
- Ops: `add_effect`, `update_effect` (params merge, `blend: null` clears),
  `remove_effect`, `reorder_effects` (every id exactly once), `set_blend`,
  `set_motion_blur`. All atomic through `applyCompositionOps`.
- Params keyframe through `fx:<instanceId>.<param>` lanes on the track's
  `keyframes`. Number params take lanes; dangling lanes are lint MO-13.
- Seeds are deterministic: `effectSeed` = `seed ?? FNV-1a(id)`; noise/grain
  bodies take the seed as a uniform, never a clock.
- `GL_EFFECT_IDS` names the registry ids `src/lib/motion/gl.ts` ships a GLSL
  body for — all 43 today. Lint MO-14 still guards an unsupported effect
  rather than letting a renderer silently skip it. Stacks cap at 20
  instances (`EFFECT_STACK_MAX`).
- `check_scene`'s optional `candidate_stack` vets a stack before it is
  written: `unknown_fx` (MO-13) and `invalid_param`/`undrawn_effect`
  (MO-14) diagnostics per instance, without touching the stored
  composition — `docs/motion-api.md` carries the schema.

## Renderer

`src/lib/motion/gl.ts` is a WebGL2 ping-pong pipeline: one fullscreen pass
per effect body, uniforms resolved at `t`, no state between calls — same
(composition, t) → same pixels. A body can name a bounded sub-pass chain
(bloom thresholds, blurs horizontally then composites the vertical blur
over the snapshot input on `u_tex2`; lens blur stacks three directional
gathers). Two effects read `u_tex2` as a source texture — luma matte and
displacement map — and today it binds the layer's own picture until
instances can point at another element's texture. The registry marks them
`needsInput` + `selfMapped`, and `list_motion_effects` reports both as
`needs_input: true` and `self_mapped: true`, so an agent does not expect a
matte from another layer. `paintAt` (2D) feeds `paintSceneFx` which
hands the camera track's stack plus each covered adjustment track's stack
to GL; element-track stacks render in preview through CSS filters. The
browser harness and `paintShutter` (deterministic K-sample motion blur) go
through the same path, so preview, desktop and server harness agree.
Params a spec marks `unit: 'px'` are authored in composition pixels and
scaled by the job's `width / comp.width` ratio at render time, so a 720p
export and the preview apply the same visual strength.

## Looks

`shared/motionLooks.ts` ships 8 named looks (teal-orange, noir, film-35,
crt, glitch, dream, product, riso). `apply_look` materializes one as an
`adjustment` track carrying its stack — `at`/`seconds` add a windowing
clip, absent = the whole film.

## Graph editor

`shared/motionGraph.ts` is the data model the UI consumes: lanes per track,
value segments between keyframes, speed graphs sampled from easings,
bezier-handle → `MotionEasing` conversion, named curve presets, copy/paste
easing and lane selection state. The editor is the frontend's (P2); the
model is stable wire here.

## Algorithms

The GLSL bodies are original implementations of standard image algorithms
(gaussian/box taps, luminance ops, hash noise, distance fields), in the
spirit of EffectCraft's effect modules — see `THIRD-PARTY-LICENSES`.
