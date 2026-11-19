Status: historical background research, superseded as the contract by proposal.md on 2026-11-18.

# Motion Studio Pro — proposal

Date: 2026-11-17. Author: research pass for Bryan. Status: proposal, nothing built.
Goal: "le meilleur tool ever" — a storyboard goes in, the model directs, a film comes out.

Sources read: `/tmp/effectcraft-research` (storytold/effectcraft @ 60e2cbb), Diazo worktrees
`doop-wt/motion-next` (phases 2-5 backend, d9641ab1) and `doop-wt/animate-elements`
(`fix/animate-storyboard-elements`, 619f3e56), `docs/motion-api.md`, `.workflow/changes/motion-*`,
`.context/specs/motion-studio.md`, `docs/adr/0009-0011,0014,0015`.
Facts about Higgsfield, After Effects and the OSS peers come from general knowledge (no live
browsing in this pass): treat product feature lists as "to re-verify before marketing".

---

## 1. effectcraft: what it is and what we can take

### 1.1 What it is

An open-source After Effects clone written in pure Rust by the ArtCraft team (first commit
2026-10-01, alpha, "~45% of the way to production-ready"). Native egui app, CLI, MCP server and a
wasm32 browser build.

- **Engine**: 30 crates, strict layering (`time`, `geom`, `color`, `raster`, `keyframe`, `path`,
  `text`, `effects`, `render`, `gpu`, `expr`, `export`, `lottie`, `aep`, `interchange`, `engine`,
  `automation`...). The UI knows nothing the engine does not expose as a command.
- **Effect model**: a registry of **308 effects, 2988 parameters**, each addressed by id
  (`ec.stylize.glow`) with typed, ranged, defaulted, animatable parameters (`effects/#1/blurriness`).
  `catalog.rs` generates `docs/effects.md`. Parameters can be conditionally shown
  (`param_shown`). Every effect has a CPU implementation (32-bit float, HDR) and 280 have a **wgpu
  compute shader** (`crates/gpu/src/shaders/*.wgsl`, 35 files, ~16k lines) "operation for operation"
  identical to the CPU path, checked by tests.
- **Composition model**: compositions of layers (solid, shape, text, footage, precomp, null,
  adjustment, camera, light), parenting, 38 blend modes, track mattes, masks, time remap, motion
  blur, 3D cameras with depth of field, lights with soft shadows, text animators with range
  selectors, puppet pins, expressions (JS via boa with an AE-like object model), graph editor
  with value and speed curves.
- **Render**: queue with H.264/HEVC/AV1/ProRes/VP9, no FFmpeg (own pure-Rust codecs), PNG/EXR
  sequences, GIF, Lottie both ways, `.aep` import/export, PSD import, Premiere interchange
  (FCP XML, OTIO, EDL).
- **Agent driving**: every menu action and property edit is a command; `effectcraft-cli mcp` exposes
  `command_list`, `command_run`, `command_batch`, `doc_inspect`, `render_preview` (a **contact sheet
  PNG of N times** in one call) and the project as readable JSON (`.ecproj`). Files can be confined
  to read/write roots. This is the part closest to what Diazo's director loop needs.
- **Particles and sims**: Particle Emitter 2D/3D, Particle Playground (92 params), Shatter, Card
  Dance, Caustics, Wave World, Liquid Particles. Plus Glow, Add Grain, VR Chromatic Aberrations,
  Camera Lens Blur, Directional/Radial blur, Turbulent Displace, Fractal Noise, Gradient Ramp,
  Lumetri-style grading, keying, roto brush (SAM 2).

### 1.2 Licence

- Root `Cargo.toml`: `license = "MIT OR Apache-2.0"`; `LICENSE-MIT` and `LICENSE-APACHE` present;
  `NOTICE` and a per-file `ATTRIBUTION.md` for bundled fonts and third-party code.
- Excluded: the **ArtCraft name, wordmark and logos** (`docs/brand/`) are trademarks, not under the
  licence. Never ship them.
- AGPL-3.0 compatibility: MIT and Apache-2.0 are permissive, so code or shaders can be copied into
  Diazo (AGPL-3.0, ADR 0003). Pick the **MIT** option when copying (shortest notice duty). Apache-2.0
  is one-way compatible with GPLv3/AGPLv3 too. Duty: keep the copyright line and licence text in
  `THIRD-PARTY-LICENSES` and in the header of each ported file ("Derived from storytold/effectcraft,
  MIT").
- Caveats to track, not blockers:
  1. Their README says effects were written clean-room "from public behaviour descriptions"
     and parameter names/order/defaults "follow the reference application". That is their risk, but
     if we copy their parameter ids verbatim we inherit it. **Rename to our own ids** (`fx.glow`,
     not `ec.stylize.glow`) and own defaults.
  2. Their GPU code is WGSL compute shaders tied to their buffer layout (`P.f[]`, `P.u[]`,
     `textureLoad`/`textureStore`, `unit_div`/`fxs_qdiv` bit-exactness hacks). Not copy-paste; port
     the maths, not the plumbing.
  3. Project is 6 weeks old and moving fast: pin a commit, do not track upstream.
  4. Dependencies of any crate we might embed need their own licence check (boa, wgpu, candle: MIT or
     Apache, fine; models for roto brush: per-model licence in their `segment` registry).

### 1.3 What to reuse, what to port, what to skip

| Item                                                                                                                                                                                                                                                                           | Verdict                                                          | How                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect registry design (id, typed params, ranges, defaults, `param_shown`, generated catalog doc)                                                                                                                                                                              | **Copy the pattern**                                             | `shared/motionFx.ts`: `FX_REGISTRY` of `{id, name, category, params[], gpu}`; generate `docs/motion-fx.md` and the agent's catalog from it                                                     |
| `render_preview` contact sheet (N times, labelled cells, max side)                                                                                                                                                                                                             | **Copy the idea**                                                | our `get_scene_snapshot` with `times[]` → one PNG sheet (how an agent sees motion; section 5)                                                                                                  |
| Command registry + batch + undo-per-step for agents                                                                                                                                                                                                                            | Already similar (`patch_composition` ops)                        | extend ops with `add_effect`, `update_effect`, `remove_effect`                                                                                                                                 |
| GPU kernels: glow (threshold + blur pyramid + add), gaussian/directional/radial blur, chromatic aberration, add grain, fractal noise, gradient ramp, displacement map, vignette, tone curves, LUT, posterize, glitch, wave warp, bulge, mirror, light-wrap, shatter-like cards | **Port the algorithm to GLSL ES 3.00 (WebGL2)** fragment shaders | ~25 effects in P1; the WGSL stays as reference. Do not run wgpu in the browser: Chromium WebGL2 is available in the editor, CEF desktop shell, headless server (SwiftShader) and WebGPU is not |
| Particle emitters                                                                                                                                                                                                                                                              | **Port the closed-form idea**                                    | stateless: particle i at time t is `f(seed, i, t)`, no simulation state, seek-safe                                                                                                             |
| Motion blur (`fxs_add` accumulation, shutter angle/phase)                                                                                                                                                                                                                      | **Port the idea**                                                | N sub-frame samples of `frameStateAt(t + δ)` accumulated in a float target                                                                                                                     |
| Depth of field (camera lens blur, depth matte)                                                                                                                                                                                                                                 | Port the idea                                                    | per-layer blur by `                                                                                                                                                                            | z - focus | ` (no depth buffer needed with painter's order) |
| Expressions (boa JS, AE object model)                                                                                                                                                                                                                                          | **Do not embed**                                                 | our own pure expression DSL (section 6.4); QuickJS-wasm (ADR 0015) as the escape hatch                                                                                                         |
| Lottie crate, AEP reader/writer, OTIO/FCPXML interchange                                                                                                                                                                                                                       | Skip now, option later                                           | Diazo has its own Lottie and HyperFrames interchange (motion-next). An `.ecproj` exporter is a cheap P4 "finish in a real compositor" button since `.ecproj` is JSON                           |
| Rust engine as a render backend (`effectcraft-cli render`)                                                                                                                                                                                                                     | **Reject for P1-P3**                                             | second, non-identical renderer diverges from the browser preview; breaks the single seek-safe contract. Revisit only as an optional desktop "high quality" target                              |
| Puppet pins, roto brush (SAM 2), 3D camera tracker, keying                                                                                                                                                                                                                     | Out of scope                                                     | P4+ if ever                                                                                                                                                                                    |
| Text engine (shaping, per-glyph animators)                                                                                                                                                                                                                                     | Skip                                                             | Diazo text is real DOM; `motionText.ts` already splits char/word/line                                                                                                                          |
| egui UI                                                                                                                                                                                                                                                                        | Skip                                                             | different stack                                                                                                                                                                                |

Net: effectcraft is a **reference implementation and a shader/parameter catalog**, not a
dependency. The biggest single gift is the effect taxonomy and 25-40 ready algorithms under MIT.

---

## 2. What makes Higgsfield and After Effects feel pro

### 2.1 Higgsfield (AI video, "camera is a menu")

What the user feels: one click on a **named camera move** gives a cinematic result.

- Preset camera library: crash zoom in/out, dolly in/out, dolly zoom (vertigo), FPV drone,
  360/arc orbit, whip pan, crane up/down, handheld, tilt, bullet time, snorricam, rack focus,
  fisheye, overhead, super-dolly, lens crack/glitch. Presets stack (move + effect + style).
- Image → video: a still (first frame, optionally last frame) plus a move prompt.
- Character/product consistency across shots (reference images, "soul" identity).
- Style/look presets (film stocks, anamorphic flares, grain), VFX pack (smoke, fire, explosions),
  lip-sync, one-prompt multi-shot "cinema studio".
- Why it feels pro: the **taste is baked into presets** (curves, overshoot, motion blur,
  easing, a touch of shake, depth blur and grain applied together). The user never tunes a curve.

### 2.2 After Effects (the control surface)

- **Per-layer effect stack**, reorderable, each effect keyframable; adjustment layers apply to
  everything below; blend modes; track mattes and masks (alpha, luma, inverted).
- **Precomps** (nested compositions, time remap, collapse transformations).
- **Time**: speed ramps via time remap, stretch, freeze, reverse, frame blending.
- **Graph editor**: value and speed graphs, separate in/out influence handles, easy ease.
- **Expressions**: `wiggle`, `loopOut`, links between properties (pick whip), `valueAtTime`.
- **Motion blur** (shutter angle/phase, per layer switch), the single biggest "this is not a web
  animation" tell.
- **3D camera + depth of field + lights**, 2.5D parallax from layers at different z.
- **Shape layers**: modifiers (trim paths, repeater, wiggle paths, zig zag, round corners, offset,
  twist, merge), gradients, stroke dashes.
- **Particles and generators**: CC Particle World, fractal noise, gradient ramp, light leaks as
  footage or generated glows.
- **Glow, chromatic aberration, grain, displacement, optics compensation, vignettes** — the finishing
  stack on every pro reel.
- Puppet, motion tracking, roto brush, templates/MOGRTs (parameterised ready scenes: the model for
  our gallery).

### 2.3 Open-source peers

| Tool          | Brings                                                                                                         | What Diazo takes                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Remotion      | React components as frames, `useCurrentFrame`, `interpolate`, `spring`, parameterised templates, Lambda render | Parameterised templates → gallery recipes with typed params; `spring()` already in our easing                                   |
| Motion Canvas | Generator-based timeline authoring, signals, `tween` flows, code-as-timeline with live preview                 | Sequential "flow" authoring feel for the agent: `stagger`, `chain`, `sequence` helpers in the recipe format                     |
| Revideo       | Motion Canvas fork for headless programmatic video, parallel render                                            | Evidence that headless seek-and-capture scales; chunked parallel server render (P5)                                             |
| Theatre.js    | Sequence editor over any JS prop, graph editor UI, keyframes as data                                           | Reference for the graph-editor UX and per-prop keyframe lanes                                                                   |
| HyperFrames   | HTML→video, seek-safe contract, ~450 ready blocks (transitions, kinetic type, captions, charts)                | Already the contract (ADR 0010). **The registry is a ready seed for the gallery** — check its licence per block before bundling |
| Rive          | State machines, runtime playback, interactive vector                                                           | Out of scope for film; relevant to prototypes later                                                                             |
| Jitter        | Designer-friendly motion with presets, templates, easy export (MP4, Lottie)                                    | The "pick a preset, tweak three sliders" UX bar for the gallery                                                                 |
| Lottie        | Interchange of vector transform/shape animation                                                                | Already in motion-next (transform subset); extend with shape modifiers                                                          |

---

## 3. Diazo today: what exists, what is missing

### 3.1 What exists (motion-next, d9641ab1)

- **Contract** (`shared/motion.ts`, `docs/motion-api.md`): one composition per page (ADR 0009);
  tracks `camera | element | clip | audio | caption`; keyframes with `linear | hold | steps |
cubic-bezier | spring | token` easing; 27 animatable element properties (`x y scale scaleX scaleY
rotate skewX skewY opacity blur brightness contrast saturate grayscale hue-rotate borderRadius
color backgroundColor clipPath offsetPath offsetDistance offsetRotate strokeDashoffset
strokeDasharray d fill stroke`) plus any `--custom-prop`.
- **Clips**: frame, library, asset, caption, 3d; transitions `dissolve | push | wipe | zoom |
shared-element`; trim, speed, fades, ducking, beat markers, transcript cuts, captions from
  transcript, generation recipe kept on generated layers.
- **Camera presets** (`shared/motionPresets.ts`): push-in, pull-out, pans, whip-pan, crash-zoom,
  cranes, handheld (seeded), dolly-zoom, orbit. Text animators (`shared/motionText.ts`: char/word/
  line, presets, seeded random order).
- **Runtime** (`shared/motionRuntime.ts`): pure `frameStateAt(comp, t)`; seek-safe lint MO-01..12.
- **Compositor** (`src/lib/motion/compositor.ts`): each frame is rasterised to a bitmap
  (`rasterizeFrame`, SVG foreignObject) and drawn on a **2D canvas** through the camera; a frame an
  element track touches is **re-rasterised from HTML at every t** with the track values written
  into a `<style data-doop-motion>`.
- **Render**: browser (MediaRecorder), desktop (Tauri hidden webview + allowlisted ffmpeg, frame by
  frame), server (headless Chromium, webm/pngseq, 60 s/1080p/30fps cap), Blender target, GIF, PNG
  sequence, CSS+WAAPI code export, Lottie/HyperFrames interchange, motion duel.
- **Media/audio**: speech stack, transcription, voice-over (ElevenLabs), `generate_video`
  (OpenRouter, Gemini), 3D clips with glTF, Blender bridge with approvals.
- **MCP/resident tools**: `get/set/patch_composition`, `animate_storyboard`, `lint_motion`,
  `insert_clip`, `export_composition`, `render_composition`.
- **animate-elements branch** (`server/storyboard.ts`): reads shot notes (FR/EN labels:
  MOUVEMENT, TRANSITION, SON, VOIX OFF, NOTES...) from each frame's HTML, lists up to 24 animatable
  element targets per shot with stamped `data-doop-id`s, and a coverage check
  (`storyboardCoverage`, 2 fix passes) that reports shots whose notes still have no element track.

### 3.2 Why "Animate storyboard" looks basic (root causes, ranked)

1. **The agent only has a hammer: keyframes on ~27 CSS properties.** There is no effect stack, no
   blur variants, no glow, no grain, no chromatic aberration, no displacement, no particles, no
   light leaks, no depth. The best a model can do with that vocabulary is fades, slides, scales and
   blur-ins: the "web animation" look. Vocabulary caps the result.
2. **Presets exist but are invisible to the agent.** `cameraPreset()`, `expandTextAnimator()` and
   the 5 transition kinds live in `shared/` and are not exposed as tools, and the MOTION guide text
   (in the animate-elements branch) never lists them. `grep cameraPreset server src` returns
   nothing: no tool and no UI calls it. The agent hand-writes camera keyframes from "a travelling
   avant is a slow push-in".
3. **The builder is deterministic and dumb.** `animate_storyboard` makes one 3 s shot per frame, a
   camera track of hard `hold` cuts. Everything else is left to "animate every shot the way its
   notes describe". Equal shot length (3 s default) = no pacing, no rhythm.
4. **The brief treats notes as a script, and the success test is existence.** The coverage check
   passes a shot as soon as it has one element track with one keyframe. Two fix passes, then "finish
   and name them". Compliance, not quality, is rewarded; nothing asks for hierarchy, contrast of
   speed, anticipation, overlap, secondary motion or a signature look.
5. **The agent is blind.** `get_scene_snapshot` and `check_scene` are in the proposal (section 7.4)
   but not implemented (no match in server/shared/docs). The model never sees a rendered frame, so
   it cannot critique, and the loop is write-and-hope. Every pro result comes from look-and-fix.
6. **No references.** `search_inspiration` and the Motion category of the design library (959
   families) are never part of the brief; the agent invents motion language from nothing each time.
7. **The renderer cannot do pro finishing even if told.** The compositor draws bitmaps on a 2D
   canvas: no per-layer shader pass, no motion blur (sub-frame accumulation), no depth, no mattes.
   Animated frames are re-rasterised through SVG foreignObject per time sample: slow, and fonts/
   filters differ subtly from the live view.
8. **No time shaping.** No speed ramps (clip speed is a constant), no time remap, no
   expressions: loops, wiggle, links between layers are impossible.
9. **Interleaved concern: the director has no persistent intent.** The notes are text in the frame;
   there is no `direction` object (mood, motion language, rhythm, palette, references) saved with
   the composition, so a refine pass or a remix cannot re-read why.

### 3.3 Gap table

| #   | Feature                                                                        | AE / Higgsfield                    | Diazo today                                         | Proposal                                                                                                                   |
| --- | ------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-layer effect stack                                                         | Core of AE                         | None (filters `blur`, `brightness`... as CSS props) | `effects[]` on element/adjustment/camera tracks; WebGL2 pass; ~25 effects P1, ~60 P3                                       |
| 2   | Adjustment layers                                                              | Yes                                | None                                                | `adjustment` track kind: effect chain over everything below in its time range                                              |
| 3   | Motion blur                                                                    | Layer switch + shutter             | None                                                | Sub-frame accumulation (`shutter` angle, N samples) per comp, per-layer opt-out                                            |
| 4   | Glow, chromatic aberration, grain, light leaks, vignette, displacement, glitch | Yes                                | None                                                | Shipped as effects + "looks" bundles (P1)                                                                                  |
| 5   | Camera presets                                                                 | Higgsfield's hero                  | Contract only, no tool, no UI                       | `apply_camera_preset` tool, picker UI, preset + blur/DoF/shake bundle ("shot recipes")                                     |
| 6   | Depth of field, 2.5D parallax                                                  | 3D camera                          | `3d` clips only; frames are flat                    | `z`, `rotateX/Y` on layers, perspective camera, `focus/aperture`, layer-depth blur (P2)                                    |
| 7   | Easing editor / graph                                                          | Graph editor, speed graph          | Easing union, no editor                             | Graph editor: value + speed, bezier handles, spring editor, presets (P1 FE)                                                |
| 8   | Expressions                                                                    | wiggle, loop, pick whip            | None                                                | Pure expression DSL, seeded, no eval (P3)                                                                                  |
| 9   | Masks and track mattes                                                         | Alpha/luma/inverted                | `clipPath` keyframes                                | `matte` on tracks: alpha, luma, inverted; feathered mask paths (P2)                                                        |
| 10  | Shape modifiers                                                                | Repeater, trim, zig zag, wiggle... | `strokeDashoffset`, `d` morph                       | Vector layer + modifiers (repeater, trim, wiggle, offset, round) (P3)                                                      |
| 11  | Precomps                                                                       | Yes                                | One comp per page                                   | `composition` clip source: a page's comp nested in another, with time remap (P3). Pages = precomps                         |
| 12  | Time remap, speed ramps                                                        | Yes                                | Constant `speed`                                    | `timeRemap` keyframed curve on clips (P2)                                                                                  |
| 13  | Particles                                                                      | CC Particle World                  | None                                                | Stateless seeded emitter effect, GPU (P2)                                                                                  |
| 14  | Transitions                                                                    | Dozens + plugins                   | 5 kinds                                             | 25-30 shader transitions (glitch, whip-blur, luma wipe, ripple, flash, film burn, zoom-through) (P2)                       |
| 15  | Text animation                                                                 | Range selectors, presets           | char/word/line + 8 presets                          | Gallery of 30+ text animations; per-char effect stack (glow, blur-in, split-flap...)                                       |
| 16  | Image → video, character consistency                                           | Higgsfield                         | `generate_video` (OpenRouter, Gemini), recipe kept  | First+last frame conditioning from storyboard frames, camera preset → model prompt, reference images, shot continuity (P3) |
| 17  | Editing: cuts, pacing, beat sync                                               | Premiere                           | Cuts as data, beats, snapToBeat, ducking            | Edit planner: cut on beats, J/L cuts, pacing curve, auto-trim to music (P2)                                                |
| 18  | Voice-over, captions, mix                                                      | Premiere/Audition                  | Done (speech stack, captions)                       | Karaoke caption styles, loudness target, music bed auto-duck (P2)                                                          |
| 19  | Blender 3D shots                                                               | n/a                                | Bridge, approvals, render target                    | Shot recipe "3D shot": camera path from preset, return as layer (P4)                                                       |
| 20  | Gallery of presets/templates                                                   | MOGRTs, Jitter, Higgsfield styles  | Library "Motion" category (CSS items)               | **Motion Gallery** as a library kind with typed recipes (P1 seed, P2 full)                                                 |
| 21  | Director loop                                                                  | n/a (human)                        | Brief-once + 2 fix passes on coverage               | Plan → build → snapshot → critique → refine, N passes (P1)                                                                 |
| 22  | Agent sees output                                                              | Human eye                          | None                                                | `get_scene_snapshot` contact sheet, `check_scene` (P1, critical)                                                           |
| 23  | Look / colour grade                                                            | Lumetri, LUTs                      | CSS filters                                         | `grade` effect (lift/gamma/gain, curves, 3D LUT), looks bundles (P1 basic, P3 LUT)                                         |
| 24  | Export fidelity                                                                | ProRes, EXR                        | WebM/MP4/GIF/PNG seq, server webm                   | Keep; add alpha WebM and ProRes via ffmpeg desktop (P4)                                                                    |

---

## 4. Architecture that makes it all fit the seek-safe contract

### 4.1 The rule

Every pixel is a pure function of `(composition, t)`. Add to it: `(composition, t)` plus **seeded
hashes of ids**. No wall clock, no mutable simulation state, no frame-to-frame feedback. So:

- **Grain / noise / flicker / glitch**: `hash(seed, floor(t * fps))` or `hash(seed, t)`; stable on
  seek.
- **Particles**: closed form `pos = p0(seed,i) + v0(seed,i)*age + 0.5*g*age^2`, `age = t - birth(i)`,
  `birth(i) = i / rate`. No integration, any t is O(1).
- **Motion blur**: evaluate `frameStateAt` at K sub-times inside the shutter window and average.
- **Feedback effects (echo/trail)**: replace by sampling past times `t - k*dt` (also pure).
- **Expressions**: pure functions of `time`, other properties' resolved values and seeded
  `wiggle`.
- **Lint additions** `MO-13..`: an effect param may not read `Date`, a generated asset must have a
  fixed `assetId`, particle emitters must carry a seed, an effect that uses feedback must declare
  `lookback`.

### 4.2 Compositing pipeline change (the keystone)

Today: bitmap per frame → 2D canvas → (animated frames re-rasterised from HTML each t).

Proposed **layer compositor** (`src/lib/motion/gl/`):

1. **Layer rasterisation once**: rasterise each animated element (or each frame, as today) to a
   texture one time at the highest needed density. Element tracks then animate transform,
   opacity and effects **on the GPU**, no re-rasterisation per t. Frames or elements whose HTML is
   itself time-driven (`--t`, `data-doop-scene`) stay on the existing per-t path (`moving: true`).
2. **WebGL2 renderer** with a small render-graph: layer → effect chain (ping-pong FBOs, RGBA16F
   when `EXT_color_buffer_half_float`, RGBA8 fallback) → composite with blend mode and matte →
   adjustment chains → camera/transform → output. Float targets matter for glow, motion blur
   accumulation and banding-free grain.
3. **Fallback**: Canvas 2D path stays for the editor on devices without WebGL2, with effects
   flagged "not shown" by `check_scene`.
4. **Same module everywhere**: browser preview, MediaRecorder render, desktop harness, server
   harness (SwiftShader in headless Chromium: slow but deterministic enough; render at 720p by
   default, 1080p within the existing cap). The shader code is shipped once, as TS string
   constants, hashed into the render job so a render is reproducible.
5. **Determinism guard**: golden-frame tests (`tests/motionFxBrowser.test.ts`) render each effect at
   fixed t and compare with a tolerance; `MotionRenderHarness` gets `__doopMotionSeek(t)`
   unchanged.

Performance budget (targets, 1080p, M-series Mac, preview):

| Item                                            | Budget                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Preview at 30 fps with ≤ 6 layers × ≤ 3 effects | 60 fps GPU time ≤ 8 ms                                                      |
| Glow/blur pyramid                               | ≤ 6 passes at half res                                                      |
| Motion blur                                     | K = 8 preview, 16 render; ×K cost only on layers with motion                |
| Particles                                       | ≤ 50k per emitter, instanced, one draw                                      |
| Per-t HTML re-rasterisation                     | unchanged (kept only for `--t` scenes)                                      |
| Server render (SwiftShader)                     | auto-cap: ≤ 2 effects per layer, K ≤ 4; refuses higher with a clear message |
| Total texture memory                            | ≤ 512 MB, layers above that rasterised at lower density                     |

### 4.3 Data contract additions (all additive, per `docs/motion-api.md` rule)

```ts
// shared/motionFx.ts (new)
interface EffectInstance {
  id: string // nanoid, stable (keyframes address it)
  fx: string // registry id: 'glow', 'chromatic-aberration', 'grain', ...
  enabled?: boolean
  params: Record<string, number | string | boolean> // resting values
  seed?: number // deterministic noise/particles
  mix?: number // 0..1 wet/dry
  blend?: BlendMode
}
// MotionTrack gains (additive):
//   effects?: EffectInstance[]                     // element, clip, camera, adjustment
//   matte?: { source: trackId; mode: 'alpha'|'luma'|'alpha-inv'|'luma-inv' }
//   blend?: BlendMode
//   z?: number                                     // 2.5D depth (px, 0 = frame plane)
// MotionTrackKind gains: 'adjustment'
// Keyframe property namespace: 'fx:<instanceId>.<param>'  (e.g. 'fx:g1.intensity')
// Composition gains:
//   motionBlur?: { shutter: number /*deg, 180*/; samples?: number }
//   camera3d?: { fov: number; focus: number; aperture: number }   // with DoF
//   direction?: Direction                                          // see section 5
```

Keyframes, easing, token easings, patch ops (`add_effect`, `update_effect`, `remove_effect`,
`reorder_effects`), undo, versions, REST, room messages, Lottie/HyperFrames interchange (effects
listed as "cannot export", like masks today) all reuse what exists. The CSS/WAAPI code export
marks effects the CSS runtime cannot say, or exports an SVG-filter equivalent for blur/glow/
displacement where possible.

### 4.4 Effect registry (the agent's vocabulary)

`FX_REGISTRY` in `shared/motionFx.ts`: id, name, category, description (one line, written for the
model: "when to use it"), params with `{type, min, max, default, unit, description}`, `cost` (1-5),
`seedable`, `lookback`, GLSL source key. From it the system generates:

- the editor's Effects panel and Effect Controls (no hand-written UI per effect);
- `docs/motion-fx.md`;
- the agent's catalog: `list_motion_effects` (compact, filterable) and a 40-line cheat sheet in the
  guide;
- lint rules (`MO-14`: unknown fx, out-of-range param) and the Lottie/code-export "unsupported"
  list.

---

## 5. The director loop and the new brief

### 5.1 Brief rewrite (the biggest quality lever for the least code)

Replace the "animate every shot per its notes" instruction by a **director's brief**:

- Notes, pasted screenshots and shot text are **intent, not a script**. The agent may add, drop,
  reorder or retime shots, change shot lengths, invent transitions and a sound plan. The only hard
  constraints: stay within the user's content, brand tokens and duration/format.
- Mandatory structure: a one-paragraph **treatment** (mood, motion language, rhythm, hero moment,
  reference ids), a **shot list** with lengths that are not all equal, and a **look** (effects
  bundle applied on an adjustment track: grade + grain + vignette + light bloom by default
  "cinematic polish", overridable).
- Craft rules written into the brief: anticipation and overshoot on entrances (spring tokens),
  stagger and overlap (never everything at once), one hero move per shot, contrast of speed
  (slow-fast-slow), motion blur on fast moves, depth (parallax between layers via `z`), secondary
  motion (subtle drift on holds, 1-3% scale), consistent easing family from tokens, transitions
  that carry motion across the cut (match direction and speed), end hold on the last shot,
  captions/safe zones respected.
- The brief lists the **vocabulary by name** (camera presets, transitions, text animations, effects,
  looks) and says "prefer gallery items; build custom only when none fits".

### 5.2 Loop

```
 PLAN     get_storyboard → reference pass (search_inspiration + search_motion_gallery)
          → write Direction {treatment, beats[], look, references[], rhythm, passes}
 BUILD    animate_storyboard (builder now consumes Direction: shot lengths, transitions,
          camera presets, look) → agent patches per shot with gallery items + effects
 SEE      get_scene_snapshot {times[]: shot midpoints, transition midpoints, first/last} → contact sheet PNG
          check_scene → MO-* lint + legibility/contrast + safe zones + pacing stats + effect cost
 CRITIQUE structured self-review vs Direction and notes (rubric below) → list of concrete patches
 REFINE   apply patches (ops), re-snapshot only the changed times; stop at N passes or "no issue >= major"
```

- N = 3 by default (`direction.passes`), hard max 5; each pass is cost-metered and the stop
  condition is "no blocker/major issue" or budget reached (reuse the agent meter).
- **Rubric** (fixed JSON, so critique is machine-checkable): `intent_coverage`, `hierarchy`
  (one focal point per beat), `legibility` (text contrast, size, time on screen ≥ reading time),
  `pacing` (shot-length variance, no dead beats > 1.5 s without motion), `motion_quality`
  (easing variety, overshoot, blur on fast moves), `continuity` (cuts carry motion), `polish`
  (look applied, no clipped edges), `brand` (tokens). Each: score 1-5 + issue list with
  `{t, layer, fix}`.
- `get_scene_snapshot` is **the** enabling tool: renders N times through the real compositor
  (browser/desktop/server harness; server one for agents with no app open) and returns one labelled
  contact sheet plus numeric stats (mean luminance per cell, motion energy between cells, text
  bounding boxes). Idea taken from effectcraft's `render_preview`.
- `Direction` is stored on the composition (`direction` field) and shown in the UI as the "Director's
  notes" panel: people can edit intent, lock a decision, or press "re-direct with this note".
- Deterministic builder stays as the cheap first pass: it now emits real shot structure instead of
  hard cuts only.

### 5.3 New / changed tools (MCP and resident, same names; contract per `agentToolParity.test.ts`)

| Tool                                                                                                         | Purpose                                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `get_scene_snapshot`                                                                                         | Contact sheet at `times[]` (or `auto: 'beats'`), plus stats     |
| `check_scene`                                                                                                | Lint + legibility + pacing + effect-cost report                 |
| `list_motion_effects`                                                                                        | Catalog, filter by category/query                               |
| `set_effects` / patch ops `add_effect`, `update_effect`, `remove_effect`                                     | Effect stack on a track                                         |
| `apply_look`                                                                                                 | A bundle of effects on an adjustment track                      |
| `apply_camera_preset`                                                                                        | `cameraPreset()` exposed (+ DoF/shake bundle)                   |
| `apply_transition`                                                                                           | Transition kind/shader between two clips                        |
| `set_direction` / `get_direction`                                                                            | Persist the treatment                                           |
| `search_motion_gallery`, `get_motion_item`, `insert_motion_item`, `remix_motion_item`, `publish_motion_item` | Gallery (section 7)                                             |
| `critique_scene` (optional convenience)                                                                      | Runs the rubric prompt on a snapshot, returns structured issues |
| `set_expression` (P3), `set_time_remap` (P2), `set_matte`, `set_blend`                                       | Pro controls                                                    |

---

## 6. Feature designs

### 6.1 Effects stack and the P1 effect set (port from effectcraft)

Registry ids are ours. Algorithm source in parentheses.

| Category   | P1 (≈25)                                                                                                                                                                            | P2/P3                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Blur       | gaussian, directional, radial/zoom, lens blur (box bokeh), whip blur                                                                                                                | tilt-shift, smart blur          |
| Light      | glow (threshold + mip pyramid + add; effectcraft `fxs_glow_*`), bloom, light-leak (procedural gradients + noise, animated by t), lens flare (anamorphic streak), vignette, god rays | lens dirt, volumetric           |
| Lens       | chromatic aberration (radial RGB offset; effectcraft VR chromatic), barrel/fisheye, lens distortion, rolling shutter                                                                | optics compensation             |
| Texture    | film grain (hash-based, luma-weighted; effectcraft `addgrain`), noise, scanlines, halftone, pixelate                                                                                | halation, dust & scratches      |
| Distort    | displacement map (noise/gradient/another layer), wave warp, turbulent displace, bulge/pinch, mirror, slit-scan-ish stretch                                                          | mesh warp                       |
| Color      | grade (lift/gamma/gain + saturation + temperature/tint), curves (1D LUT), tint, duotone, invert, posterize, hue shift                                                               | 3D LUT `.cube`, selective color |
| Glitch     | RGB split + block shift + scan jitter (seeded)                                                                                                                                      | datamosh-style hold             |
| Generators | gradient ramp, fractal noise, solid, grid                                                                                                                                           | caustics, plasma                |
| Matte      | alpha/luma matte, feather, choke                                                                                                                                                    | keyers                          |

"Looks" are saved stacks (cinematic polish, 16 mm film, VHS, neon night, clean product, dreamy
bloom, mono noir). They are the Higgsfield-style one-click taste layer.

Port procedure per effect: read the effectcraft `.wgsl`/Rust algorithm, rewrite as a GLSL ES 3.00
fragment shader with our uniform block, add a golden-frame test, add a param schema entry, add
THIRD-PARTY note if derived. Estimated 0.5-1 day each for blur/grain/CA, 2 days for glow and
displacement.

### 6.2 Motion blur and camera finishing

- Comp `motionBlur: {shutter: 180, samples}`; per-track opt-out. Sampling: `t + shutter/360 *
(k/K - 0.5)/fps` for k in 0..K-1. Static layers sampled once (detect by comparing resolved
  state), so cost scales with moving layers only.
- Camera presets become **shot recipes**: keyframes (existing `cameraPreset`) + optional bundle
  (motion blur on, subtle handheld, DoF bump, grain). `whip-pan` writes directional blur keys
  automatically (the code already says "the editor pairs it with a blur bump": implement it).
- New presets to reach Higgsfield parity: FPV dive (path through z), super-dolly, snorricam
  (layer locked to camera), tilt, rack focus (animates `focus`), arc, lens-crack reveal,
  hyperlapse, bullet time (orbit + time freeze), overhead. Presets live in the gallery as recipes
  (section 7), the TS `cameraPreset` is the engine for the geometric ones.

### 6.3 2.5D and 3D camera, depth of field

- Tracks get `z`, `rotateX`, `rotateY`; composition `camera3d {fov, focus, aperture}`.
  Perspective projection in the layer compositor; painter's algorithm by z.
- DoF: per layer, blur radius = `aperture * |1/z - 1/focus|`-style circle of confusion, then a
  bokeh-shaped blur (disc kernel, effectcraft camera lens blur as reference). Keyframable `focus`
  gives rack focus.
- Auto-parallax: "Depth" tool splits a frame into layers (existing elements by DOM order get
  increasing z) — and for flat screenshots, optional AI depth map from the user's own model account
  (P4). Keep it opt-in.

### 6.4 Expressions (P3)

Pure DSL, no `eval`: parse to AST, evaluate per t.

```
wiggle(freq, amp, seed?)   loopOut('cycle'|'pingpong')   linear(t, t0, t1, v0, v1)
ease(...)   noise(x)   thisLayer.opacity   layer('Title').x   valueAtTime(t)   clamp()   sin()
```

Stored as `expression: string` on a keyframe lane. Seeded by `lane id` so every seek is identical.
Lint: unknown identifier, cycle in links. Advanced escape hatch (P4): QuickJS-wasm (ADR 0015).

### 6.5 Graph editor (frontend-heavy)

Value graph + speed graph, bezier handles on every segment (maps to existing `cubic-bezier`),
spring editor (stiffness/damping/mass with a live curve), overshoot preview, easing presets
(easy ease, expo, back, bounce, elastic as sampled `steps`-free beziers or springs), copy/paste easing,
multi-select keyframes, lane solo. No contract change.

### 6.6 Time: speed ramps, remap, freeze

`MotionClip.timeRemap?: MotionKeyframe[]` (property `time`, value = source seconds) with the same
easings; `speed` stays as the simple constant. Freeze frame, reverse, ramp-in/ramp-out presets. The
runtime resolves `mediaTime(t)`; video decode seeks by that (WebCodecs/`<video>` as today).

### 6.7 Particles, transitions, matte

- Particle effect (`fx: 'particles'`): emitter shape (point/line/rect/circle), rate, lifetime,
  velocity cone, gravity, size and opacity over life, colour ramp, sprite (dot, spark, glyph,
  any asset), blend add, seed. Presets: sparks, snow, dust, confetti, embers, bokeh.
- Shader transitions (25-30): dissolve variants, luma wipe, directional blur whip, glitch, flash/
  film burn, ripple, page curl, zoom-through, radial wipe, shatter-lite, RGB split cut, light-leak
  cut, mask reveal by shape. Contract: `transition.kind` stays a string from a registry;
  `params` added.
- Matte: `matte: {source, mode}` composited in GL pass.

### 6.8 Editing, audio, captions (Premiere side)

- **Edit planner** (`plan_edit`): given media + beats + transcript, proposes cuts: on beat, on
  silence/filler gaps, with pacing curve (fast open, breathing mid, build to end), J/L cuts for
  voice, auto-ducking, loudness target (-14 LUFS preview estimate, ffmpeg `loudnorm` at render).
- Captions: styles as gallery items (karaoke word highlight, pop-in per word, lower third) built
  on `captionsFromTranscript` and the text animator.
- Voice-over: kept as is (speech stack); add "voice style" presets and a one-pass re-timing of
  shots to the VO ("fit shots to narration").

### 6.9 Image → video and generation (Higgsfield side) on the user's own accounts

- Convert a storyboard shot into a generated video: first frame = the frame's raster, optional last
  frame = next shot's raster (models that support first/last conditioning), prompt = shot note +
  selected camera preset translated into model camera terms.
- Reference images for consistency (product/character): store as `generation.references[]` on the
  layer recipe (already keeps prompts).
- Generated layers are normal layers: effects, mattes and presets apply. Cost shown before running
  (existing meter). Models: OpenRouter and Gemini today; add providers as the user connects them.
  Never uses the server's key without consent.

### 6.10 Blender (desktop)

Shot recipe "3D shot": a gallery item that, via the approved Blender bridge, builds a scene
from the camera preset (orbit/FPV/dolly path), renders frames, returns an `asset` clip. Already
feasible with motion-next's `blender_*` tools; the work is a recipe + agent brief + preview.

---

## 7. The Motion Gallery

Modelled on design libraries (`.context/specs/design-libraries.md`, `server/libraries*.ts`,
`shared/library*.ts`, `src/components/library/*`).

### 7.1 Item types (`kind`)

`effect-look` (an effect stack), `camera` (shot recipe), `transition`, `text` (text animation),
`caption-style`, `scene` (a partial composition: tracks with relative times, 1-10 s, with
placeholders), `particle`, `generator` (background/light leak), `audio-bed` (pointer to asset).

### 7.2 Recipe format (`shared/motionRecipe.ts`)

```ts
interface MotionRecipe {
  v: 1
  kind: 'effect-look' | 'camera' | 'transition' | 'text' | 'caption-style' | 'scene' | 'particle' | 'generator'
  name: string
  description: string
  tags: string[]
  duration?: number // natural length (s), scalable if `stretch: true`
  params: RecipeParam[] // typed knobs shown as sliders: {id, label, type, min, max, default}
  slots?: { id: string; kind: 'text' | 'image' | 'frame' | 'color' }[] // what the user fills (scene/text)
  body: {
    // data, never script
    tracks?: MotionTrack[] // with `{{param}}` bindings and relative times (0..1 or seconds)
    effects?: EffectInstance[]
    camera?: { preset: CameraPreset; amount?: number }
    transition?: MotionTransition
    textAnimator?: FrameTextAnimator
  }
  requires: string[] // fx ids and runtime features, for lint/compat
  seekSafe: { verdict: boolean; checkedAt: number; reasons: string[] } // reuse insert_clip's verdict
  preview: { posterTime: number; assetId?: string }
}
```

A recipe is **data**, not code, so the agent can read, remix and diff it, and humans can tweak
sliders. Escape hatch: `kind: 'scene'` may carry a seek-safe HTML block (as library Motion items
do today, passing `lint_motion`).

### 7.3 Storage and server

- Reuse `libraries` / `library_items` / `library_item_meta` and the search index (BM25 over
  name/tags/description). Add `library.kind = 'motion'` with a rules preset `motion` (extends
  `blank`/`sheets`), facets: kind, category (camera, light, glitch, text, transition...), duration,
  cost, mood tags.
- Items live as frames on a library canvas (a recipe = a frame with a `<script type="application/json"
data-doop-recipe>` and a seek-safe demo scene) so versions, comments, curation and AI descriptions
  work unchanged. `libraryExtract` reads the recipe block into the item projection.
- Thumbs: today a JPEG. Motion needs **animated previews**: `GET .../items/:id/preview.webm`
  rendered with the server harness (4 s, 480p, cached by recipe hash), poster JPEG as the grid
  image. The grid autoplays on hover from the live runtime (cheap, local) — no video file needed
  in the editor, the video is for share/LLM-less contexts.
- Seeded builtin **Diazo Motion** library (public, read-only to others, `DOOP_PUBLIC_LIBRARIES`):
  ~40 camera, ~30 looks, ~30 text, ~25 transitions, ~10 generators/particles, ~20 scenes. Authored
  by us from the preset code and effectcraft-derived shaders. Optionally import HyperFrames registry
  blocks after a licence check per block (their import path exists: `hyperframes-project` v1).
- Agent tools (section 5.3): `search_motion_gallery` (BM25 + filters; returns compact cards with
  params), `get_motion_item`, `insert_motion_item {item, target, start, params, slots}`,
  `remix_motion_item {item, instruction}` (agent edits the recipe, result saved to the person's
  library, original untouched), `publish_motion_item`. Writes follow `AGENT_LIBRARY_WRITES` like
  existing library tools.

### 7.4 Humans

- Gallery page `/motion` (or tab in `/libraries`): grid with live hover preview, facets, search,
  "Use" button.
- In the timeline: right-click a clip → "Add effect…", "Camera move…", "Transition…", "Text
  animation…" open a quick-search popover on the gallery (cmdk, already in the app).
- Item page: live preview with the param sliders, "Insert at playhead", "Remix with the agent",
  "Save as my preset" (any selection of tracks → recipe).
- ⌘F Library scope already searches libraries; motion items appear there.

### 7.5 Licensing of gallery content

Own-authored recipes: AGPL with the repo. Shader ports: MIT notice. HyperFrames blocks: check each
block's licence field before import; record `source` and `licence` per item (`library_item_meta`),
display it in the item page. User-published items: licence chosen at publish (default all rights
to the user, usable by instance).

---

## 8. Phased plan

Each phase has a **backend contract** (BE: shared types, server, MCP/resident tools, runtime,
tests) implemented first on the backend against `docs/motion-api.md`, then a **frontend** part (FE).
All additive; the shared GL runtime is TypeScript in `shared/` and `src/lib/motion/gl/` and counts as
"runtime" (BE-owned for the render path, FE-owned for editor wiring).

### P0 — Eyes and vocabulary (1 week, unblocks everything)

Why first: without eyes the director loop is impossible and without exposed presets the brief
cannot change. Zero renderer work.

BE

- `get_scene_snapshot {page_id, times[] | auto, max_side, columns}` MCP + resident: renders through the
  motion harness (desktop device if online, else server renderer gate) → contact sheet PNG + stats.
  Needs the harness to run on the server for any user (today server renders are webm/pngseq,
  60 s cap; snapshot reuses the same page, single frames, no cap issue).
- `check_scene`: lint (existing MO rules) + legibility (text contrast via sampled frame) + pacing
  stats + safe zones. JSON report.
- `apply_camera_preset`, `apply_transition`, `apply_text_animation` tools wrapping
  `cameraPreset`, transitions, `expandTextAnimator`.
- `Direction` type + `set_direction`/`get_direction` (field on Composition, additive).
- Guide `MOTION` text rewritten as the director's brief (section 5.1), with the vocabulary list;
  `animate_storyboard` accepts `direction` and uses it for shot lengths and transitions (builder
  still deterministic, now with non-equal lengths when `beats` given). Merge/rebase
  `fix/animate-storyboard-elements` on `feat/motion-backend-next` first (they diverge: the guide
  MOTION block exists only in the former).
- Agent parity tests (`agentToolParity.test.ts`), `tests/motionSnapshot.test.ts`.
  Acceptance

1. `get_scene_snapshot` with 6 times returns one PNG ≤ 2 MB and numeric stats in < 8 s on the
   desktop path, < 20 s on the server path.
2. An agent calls `apply_camera_preset` for all 13 presets and `get_composition` shows ordinary
   editable keyframes.
3. On a 5-frame storyboard the agent output has non-equal shot lengths and at least one
   non-cut transition, verified by test on the builder with a `Direction`.
   FE

- Snapshot viewer in the agent run log (the contact sheet is shown to people too).
- Camera preset picker (13 buttons + amount slider) on the camera track; transition picker on clip
  edges; text animation picker. These need no GL.
- "Director's notes" panel (read/write `direction`).
  Acceptance: a person can apply any preset and undo it in one step; the notes panel round-trips.

### P1 — Pro finish (3-4 weeks) — **recommended first build**

Perceived quality changes most here: grade + glow + grain + vignette + motion blur + chromatic
aberration + presets with taste, all reachable from the agent and one click.

BE

- `shared/motionFx.ts` registry (25 effects, section 6.1), `EffectInstance`, patch ops, validation,
  `fx:` keyframe namespace, `adjustment` track kind, `blend`, `motionBlur`, lint MO-13/14,
  interchange "unsupported" lists, CSS export fallbacks.
- `src/lib/motion/gl/` WebGL2 layer compositor: layer textures, effect chain with ping-pong
  float FBOs, adjustment chains, blend modes, motion blur accumulation, same entry
  `paintAt(ctx|gl, comp, stage, t)` used by preview, browser render, desktop harness
  (`__doopMotionSeek/Capture`), server harness. Per-t HTML re-rasterisation path kept for `--t`
  scenes.
- `list_motion_effects`, `add_effect`/`set_effects`, `apply_look` tools and parity.
- 8 built-in looks and 13 camera "shot recipes" with bundles (blur, DoF placeholder, grain).
- Golden-frame browser tests per effect; perf test (1080p, 6 layers, 3 effects, 60 fps preview on CI
  Linux container with SwiftShader is not required: gate is "render completes and matches goldens",
  perf measured on the Mac only).
  Acceptance

1. 25 effects present, each: param schema, golden test, doc entry, agent catalog entry.
2. A frame with glow + grain + chromatic aberration + vignette renders identically (±2/255) in
   browser export and desktop export for 5 sampled times.
3. Motion blur on a whip-pan visibly smears; with `shutter: 0` output equals the no-blur frame
   exactly.
4. `check_scene` flags an unknown effect id and an out-of-range param.
5. Server render of a 10 s 720p comp with 2 effects/layer completes within 5 min and is refused
   with a clear error above the cost cap.
6. Seek determinism: same t twice, and t reached from two different seek paths, are pixel-identical.
   FE

- Effects panel (browse by category, drag onto a layer, search), Effect Controls with sliders
  generated from the registry, keyframe diamonds per param, enable/solo/reorder, "Looks" strip.
- Adjustment layer row in the timeline; blend mode menu; motion blur toggle with shutter field.
- Easing/graph editor v1: value graph + bezier handles + spring editor + presets (no contract
  change).
- Preview stays at 60 fps with a quality toggle (Full / Half / Quarter) and a "cost" badge
  per layer from the registry.
  Acceptance: an editor with no AE knowledge builds a 5 s title with glow, grain and a whip transition
  in under 2 minutes using only the panel; every param is keyframable with one click; the graph editor
  edits any segment.

### P2 — Cinematic depth and the gallery (4-5 weeks)

BE

- 2.5D: `z`, `rotateX/Y`, `camera3d {fov, focus, aperture}`, DoF pass, rack focus preset,
  parallax auto-stack from DOM order.
- Mattes (`matte`), particle effect (stateless), shader transitions (25), time remap, speed ramps.
- Motion Gallery backend: `shared/motionRecipe.ts`, `library.kind = 'motion'` + rules preset,
  `libraryExtract` recipe reader, item previews (webm render + poster), builtin library seed
  (~120 items), tools `search_motion_gallery`, `get_motion_item`, `insert_motion_item`,
  `remix_motion_item`, `publish_motion_item`, REST under `/api/libraries/...` (reused) + `/api/motion/...`
  for preview.
- Edit planner `plan_edit` (beats/silence/pacing), caption style items.
- Director loop v2: `critique_scene` rubric, pass budget, `direction.passes` honoured by the
  resident run; the coverage check becomes a quality gate (rubric ≥ 3.5 mean or passes exhausted).
  Acceptance

1. A scene with a screenshot split into 3 layers at different z and a camera push shows parallax and
   DoF; rack focus changes sharpness of the targeted layer deterministically.
2. Gallery search "whip" returns whip pan, whip blur transition, whip text within top 5.
3. `remix_motion_item` yields a saved variant with changed params and the original untouched.
4. Particle effect at 50k particles renders any t in O(1) (test: t=0, t=9.7, t=0 give identical
   bytes for t=0).
5. Director loop: on the same 5-shot storyboard, 3 passes produce a final scene where the rubric
   mean rises from the first to the last pass in ≥ 4 of 5 trial runs (measured by a fixed judge
   prompt; report, do not hard-gate CI).
   FE

- Motion Gallery page + live hover previews, facets, item page with sliders, insert at playhead,
  "Remix with agent", "Save as preset" from selection.
- Quick-add popovers (right-click, `/` in timeline).
- 3D camera widget (fov, focus line, aperture) and z lane; matte picker; time remap curve editor;
  particle emitter controls.
- Director panel: shows treatment, pass log with contact sheets and rubric scores, "run another pass".
  Acceptance: a person can go storyboard → Animate → read the director's log → ask for another pass
  with one sentence, entirely in the UI.

### P3 — After Effects depth (5-6 weeks)

BE: expression DSL and lane `expression`; precomps (`composition` clip source + nested time remap,
pages as precomps, recursion guard); shape layer + modifiers (repeater, trim, wiggle, zig zag,
offset, round corners, merge) with SVG output and Lottie export of the vector subset; 3D LUT and
curves grade; 60 total effects; first/last-frame image→video, reference images,
camera-preset→model prompt mapping; Blender "3D shot" recipe; alpha WebM, ProRes (desktop ffmpeg).
Acceptance: `wiggle` and `loopOut` reproduce identically at any t; a precomp placed twice with
different time remaps plays correctly; generated video clip created from two storyboard frames keeps
its recipe and costs shown before run.
FE: expression editor (autocomplete, errors, pick-whip links), precomp breadcrumb, shape modifiers
panel, LUT picker, generation panel with first/last frame, Blender shot recipe UI.

### P4 — Beyond (optional)

AI depth maps for flat screenshots, roto/matte by model on the user's key, motion tracking,
ecproj export to effectcraft, WebGPU path for heavy effects, parallel chunked server render
(Revideo-style), collaborative playhead already present.

### Recommended first build: **P0 then P1**, in that order

P0 is a week and makes every later change measurable (agent sees, presets callable, brief rewritten).
It also likely improves the current output alone. P1 then changes how the film _looks_ across the
board. P2's gallery can start designing in parallel (spec only) while P1 is built.

---

## 9. Risks and mitigations

| Risk                                                                                | Mitigation                                                                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGL in server/desktop render differs from the editor                              | One TS shader source, golden tests per effect, harness shares the module, float targets, tolerance ±2/255 documented                                     |
| SwiftShader too slow for server renders                                             | Cost model per effect, caps (existing 60 s/1080p/30 fps) tightened for GL; fall back to desktop render recommendation in the 4xx message                 |
| Re-rasterising HTML per t is slow and inconsistent                                  | Layer-once rasterisation for element tracks; keep per-t only for `--t` scenes                                                                            |
| Font/filter fidelity of SVG foreignObject rasterisation                             | Already the current path; layer-once does not worsen it; add `check_scene` rasterisation warnings                                                        |
| Memory (many 4K textures)                                                           | Density cap, texture budget, eviction by visibility window                                                                                               |
| Agent writes huge/unsafe effect stacks                                              | Registry validation, `cost` budget per composition (`check_scene`), param clamps                                                                         |
| Prompt cost of vision critique                                                      | Contact sheet at 1-2 MB, ≤ 3 passes default, metered, stop on "no major issue"                                                                           |
| Licence drift (HyperFrames blocks, effectcraft updates)                             | Pin commit, per-item `source`/`licence` metadata, THIRD-PARTY-LICENSES entry per ported file                                                             |
| Scope creep toward a full AE clone                                                  | Phases gated by acceptance; effectcraft is 308 effects after 6 weeks of a 30-crate team: we ship ~60 curated                                             |
| Contract churn                                                                      | Additive only (`docs/motion-api.md` rule); effects and recipes are optional fields                                                                       |
| Branch divergence (`fix/animate-storyboard-elements` vs `feat/motion-backend-next`) | P0 task 0: rebase animate-elements onto motion-next, port `server/storyboard.ts` and the guide block, resolve `animate_storyboard` signature differences |

## 10. Build notes for the two agents

- Backend: start from `shared/motionFx.ts` and `shared/motionRecipe.ts` types and
  validation, with tests before runtime; GL shaders are TS string modules; every effect needs a
  golden test; keep `docs/motion-api.md` "Changes" in step; never rename `data-doop-*`,
  `doop:` keys, MCP tool names that exist.
- Frontend: generate Effect Controls from the registry, never hand-code one; reuse
  `src/components/library/*` for the gallery grid and `ItemThumb` patterns; all strings through
  `src/lib/i18n/{en,pt-BR}/motion.ts`; design tokens and primitives from `src/components/ui`.
- Repo rules: PRs `feat/*` → `dev`, shown to Bryan as a local draft first; before commit
  `bun run typecheck && bun run lint && bun run test`; no references to doop's name/logo in
  anything user-visible; no new ingress.
