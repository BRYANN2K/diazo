# Motion Studio

Status: proposal, not built. Research dated 2026-11-15, second pass the same day (sections 14 to
17); voice and transcription researched 2026-11-16 (section 18). Product name: Diazo (formerly
redoop). Module codename: Rostrum. Screens: canvas `bIK8evKpnI`, page "18 Motion Studio", 21
frames mapped in section 16. Not a paid feature: Diazo is not commercialised. The only costs are the user's own (their provider accounts, their GPU,
their Octane licence), shown like the usage meter.

## 1. Thesis

**A film is a page with a clock.** A Diazo frame is already a live HTML document. Motion Studio
adds one thing to a page: a seekable timeline whose every pixel is a function of time. A camera
moves across the page's frames, layers carry keyframes, and the result plays in the canvas, exports
as video, or ships as the CSS and WAAPI code itself.

Why this wins against what exists (section 3):

- Generative video tools (Kling, Gemini Omni, Runway) make pixels nobody can edit. They are good
  for B-roll, bad for a product's own UI, text and brand.
- Figma Motion (open beta since 2026-06-24) animates vectors. It has no audio, no video import and
  no native Lottie export, and its layers are not the real product.
- HyperFrames renders HTML to video deterministically, but it is a project folder and a CLI, with
  no design canvas, no multiplayer and no design system.
- Diazo has the frames, the tokens, the components, a 959-family Motion category in the design
  library, agents that already write HTML, a headless renderer and a desktop shell. The missing
  piece is the clock.

So: HTML motion is the spine. Generated video and 3D are **layers** on that spine, never the spine.

## 2. User problem

Builders need launch films, product walkthroughs, animated hero loops, social clips, UI motion
specs and Lottie-like assets. Today they leave the canvas for After Effects, a screen recorder or a
prompt box, and the result no longer follows the design.

## 3. Research matrix

Facts come from a web survey on 2026-11-15. "Unverified" means no primary page was read; confirm
before building on it.

### 3.1 Generative video (bring your own key)

| Tool                            | Best at                                                                          | API with the user's key                              | Verdict                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| OpenRouter video                | One endpoint for Veo 3.1, Gemini Omni, Kling 3.0, Seedance 2.5, Hailuo 3, Runway | Yes (`POST /api/v1/videos`, poll); reported as alpha | **Integrate first**: the account kind already exists in Diazo      |
| Gemini Omni Flash               | First and last frame, up to 15 s and 4K, about $0.07/s at 720p                   | Yes, the existing Gemini key                         | **Integrate second**. Veo preview ids were shut down on 2026-10-22 |
| fal.ai                          | Broadest catalogue; Luma keyframes                                               | Yes, one key                                         | Integrate third, as a new connection kind                          |
| Luma Ray                        | Start, end and up to 16 keyframes                                                | Yes                                                  | Through fal.ai, or direct if keyframes matter                      |
| Kling, Hailuo, Seedance, Runway | Motion realism, cheap clips, multi-shot, video-to-video                          | Yes, each                                            | Reach them through OpenRouter or fal.ai, not one integration each  |
| Higgsfield                      | Camera-move presets, Soul character identity                                     | Pay-as-you-go API; Soul ID endpoint unverified       | Reproduce the presets as prompt templates; do not integrate        |
| OpenAI Sora                     | -                                                                                | Videos API shut down 2026-09-24                      | Ignore. An OpenAI account gives images only                        |
| Pika                            | Playful effects                                                                  | API is another aggregator                            | Ignore                                                             |

### 3.2 AI video editing

| Tool        | Best at                                 | Verdict                                                                      |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| Descript    | Editing video by editing its transcript | Reproduce the idea locally (Whisper word timestamps). Its API is sales-gated |
| CapCut      | Templates, mobile editing               | No official API. Reproduce trim, captions, silence removal                   |
| Captions.ai | Animated captions, AI actors            | Captions are HTML here, so reproduce. Skip the actors                        |
| Opus Clip   | Long video to short clips               | Out of scope                                                                 |

### 3.3 Design tools and motion editors

| Tool                                                                     | Licence                                                                                  | Verdict                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Figma Motion                                                             | Proprietary                                                                              | The benchmark. Match its exports (MP4, WebM, GIF), beat it on Lottie, audio, video and real HTML |
| Figma Weave                                                              | Proprietary                                                                              | Node graph of AI image and video models. Our storyboard covers the same need with fewer concepts |
| HyperFrames                                                              | Apache-2.0 (verified on its README)                                                      | Adopt its contract; export and import its projects (section 9)                                   |
| GSAP                                                                     | Proprietary "no charge"; its terms are reported to bar no-code animation tools (confirm) | **Do not embed.** Our runtime is WAAPI and CSS                                                   |
| Remotion                                                                 | Custom company licence                                                                   | Do not bundle                                                                                    |
| anime.js, Motion Canvas                                                  | MIT                                                                                      | Ideas, and anime.js as an optional adapter                                                       |
| Theatre.js                                                               | Apache-2.0 core, stalled since 2024                                                      | Ignore                                                                                           |
| lottie-web, dotLottie                                                    | MIT                                                                                      | Bundle for Lottie playback and export checks                                                     |
| Rive                                                                     | Runtime MIT, editor proprietary                                                          | Playback only, later                                                                             |
| Mediabunny                                                               | MPL-2.0                                                                                  | Bundle: MP4 and WebM encoding in the browser through WebCodecs                                   |
| ffmpeg                                                                   | LGPL or GPL by build                                                                     | Separate process on the server and the desktop                                                   |
| Blender 5.x                                                              | GPL                                                                                      | **Separate process**, never bundled (section 8)                                                  |
| Blender MCP (official lab server; community `ahujasid/blender-mcp`, MIT) | Official licence unverified                                                              | Talk to it from the desktop shell                                                                |
| OctaneRender                                                             | Proprietary. Prime tier free, 1 GPU, online only; Studio+ about 20 EUR a month           | Optional. Prime is CUDA, so Apple Silicon support is unverified                                  |
| Friction, Natron, Glaxnimate, Synfig, OpenToonz                          | GPL family                                                                               | Ignore for now; import their Lottie or SVG output                                                |
| Jitter, Cavalry                                                          | Proprietary                                                                              | Ignore                                                                                           |

Ideas taken from each tool, whatever the verdict (licences in this list are from memory, not
re-read in the second pass):

- **HyperFrames**: the seek-safe contract, one paused timeline, tracks, sub-compositions,
  variables, the registry, safe zones.
- **Figma Motion**: the timeline lives under the canvas, not in another app; keyframes on the
  properties the Design panel already shows.
- **After Effects and its open alternatives** (Friction and Glaxnimate for vectors, Synfig, Natron
  and Blender's compositor for nodes, Blender's sequencer for cutting): property rows with
  diamonds under a layer, a graph editor for easing, trim paths, masks, a text animator with a
  range and a stagger, track-level audio. Not taken: node graphs, expressions, effect racks.
- **Motion Canvas, Remotion, Theatre.js**: animation as code that a clock drives. Ours is CSS and
  WAAPI in the frame, so the "code" is the deliverable. Not taken: a JS scene language, React.
- **Higgsfield**: named camera moves as one-click presets. Not taken: its hosted models, Soul
  character identity.
- **Runway, Kling, Veo, Seedance, Hailuo, Luma**: first and last frame, reference images,
  camera vocabulary in the prompt. They are layers, reached through OpenRouter and Gemini.
- **Descript, CapCut, Captions.ai**: cut by transcript, filler and silence removal, caption
  styles, beat snapping.

## 4. Concepts, in Diazo terms

- **Scene**: a page with a timeline. It has a length, a frame rate and an output size.
- **Shot**: a time range of the scene that looks at one frame, one clip or one 3D layer.
- **Camera**: a 16:9 (or 9:16, 1:1) rectangle that moves across the page. Its position and zoom are
  keyframed. This is how "frames on a page" become a film without copying them.
- **Layer keyframes**: any element picked on the canvas can carry keyframes on opacity, transform,
  filter, clip-path and colours. They are stored as data and compiled to WAAPI.
- **Clip**: a reusable timed block. Motion items from the design library insert as clips.
- **Media layer**: a video, an image or an audio file with trim points.
- **3D layer**: a three.js scene in a frame, driven by the same clock.
- **Captions**: one track of word-timed HTML text.
- **Tokens**: durations and easings are the canvas motion tokens (`--dur-*`, `--ease-*`,
  `--spring-*`). A token change retimes every clip that names it.

## 5. The flow

1. **Storyboard.** Lay shots on a page: frames made by hand, pasted screenshots, dropped clips,
   generated images. Each shot has a note ("push in, cursor types the name") and a length. An
   animatic plays them as stills.
2. **Diazo Agent animates it.** The agent reads the order, the notes, the tokens and the pixels of pasted
   screenshots (vision). It proposes a plan, then writes scenes, camera moves and captions onto the
   timeline while the person watches and scrubs.
3. **Timeline editor.** A floating panel under the stage: scenes, camera, overlays, captions,
   audio. Scrubbing moves the camera on the stage. The inspector's Motion tab edits keyframes and
   the easing curve of the selected segment.
4. **3D.** A Blender scene arrives as a three.js layer through the Blender link.
5. **Generate.** Images and video run on the user's own accounts and land as media layers.
6. **Edit video.** Trim, split, cut by transcript, captions, audio ducking.
7. **Render.** Local, Blender for 3D shots, or the server.

## 6. Decisions on Bryan's ideas

| Idea                                                                                | Decision                         | Reason                                                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Storyboard from hand-made frames or pasted screenshots, then AI animates it as HTML | **Keep, as the core flow**       | It fits what agents already do well here, and the result stays editable                                                              |
| Rebuild a pasted screenshot as HTML                                                 | **Keep, with a rule**            | Interface screenshots are rebuilt as frames; photos stay pictures with camera moves. The plan says which, before anything is written |
| Seek-safe timeline like HyperFrames                                                 | **Keep**                         | It is what makes scrubbing, multiplayer and rendering agree                                                                          |
| Blender, three.js                                                                   | **Keep, as a later phase**       | Real value for hero objects, but only on the desktop and only for some users                                                         |
| Octane                                                                              | **Keep as an option only**       | Proprietary, GPU-bound, needs an OTOY account. Cycles and Eevee are the default                                                      |
| "Other free tools" (Natron, Friction, Synfig...)                                    | **Drop as integrations**         | Each is a second editor with its own project format. Import their Lottie and SVG output instead                                      |
| Images through the user's OpenAI or Gemini account                                  | **Keep, reuse `generate_image`** | Already built (GPT Image, Nano Banana, Seedream)                                                                                     |
| Video generation through the user's accounts                                        | **Change**                       | Not through OpenAI: Sora's API is gone. Use OpenRouter and Gemini first, fal.ai next                                                 |
| Direct video editing                                                                | **Keep, narrow**                 | Trim, split, transcript cuts, captions, audio levels. No colour grading, no multicam, no effects rack: that is a different product   |

## 7. Architecture

### 7.1 Runtime

- One runtime module, `shared/motionRuntime.ts`, inlined in the frame runtime and in the renderer.
- It owns a clock `t`. `seek(t)` sets `currentTime` on every WAAPI animation, shows or hides timed
  elements, seeks media elements and dispatches a `doop:seek` event for script layers (three.js,
  canvas).
- Playback is a `requestAnimationFrame` loop that calls `seek`. Wall-clock time only advances the
  playhead; it never decides a pixel.
- No GSAP. WAAPI and CSS animations are the default; a script layer may bring its own library if it
  listens to `doop:seek`.
- Reduced motion: nothing autoplays; the scene rests on its poster time.
- Time is also exposed as the inherited custom property `--t` on the scene root, so CSS-only
  clips seek with no script and a subtree can be pinned to its own time (section 14.1).

### 7.2 Markup contract

Compatible with HyperFrames where it costs nothing:

- `data-doop-scene` on the page's scene root with `data-duration`, `data-fps`, `data-width`,
  `data-height`.
- Timed elements carry `data-start` and `data-duration` (seconds), shown over `[start, end)`.
- `data-doop-track` and `data-doop-track-kind` (`graphics`, `captions`, `video`, `audio`, `3d`) lay
  out the timeline rows. They never change paint order.
- Keyframes are stored in a `<script type="application/json" data-doop-motion>` block per frame:
  element id (`data-doop-id`), property, time, value, easing or token name.
- Lint rules (new `MO-*` ids beside the anti-slop rules): no `Date.now`, no unseeded
  `Math.random`, no timers, no infinite animation without a scene length, no network at seek time.

### 7.3 Data model

- `scenes` (one per page that has a timeline): id, canvas id, page id, duration, fps, size, camera
  keyframes (jsonb), audio mix (jsonb), updated at.
- `scene_media`: asset id, kind, trim in and out, cuts (jsonb), transcript (jsonb, word timings).
- `renders`: id, scene id, format, target (`local`, `blender`, `server`), state, progress, output
  asset, started by, cost.
- Keyframes live in frame HTML, so versions, copy and paste and MCP edits carry them for free.

### 7.4 API and MCP tools

- REST: `GET/PUT /api/canvases/:id/pages/:pageId/scene`, `POST /api/scenes/:id/renders`,
  `GET /api/renders/:id`.
- Room messages: `scene:updated`, `scene:playhead` (follow mode only), `render:progress`.
- MCP and resident agent, same names: `get_scene`, `set_scene`, `set_camera_keyframes`,
  `set_keyframes`, `insert_clip` (a library Motion item at a time), `add_media_layer`,
  `set_captions`, `get_scene_snapshot` (PNG at given times, how an agent sees motion),
  `check_scene` (the `MO-*` lint plus contrast and safe zones at sampled times), `render_scene`.
- Generation: `generate_video` beside `generate_image`, same account routing and metering.
- Duel: a motion duel gives the same storyboard to two or three models and compares the films side
  by side, scrubbed by one shared playhead.

### 7.5 Rendering

| Target                            | How                                                                             | Limits                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Browser (default for short films) | Seek, capture each frame, encode with Mediabunny (WebCodecs)                    | Follows the existing image-export limits; falls back to the desktop or the server           |
| Desktop shell                     | Local Chromium page seeked frame by frame, ffmpeg from the login shell's `PATH` | Unmetered; needs ffmpeg installed                                                           |
| Server                            | The existing renderer gate at background priority, ffmpeg in the image          | Capped: 60 s, 1080p, 30 fps, one render per account at a time; `RendererBusyError` as today |
| Blender                           | 3D shots only, frames laid under the HTML layers                                | Desktop only                                                                                |

Other outputs: GIF (palette through ffmpeg), Lottie and dotLottie (vector layers with transform and
opacity keyframes only; the dialog lists what cannot export), CSS and WAAPI code (one file per
frame, token names kept), a HyperFrames project zip.

### 7.6 Video editing

- Decode and scrub with `<video>` in the frame; exact frames at render through WebCodecs.
- Cuts are data (ranges), never a re-encode until render.
- Transcription runs on a speech engine the person installs in one click, on their Mac (desktop
  app) or on the Diazo server, with the model they pick (section 18). Fillers and silences (ffmpeg
  `silencedetect` or the word gaps) become suggested cuts.
- Captions are an HTML track styled by tokens, kept inside the title-safe box.
- Audio: per-layer gain, ducking under voice, fades. Mixed by ffmpeg at render; previewed with Web
  Audio.

### 7.7 Collaboration

- The scene is canvas state: edits broadcast like frame edits, one undo step per gesture.
- Each person has their own playhead. "Follow" shares one.
- Comments anchor to a time range on a scene, shown on the ruler.
- Frame versions keep keyframes. A scene keeps its last 20 states.

## 8. Blender, three.js, Octane

- **Licences.** Blender is GPL: Diazo never bundles it or its code. The desktop shell talks to a
  running Blender as a separate process. A Diazo add-on, if one is needed, lives in its own GPL
  repository. three.js is MIT. Octane is proprietary and optional.
- **Bridge.** In the desktop shell, like the Claude and ACP runners: find Blender, start or attach
  to its MCP server on loopback, a native approval per kind of action (read scene, export, set
  material, render). Running arbitrary Python and saving over the `.blend` always ask.
- **In.** Export the picked scene or collection as glTF, upload it as an `/a/` asset, write a
  three.js layer in the frame: camera, lights, PBR materials. Only recognised material nodes
  survive; procedural graphs must be baked; volumes and hair do not export. The panel lists what
  was dropped.
- **Live link.** A save or a depsgraph change in Blender re-exports after a short debounce and
  updates the frame as an annotation write.
- **Out.** A frame's three.js scene is exported as glTF and opened in Blender.
- **Keyframes.** Blender actions become timeline keyframes; camera and object moves are editable on
  the timeline and can be scroll-driven in a hero.
- **Final frames.** three.js is the real-time preview. For export, a 3D shot can be rendered by
  Eevee, Cycles or Octane with the same camera and timing, then composited under the HTML layers.
- **Agents.** Tools `blender_get_scene`, `blender_set_material`, `blender_add_light`,
  `blender_render_frame`, proxied through the shell with the same approvals.
- **Performance.** One live WebGL context per visible frame. A culled or off-screen 3D frame shows
  its last rendered image. The library's 3D items follow the same rule.

## 9. How HyperFrames is used

- **Licence:** Apache-2.0, compatible with Diazo's AGPL-3.0 for inclusion.
- **Adopt the contract**, not the code: timing attributes, the half-open visibility window, the
  determinism rules, one caption track, one kind per track, safe zones (90% action, 80% title).
- **Do not embed its runtime**: its default adapter is GSAP, whose licence is a risk for an
  animation editor. Our runtime is small and WAAPI only.
- **Export** a scene as a HyperFrames project (root `index.html`, one sub-composition per shot,
  `assets/`), so it opens in HyperFrames Studio and renders with its CLI or cloud.
- **Import** a HyperFrames project as a page: each sub-composition becomes a frame. GSAP timelines
  come in as script layers that listen to the seek event.
- Its registry (about 450 blocks) is a second source of clips later, each checked for licence.

## 10. Phases

| Phase   | Scope                                                                                                                                                                                                                                                  | Done when                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 0       | Runtime with `--t`, markup contract, `MO-*` lint, `get_scene_snapshot`, `check_scene`                                                                                                                                                                  | An agent-written frame scrubs and snapshots at any time   |
| 1 (MVP) | "Add timeline" on a page, storyboard shots, camera across frames (push, pull, pan), timeline panel (scenes, camera, captions), Diazo Agent animates a storyboard or one ask, MP4 and WebM from the browser and the desktop                             | A 15 s film from three frames, with no tool outside Diazo |
| 2       | Layer keyframes and the easing inspector, camera presets, transitions, text animator, masks and trim paths, library Motion items as clips with seek-safe status, playheads, time-range comments, scene versions, GIF, PNG sequence, CSS and WAAPI code | A motion spec a developer can paste                       |
| 3       | Media layers: video and audio, trim, split, speed, transcript cuts, captions and styles, beats, ducking; `generate_video` on OpenRouter and Gemini with kept prompts; motion paths and morph                                                           | A narrated walkthrough cut inside Diazo                   |
| 4       | Blender link, three.js layers, 3D in ordinary frames (time, scroll, pointer), Cycles and Eevee shots, Octane as an engine name                                                                                                                         | A 3D hero that is also a shot in the film                 |
| 5       | Server renders, Lottie import and export, HyperFrames import, export and registry, motion duel                                                                                                                                                         | -                                                         |

## 11. Risks

- **Determinism leaks.** Library Motion items use timers, hover and scroll. Many will need a
  seek-safe rewrite before they are clips; the lint must say why an item is refused.
- **Screenshot to HTML fidelity.** A rebuilt screen that is 90% right looks wrong in a film. The
  plan step must let the person keep the picture instead.
- **Render cost on the server.** A 15 s film is 450 page seeks. It needs its own queue and caps so
  thumbnails and agent screenshots never starve.
- **Scope creep into a video editor.** The narrow list in section 6 is the guard.
- **Provider churn.** Two video APIs shut down in the two months before this survey. Keep one
  thin adapter per account kind and no model id in the UI that the provider does not list.
- **Blender bridge security.** Its MCP server runs unsandboxed Python. Loopback only, native
  approval, an allowlist of tools, never a path chosen by the page.
- **WebGL in the server renderer** is software-rendered and slow; 3D shots render locally.

## 12. Decisions (Bryan, 2026-11-15)

- **Storyboard (Q1):** an ordinary page that gains a timeline, not a new page type.
- **MVP export (Q2):** MP4/WebM rendered in the browser and on the desktop is enough for the MVP;
  server renders stay in phase 5.
- **Blender (Q6):** Blender is reached as an MCP server **through the desktop app**: the shell
  spawns and talks to the Blender MCP locally (user-approved, allowlisted, like the Claude and ACP
  agents), and Diazo's agents and editor use it through the app. Which Blender MCP server (official
  or the MIT community one) is decided at build time after a licence check; Mac first.

- **Voice and transcription (2026-11-16):** transcription and voice-over both install in one click,
  on the person's Mac through the desktop app or on the Diazo server, their choice, with the model
  of their choice. Voice-over also runs on ElevenLabs with the person's own API key. Design in
  section 18, decision in [ADR 0014](../../../docs/adr/0014-run-speech-engines-on-the-desktop-or-the-server.md).

- **Second pass (same day):** sections 14 to 17 extend the design to every request; section 15
  lists what was rejected and why. Bryan gave carte blanche on those calls; they stand until he
  reverses one.

## 13. Open questions

1. Should Diazo Agent rebuild pasted screenshots as HTML by default, or ask per shot? Recommended:
   ask in the plan, default to rebuild for interface screenshots.
2. Video generation: OpenRouter first, then Gemini. Add fal.ai as a new connection kind in phase 3
   or wait for demand?
3. ~~Local Whisper or the model account?~~ Decided 2026-11-16: a one-click local engine, on the
   desktop or the server (section 18).
4. Which Blender MCP server: the official one (licence to verify) or the community one (MIT)?
5. Lottie: is the vector subset (14.7) useful enough to build, or should it wait for demand?
6. Should the HyperFrames registry be a clip source, given per-block licence checks?
7. Confirm two licence points before building: GSAP's clause on animation tools, and the official
   Blender MCP server's licence.
8. Seek-safe rewrite of the library's Motion items (14.12): agent-rewritten variants on demand, or
   one curated pass over the most used 100 first? Recommended: on demand, plus the top 100.
9. ~~Voiceover in phase 3?~~ Decided 2026-11-16: in, on ElevenLabs (own key) or a local engine
   (section 18). Its own questions are in 18.16.
10. Shared components still wear the Doop brand (`ShellTitle` mark, `Avatar kind=agent`, "Doop"
    labels in `StageBoard`). Motion screens use `DiazoMark` and `DiazoAgentMark`; the shared ones
    need one brand pass.

## 14. Feature designs (second pass)

Each block says what the person sees, how it is stored, how it compiles and which phase builds
it. "Compiles to" always means plain CSS and WAAPI in the frame, seek-safe under section 7.

### 14.1 Time is an inherited custom property

- The scene root sets `--t` (seconds). A timed CSS animation is written paused, with
  `animation-delay: calc(var(--t) * -1s)`. Setting `--t` seeks every pixel below it.
- The runtime (7.1) still drives WAAPI `currentTime` for keyframes stored as data. The `--t` form
  is what clips and agent-written CSS use, because it needs no script to rest on a time.
- A subtree may pin its own `--t`. That gives shot thumbnails, the storyboard animatic, the
  agent's contact sheet and the duel's three takes with no extra render.
- With no script the scene rests on its poster time. That is the reduced-motion state too.
- The page's mock screens run on exactly this (component `FilmComp`), so it is verified in
  Chromium, including the server renderer.

### 14.2 Keyframes and the easing inspector

- **Where:** Inspector, Motion tab (beside Design and Prototype), tool row Keyframes · Camera ·
  Text · Shape · Clips. Timeline: a layer row opens into one row per animated property.
- **Property row** (component `KeyframeField`): label, scrubbable value, a diamond. Empty: no
  keyframes. Hollow blue: animated, playhead between two. Filled: a keyframe at the playhead.
  `K` adds one. Animatable: opacity, translate, scale, rotate, filter (blur, brightness,
  saturate), clip-path, colours, `d`, stroke-dashoffset, offset-distance, CSS custom properties
  registered with `@property`.
- **Curve editor:** the segment between two keyframes is one cubic Bézier with two handles, or a
  spring (stiffness, damping, mass) compiled to `linear()`, or steps, or hold. Presets are the
  canvas motion tokens. A segment that names a token retimes when the token changes.
- **Timing:** duration, delay and stagger are numbers or duration tokens.
- **Stored** as `{ el, prop, t, value, ease }` in the frame's `data-doop-motion` block (7.2).
- **Not built:** a value graph over many keyframes (speed graph), expressions, roving keyframes.
  The dope sheet plus one curve per segment covers what builders do.
- "Copy as CSS" gives the selected layer's `@keyframes` with token names kept. Phase 2.

### 14.3 Camera

- **Model:** a rectangle in page coordinates: `x`, `y`, `zoom`, `rotation`, aspect (16:9, 9:16,
  1:1). The output is what the rectangle sees. On the page it is a blue outline with a "Camera"
  tab that moves while the film plays; the output monitor shows the result.
- **Shot = "look at this frame":** dropping a frame on the Scenes row adds a shot and two camera
  keyframes that fit the frame. People rarely type coordinates.
- **Presets** (the Higgsfield idea, done with keyframes): Push in, Pull out, Pan, Whip pan (with
  motion blur by `filter: blur` on the middle third), Crash zoom, Crane, Handheld (seeded noise,
  amplitude and frequency fields), Dolly zoom and Orbit (3D layers only). A preset is a recipe
  relative to the shot's frame, so it survives a resize. Every value stays editable after.
- **On a generated video layer** the same preset names are sent as a prompt template in the
  model's own camera vocabulary. Same picker, different back end. The UI says which one applies.
- **Compiles to** one transform on the page's world wrapper. Phase 1 (push, pull, pan), phase 2
  (the rest).

### 14.4 Transitions

- Between two adjacent shots: Cut, Dissolve, Push, Wipe (clip-path), Zoom through, Shared element.
- A transition is the overlap of two visibility windows plus one paired animation. Its duration
  names a token (`--dur-slower` by default).
- **Shared element** matches elements with the same component instance or `data-doop-id` across
  the two frames and interpolates their boxes (FLIP computed when the scene compiles, not at
  seek time).
- Phase 2. No 3D page flips, no shader transitions in the first version: the HyperFrames registry
  covers those as clips (14.12).

### 14.5 Text animator

- Split by line, word or character. The split is derived when the scene compiles
  (`data-doop-split="word"` on the element); the frame's text stays one editable string.
- Presets: Rise and blur, Typewriter (`steps()`), Scale pop, Mask wipe, Tracking in, Scramble
  (seeded). Fields: stagger, order (from start, from centre, seeded random), per-unit easing.
- Compiles to one animation per unit with a delay of `index × stagger`. Phase 2.

### 14.6 Masks, shapes and paths

- **Mask:** `clip-path` (inset, circle, ellipse, polygon, `path()`), keyframed; feather through
  `mask-image` gradients. Invert through `xor` compositing. Track mattes (one layer masks
  another) only through an SVG `<mask>`, so only for SVG layers.
- **Trim path:** `pathLength="1"` plus `stroke-dashoffset` and `stroke-dasharray` keyframes, on any
  path the path editor reads.
- **Motion path:** `offset-path` taken from a path layer, `offset-distance` keyframed, with
  auto-orient.
- **Morph:** `d: path()` interpolation when both shapes have the same commands; otherwise the
  compiler resamples both to the same point count and says so.
- Phase 2 (mask, trim), phase 3 (motion path, morph).

### 14.7 Lottie

- **Import:** a `.json` or `.lottie` lands as a player layer (lottie-web, seeked by frame through
  the `doop:seek` event). Simple files (shapes, transform, opacity, trim) can be converted to
  editable SVG layers with keyframes; the import says what would be lost (expressions, effects,
  mattes).
- **Export:** vector layers with transform, opacity, trim path and colour keyframes. The dialog
  lists every layer that stays out (HTML text with web fonts, video, 3D, filters).
- Honest limit: Lottie is a vector format and a Diazo scene is HTML. Lottie export is for icons
  and small loops, not for a whole film. Phase 5.

### 14.8 Audio and beats

- Tracks: music, voice, effects. Per track: gain, fade in, fade out, mute. Waveforms drawn from a
  peaks file made once per asset.
- **Beat markers:** onset detection runs once per file (a worker in the browser, ffmpeg in the
  desktop shell) and stores marker times and a BPM guess in `scene_media`. "Snap to beats" makes
  cuts, keyframes and captions snap to them.
- **Ducking:** voice ranges generate gain keyframes on the music track (depth, attack, release).
  They stay editable.
- Preview through Web Audio, synced to the clock; mixed by ffmpeg at export (7.6).
- Not built: an equaliser, effects, AI music. Phase 3.

### 14.9 Captions

- One caption track of word-timed HTML. Sources: typed, the transcript of a video or voice layer,
  or the agent's script.
- Styles are presets over tokens: Plain bar, Word highlight (the current word takes the signal
  colour), Kinetic (word by word through the text animator), Lower third.
- Kept inside the title-safe box (80%); `check_scene` fails a caption that leaves it or drops
  under AA contrast against the sampled frame.
- Languages: the user's model translates the track; each language is a variant of the track.
  Export burns captions in, or writes `.srt` and `.vtt` beside the video. Phase 3.

### 14.10 Video layers and transcript editing

- A video is a layer with trim in, trim out, speed (0.25× to 4×, one value per segment) and
  split at the playhead (`S`). No speed ramps, no reverse in the first version.
- **Transcript editing** (the Descript idea): the transcript is the edit surface. Deleting words
  creates cut ranges; fillers and silences over a threshold are offered as one-click cuts.
  Cuts are data; nothing is re-encoded before export.
- Transcription: the speech engine the person installed, on the desktop or the server (section 18;
  open question 3 is decided there).
- Not built: colour grading, multicam, stabilisation, background removal on video, AI avatars,
  lip sync. Phase 3.

### 14.11 Generated layers

- **Images** reuse `generate_image` as frames do: the image model the person picked (GPT Image on
  a ChatGPT or OpenAI account, which is what Codex signs in with; Nano Banana on Gemini;
  Seedream), on their own account.
- **Video** adds `generate_video`: OpenRouter first, Gemini second (3.1). No OpenAI video: the
  Sora API is gone, and the picker says so instead of hiding it.
- Inputs: prompt, model, length, aspect, first frame and last frame picked from shots (rendered
  by `get_scene_snapshot`), reference images where the model takes them, a camera preset (14.3).
- **The layer keeps its recipe:** `scene_media.generation = { provider, model, prompt, seed,
refs, camera, cost }`. Regenerate and Vary start from it; a copied layer copies it.
- Before a run the panel shows the estimate on the user's account and the wait. Runs are polled
  jobs with the layer shown as a placeholder clip.
- Rule the agent follows: product UI, text and logos are HTML, never generated video. Generated
  video is B-roll.
- **Character consistency** (Higgsfield Soul): not a feature. Models that accept reference
  images get them; nothing is trained. Phase 3.
- **Voice-over** is one more generated layer that keeps its recipe (text, provider, model, voice,
  style), from ElevenLabs on the person's own key or a local engine (section 18; open question 9
  is decided there).

### 14.12 Clips: library Motion items and HyperFrames blocks

- The Clips tool is a browser with three sources: Library · Motion (the design library's Motion
  category, 959 families), HyperFrames registry, This canvas.
- **Seek-safe status per item.** The `MO-*` lint runs on every Motion item once and stores the
  result: Seek-safe, or "Needs rewrite" with the reason (timer, hover, scroll listener, wall
  clock). Only seek-safe items insert at the playhead as clips.
- **Rewrite:** "Make seek-safe" asks the agent to rewrite the item against the contract (timers
  to delays, hover to a timed state, `Math.random` to a seeded one) and files the result as a
  variant of the item. This is how the library converts over time instead of in one migration.
- `insert_clip` = `insert_library_item` plus a start time and a length. Durations and easings in
  a clip name tokens.
- **HyperFrames registry:** each block is checked for licence before it is listed. GSAP-based
  blocks come in as script layers that listen to `doop:seek`, and are marked so. Phase 2
  (library), phase 5 (registry).

### 14.13 3D layers

- A 3D layer is a three.js scene in a frame, loaded from a glTF asset, driven by the same clock:
  the layer's script listens to `doop:seek` and sets camera, object transforms and
  `AnimationMixer.setTime(t)`. Nothing reads the wall clock.
- **Keyframes** on the timeline: object position, rotation, scale; camera orbit, dolly, FOV;
  light intensity; material parameters that glTF carries (base colour, roughness, metalness,
  emissive). Blender actions arrive as mixer clips and can be baked to timeline keyframes.
- **No 3D editor in the browser.** Modelling, rigging and shading happen in Blender. Diazo moves,
  lights and times what arrives.
- One live WebGL context per visible frame; a culled or reduced-motion frame shows its fallback
  image (the last rendered one). Phase 4.

### 14.14 3D in ordinary frames (not only in films)

- Any frame can hold a 3D scene: the Design tab gets a "3D scene" section when a frame contains
  one.
- **Driven by:** Time (a loop or a film shot), Scroll (keyframes sit on 0 to 100% of the frame's
  scroll range), Pointer (two axes mapped to rotation, damped by a fixed-step filter so it stays
  deterministic in tests).
- Scroll-driven DOM uses CSS scroll timelines; the 3D scene gets the same progress through
  `doop:seek`. A scroll-driven hero is therefore the same data as a film shot with another
  driver, and a hero can be dropped into a film as a shot.
- It ships as frame HTML, so frame-to-code export carries it: the glTF asset, the three.js
  module and the small driver.
- Required per scene: a fallback image, used under reduced motion, when culled, in thumbnails
  and by the server renderer. Phase 4.

### 14.15 The Blender link, as a flow

1. **Connect** (desktop app only): the shell finds Blender, starts or attaches to its MCP server
   on loopback, and shows a native approval per kind of action: read the scene, export glTF, set
   materials and lights, render frames. Running Python and saving over the `.blend` ask every
   time.
2. **Pick** a scene or collection. The dialog shows triangles, materials, cameras, frame range
   and what will not cross (procedural materials need baking; volumes and hair do not export).
3. **Live preview:** the export lands as a three.js layer. A save or a depsgraph change in
   Blender re-exports after a debounce; the layer shows "synced 2 s ago".
4. **Back to Blender:** "Edit in Blender" focuses the object; "Send this scene to Blender"
   exports a frame's three.js scene as glTF and opens it.
5. **Final frames:** Eevee (fast), Cycles (default), or Octane. Octane is not an integration:
   it is the engine name passed to Blender when the user has OTOY's Blender plug-in and
   account. The render uses the timeline's camera and timing and lands as an image sequence
   under the HTML layers.
6. **Agents** use the same link with the same approvals: `blender_get_scene`,
   `blender_set_material`, `blender_add_light`, `blender_render_frame`.

In a browser without the desktop app, the link is replaced by "Import glTF…": the same layer,
no live link, no Blender render. Phase 4.

### 14.16 Agent flows

- **Storyboard to film:** the agent reads shot order, notes, tokens and the pixels of pasted
  screenshots, then posts a plan card: per shot, "as is", "rebuild as HTML" or "keep the
  picture", the move, the caption; totals and the estimate on the user's account. Nothing is
  written before Go.
- **One ask:** "Make a 15 s launch film from this page" with the `/motion` canvas skill. The
  agent writes the storyboard itself (beats, captions, music from the user's files), shows it as
  a brief, then runs the same plan.
- **How the agent sees motion:** `get_scene_snapshot` returns a contact sheet at chosen times.
  `check_scene` runs the `MO-*` lint, contrast at sampled times and safe zones. A run does not
  finish with lint errors.
- **Streaming:** the composition appears on the timeline as the agent writes it: orange clips, the
  orange border beam on the monitor, the status line in human words.
- **Motion duel:** one storyboard, two or three models, the takes side by side on one shared
  playhead, each with cost, time and lint result. "Keep this one" makes that take the scene; the
  others stay as scene versions. Phase 1 (storyboard, one ask), phase 5 (duel).

### 14.17 Multiplayer, comments, versions

- Each person has a playhead; other people's show as thin flagged lines in their colour, agents
  in orange. "Follow" locks yours to someone else's.
- A comment can anchor to a time range on a scene (`sceneId`, `from`, `to`); it shows on the
  ruler and in the thread list, and an `@diazo` mention there queues work that carries the range.
- A scene keeps its last 20 states with author and summary; frame versions keep keyframes.
  Restoring a scene state is one undo step. Phase 2.

### 14.18 Export dialog

- **Formats:** MP4 (H.264), WebM (VP9, with alpha), GIF, PNG sequence, Lottie (14.7), CSS and
  WAAPI code, HyperFrames project.
- **Size and rate:** 720p, 1080p, 4K or custom; 16:9, 9:16, 1:1; 24, 30, 60 fps; whole film or a
  range.
- **Where it renders:** This browser (WebCodecs, default for short films), Desktop app (local
  Chromium and the user's ffmpeg, no limits), Blender (3D shots only), Server (phase 5, shown
  disabled with its caps until then).
- **Progress:** a frame counter, per-shot state, the Blender shot with its sample count, cancel.
  The result is a file card with reveal and copy link; code and HyperFrames exports open in a
  code view and a project tree.
- A film whose 3D shots have no Blender render exports them from three.js, and says so.

### 14.19 Performance and reduced motion

- Preview: one `requestAnimationFrame` loop per scene; only visible frames compute; media
  elements seek only when their time moved by more than a frame.
- One live WebGL context per visible frame; the rest show their fallback image.
- Export is frame-exact and never real time: seek, wait for fonts, images and video frames,
  capture.
- Browser export follows the image export limits (16,384 px a side, 64 MP per frame).
- Reduced motion: nothing autoplays, scenes rest on their poster time, UI transforms become
  120 ms fades, the agent's beam and shimmer freeze. Export is unaffected. Scrubbing still works:
  it is the person moving time, not an animation.

## 15. Rejected, and why

| Request or temptation                               | Decision                    | Why                                                                                                          |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Octane as its own integration                       | Engine option only          | It is a Blender render engine. Passing its name costs nothing; anything more is OTOY's licence and one GPU   |
| Natron, Friction, Synfig, Glaxnimate as connections | Import their output         | Each is a second editor and a second project format. Lottie, SVG, PNG sequences and video with alpha come in |
| A node compositor (Natron, Blender nodes, Weave)    | No                          | Layers, CSS filters and blend modes cover product films. Nodes are a second mental model for a rare need     |
| A 3D editor in the browser                          | No                          | Blender is the editor. Diazo moves, lights and times what arrives                                            |
| Character consistency (Higgsfield Soul)             | Reference images only       | Identity training is a hosted product. The use case here is product films, not actors                        |
| AI avatars, lip sync, AI actors                     | No                          | Another product, and a trust problem                                                                         |
| Full video editor (grading, multicam, effects rack) | No                          | The narrow list in 14.10 is the guard                                                                        |
| GSAP as the runtime                                 | No                          | Licence risk for an animation editor (confirm, question 7). WAAPI and CSS need no library                    |
| Generated video as the spine of a film              | Layers only                 | Nobody can edit generated pixels, and product UI must stay the real UI                                       |
| A timeline on every page                            | Opt-in per page             | Most pages are screens, not films. "Add timeline" turns a page into a scene                                  |
| One shared playhead for everyone                    | Own playhead, Follow opt-in | Two people scrubbing one clock fight each other                                                              |
| Speed graphs, expressions, roving keyframes         | Not in the first versions   | The dope sheet and one curve per segment cover builders' needs. Revisit on demand                            |
| Lottie export of a whole film                       | Vector subset               | HTML text, video, 3D and filters have no Lottie form                                                         |
| AI music in the app                                 | The user's files            | No provider with a stable bring-your-own-key API was verified                                                |
| Server renders in the MVP                           | Phase 5                     | Decided (section 12)                                                                                         |

## 16. Screens

Canvas `bIK8evKpnI`, page "18 Motion Studio". Every editor screen plays the same 15 s sample
film (component `FilmComp`) and scrubs.

| Frame | Shows                                                              | Section    |
| ----- | ------------------------------------------------------------------ | ---------- |
| 01    | Storyboard: hand-made frames, pasted screenshots, shot notes       | 5, 14.16   |
| 02    | Diazo Agent's plan: rebuild or keep, shot by shot                  | 14.16      |
| 03    | The composition streams onto the timeline                          | 14.16      |
| 04    | Timeline editor: keyframes, easing curve, tokens                   | 14.2       |
| 05    | Camera across the page's frames, presets                           | 14.3       |
| 06    | Text animator and transitions                                      | 14.4, 14.5 |
| 07    | Masks, shapes, paths, Lottie import                                | 14.6, 14.7 |
| 08    | Clips: real library Motion items, HyperFrames registry             | 14.12      |
| 09    | Generate: image and video layers on the user's accounts            | 14.11      |
| 10    | Edit video by transcript: trim, split, speed                       | 14.10      |
| 11    | Audio and captions: beats, ducking, caption styles                 | 14.8, 14.9 |
| 12    | Multiplayer: playheads, time-range comments, versions              | 14.17      |
| 13    | Blender link: connect, approve, pick a scene                       | 14.15      |
| 14    | 3D layer: live three.js, camera and object keyframes               | 14.13      |
| 15    | 3D in an ordinary frame: scroll-driven hero, round trip to Blender | 14.14      |
| 16    | Final frames: Eevee, Cycles, Octane through the desktop app        | 14.15      |
| 17    | Agent film from one ask, contact sheet, `check_scene`              | 14.16      |
| 18    | Motion duel: three takes, one playhead                             | 14.16      |
| 19    | Export dialog                                                      | 14.18      |
| 20    | Rendering, done, code and HyperFrames project                      | 14.18      |
| 21    | Reduced motion and performance rules                               | 14.19      |

Prototype flows: storyboard by hand (01 → 04); screenshots to film (01 → 02 → 03 → 04); timeline
tools (04 ↔ 05, 06, 07, 08, 12); media (09 → 10 → 11 → 04); 3D (13 → 14 → 15, 14 → 16 → 19);
agent (17 → 03, 17 → 18 → 04); export (19 → 20 → 04, 19 ↔ 21).

Components added to the design system for these screens: `MotionTimeline`, `KeyframeField`,
`FilmComp`, `DiazoMark`, `DiazoAgentMark`.

## 17. Gap analysis of the first pass

The first pass had 7 screens and sections 1 to 13. What was missing or thin, and where it is now:

| Gap                                                                              | Closed in        |
| -------------------------------------------------------------------------------- | ---------------- |
| Keyframe inspector existed for the camera only; no per-property rows, no springs | 14.2, frame 04   |
| Camera had no presets; Higgsfield's idea was a table verdict only                | 14.3, frame 05   |
| No transitions, no text animator                                                 | 14.4, 14.5, 06   |
| No masks, trim paths, motion paths, morph                                        | 14.6, frame 07   |
| Lottie was one line under exports; no import                                     | 14.7, frame 07   |
| Library clips were named in a row label; none inserted, no seek-safe status      | 14.12, frame 08  |
| HyperFrames registry was a "later" bullet                                        | 14.12, frame 08  |
| Audio had ducking only; no beat markers, no waveform design                      | 14.8, frame 11   |
| Captions had no styles, languages or sidecar export                              | 14.9, frame 11   |
| Video editing was one screen for everything; transcript editing was a sentence   | 14.10, frame 10  |
| Generated layers did not keep their prompt; first and last frame were not wired  | 14.11, frame 09  |
| 3D existed only as a film layer; nothing for ordinary frames or scroll           | 14.14, frame 15  |
| The Blender link was a status panel, not a flow with approvals                   | 14.15, 13 and 16 |
| The one-ask agent film, the contact sheet and `check_scene` had no screen        | 14.16, frame 17  |
| The motion duel was one sentence                                                 | 14.16, frame 18  |
| Multiplayer was three bullets; no playheads, no versions screen                  | 14.17, frame 12  |
| Export was one panel; no code or HyperFrames result, no per-shot progress        | 14.18, 19 and 20 |
| Reduced motion and performance had no rules page                                 | 14.19, frame 21  |
| The prototype was wired but never checked; the brand was still Doop              | Section 16       |
| No stated rejections beyond a short table                                        | Section 15       |

## 18. Voice and transcription

Research dated 2026-11-16 (sources in 18.17). Decisions by Bryan the same day: transcription and
voice-over install in **one click**, on the person's Mac (desktop app) or on the Diazo server,
**their choice**, with the **model of their choice**; voice-over also runs on **ElevenLabs** with
their own key. Second round, the same day: the Mac offers all three studio voices, every target
also takes a model the person (or, on the server, an instance admin) adds, cloud transcription
(ElevenLabs Scribe, OpenAI) and speaker labels are in v1, only instance admins install on the
server, and we mirror Pocket TTS's weights ourselves. Recorded in
[ADR 0014](../../../docs/adr/0014-run-speech-engines-on-the-desktop-or-the-server.md).

### 18.1 Terms

- **Speech engine:** a runtime that turns audio into timed words (ASR) or text into audio (TTS):
  sherpa-onnx, whisper.cpp, mlx-audio, Pocket TTS.
- **Speech model:** one weights file an engine loads, with a pinned revision and a SHA-256.
- **Target:** where an engine runs. `desktop` (the person's Mac, through the app) or `server` (the
  Diazo instance, through the speech sidecar), or `cloud` (ElevenLabs or OpenAI on the person's
  own key, only when they pick it).
- **Custom model:** a model the person, or an instance admin on the server, adds from Hugging Face
  or a local file, for a runtime from a fixed set (18.9).
- **Install:** one engine plus one model on one target, downloaded, verified and ready.

### 18.2 Transcription: what exists today

English WER and RTFx from the Open ASR Leaderboard (updated 2026-11-13; LibriSpeech left its
average on 2026-11-02, so older posts quote lower numbers). RTFx is measured on a GPU and does not
predict CPU speed. French WER from the leaderboard's multilingual tab unless noted.

| Model                     | En WER / RTFx | Fr WER                             | Word timestamps                        | Size                             | Weights licence |
| ------------------------- | ------------- | ---------------------------------- | -------------------------------------- | -------------------------------- | --------------- |
| **Parakeet TDT 0.6B v3**  | 7.04 / 6322   | 5.40 (card: FLEURS 5.15, MLS 4.97) | Native, word and segment               | 487 MB int8 ONNX, 714 MB q8 GGUF | CC-BY-4.0       |
| Whisper large-v3-turbo    | 8.75 / 809    | 6.74                               | Token level (DTW), approximate         | 574 MB q5_0, 874 MB q8_0         | MIT             |
| Whisper large-v3          | 8.24 / 471    | 6.24                               | Token level (DTW), approximate         | 1.08 GB q5_0, 3.1 GB f16         | MIT             |
| distil-large-v3.5         | 7.57 / 898    | English only                       | As Whisper                             | 756M parameters                  | MIT             |
| Canary-1B-v2              | 8.43 / 1854   | 4.79                               | Not verified                           | 1B parameters                    | Not verified    |
| Qwen3-ASR-1.7B            | 6.15 / 836    | 5.63                               | Separate forced aligner, 5 min maximum | about 2B parameters              | Apache-2.0      |
| Cohere Transcribe 03-2026 | 6.72 / 924    | 4.03                               | None (its card says so)                | 2B, gated                        | Apache-2.0      |
| Voxtral Mini 3B           | 8.32 / 180    | 5.93                               | Not on the card                        | about 9.5 GB of GPU memory       | Apache-2.0      |
| Nemotron 3.5 Transcribe   | 6.13 / 473    | 3.96                               | Yes                                    | 30B-A4B, H100 class              | OpenMDW-1.1     |

| Engine                   | Version, licence                  | What matters here                                                                                                     |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **sherpa-onnx**          | Release of 2026-11-16, Apache-2.0 | C API, no Python. Publishes a Parakeet v3 int8 archive with its SHA-256. Token timestamps, words rebuilt at `▁` marks |
| **whisper.cpp**          | v1.9.5 (2026-10-06), MIT          | Metal, Core ML, CUDA, Vulkan, CPU. Built-in Silero VAD, `--dtw` token timestamps, `whisper-server` HTTP mode          |
| faster-whisper           | 1.2.1 (2025-10-31), MIT           | int8 on CPU, `word_timestamps`. Python, and no release in a year                                                      |
| WhisperX                 | 3.8.6, BSD-2                      | Sharper words through wav2vec2 alignment; diarization needs the gated pyannote model and a Hugging Face token         |
| parakeet-mlx, FluidAudio | 0.7.0 and untagged, Apache-2.0    | Parakeet on Apple silicon, in Python (MLX) or Swift (Core ML). Native alternatives for the desktop                    |

### 18.3 Transcription: the choice

- **Default on both targets:** Parakeet TDT 0.6B v3, int8, through sherpa-onnx. It covers 25
  European languages including French, gives native word timings, beats Whisper turbo on English
  and French WER, weighs 487 MB, and its CC-BY-4.0 weights only ask for attribution.
- **Fallback for every other language:** whisper.cpp with large-v3-turbo q5_0 (574 MB), on Metal
  on a Mac, with `--dtw large.v3.turbo` and VAD on. Whisper covers what Parakeet does not
  (Japanese, Chinese, Arabic and the rest).
- **Model menu** (the same ids on both targets; the server marks the slow one):

| Menu label                  | Engine, model                    | Download | Mac (Apple silicon)  | VPS, 8 CPU cores, 10 min of audio (estimate) |
| --------------------------- | -------------------------------- | -------- | -------------------- | -------------------------------------------- |
| Fast, 25 European languages | sherpa-onnx, Parakeet v3 int8    | 487 MB   | Seconds              | 0.5 to 1.5 min                               |
| Any language                | whisper.cpp, large-v3-turbo q5_0 | 574 MB   | Well under real time | 3 to 6 min                                   |
| Best Whisper                | whisper.cpp, large-v3 q5_0       | 1.08 GB  | Under real time      | 10 to 20 min (marked slow)                   |

The VPS figures are estimates from desktop CPU benchmarks (Parakeet RTFx 36 on a Ryzen 9800X3D,
divided by two to three for VPS cores). The first build task measures them on the VPS with a
10-minute French clip, and the menu shows measured times, not these.

- **Words:** every transcript is stored as words (`{ text, start, end, confidence }`) with its
  language, engine, model and target. Parakeet's tokens are joined into words at `▁` marks (a test
  covers French elisions such as `l'interface`). Whisper's DTW timings are approximate; a word
  whose span is implausible (under 20 ms, or overlapping the next) is snapped to the VAD boundary.
- **Also in v1:** the person's own model (18.9), cloud transcription on their own key (18.7) and
  speaker labels (18.8).
- **Out of scope for the first version:** live transcription, and translation by the ASR model
  (captions are translated by the person's chat model, 14.9).

### 18.4 Local voice-over: what exists today

Elo from the Artificial Analysis open-weights speech board, read 2026-11-16 (the page carries no
update date). "-" means not on the board or not stated.

| Model                   | Elo  | French                                              | Cloning                              | Control                                      | Size               | Weights licence                            |
| ----------------------- | ---- | --------------------------------------------------- | ------------------------------------ | -------------------------------------------- | ------------------ | ------------------------------------------ |
| Fish Audio Drama 3      | 1277 | Not named among its 83 languages                    | Yes                                  | Inline tags                                  | 35B MoE, 3B active | Research and Community licences, unclear   |
| Breeze TTS 2            | 1229 | No                                                  | Yes                                  | -                                            | -                  | Non-commercial, outputs included           |
| Ming-3.0-tts            | 1183 | Yes; its authors call French its clearest gap       | Yes                                  | Emotion, speed, pitch, voice design          | 0.5B               | MIT                                        |
| Fish S2 Pro             | 1104 | Yes                                                 | Yes                                  | Many tags                                    | about 5B           | Research, non-commercial                   |
| Voxtral TTS (Mistral)   | 1093 | Native                                              | Not confirmed in the open weights    | -                                            | 4B, 16 GB GPU      | CC BY-NC 4.0                               |
| Kokoro 82M              | 1060 | One voice, graded B-                                | No                                   | No                                           | 82M                | Apache-2.0                                 |
| Higgs Audio V3          | 1038 | Yes                                                 | Yes                                  | -                                            | 4B                 | Research, non-commercial                   |
| Chatterbox Multilingual | 1020 | Yes                                                 | Yes, about 10 s                      | Exaggeration                                 | 0.5B               | MIT with a watermark; **retired 2026-08**  |
| XTTS-v2                 | 915  | Yes                                                 | Yes                                  | -                                            | -                  | Coqui Public Model Licence, non-commercial |
| **VoxCPM2**             | -    | Yes; lowest French WER in Ming's comparison (3.38%) | Yes, short clip, transcript optional | Voice design from a description, style hints | 2B                 | **Apache-2.0**                             |
| Qwen3-TTS               | -    | Yes (10 languages)                                  | Yes, 3 s plus its transcript         | Instructions                                 | 0.6B and 1.7B      | Apache-2.0                                 |
| **Kyutai Pocket TTS**   | -    | Yes (with EN, DE, IT, ES, PT)                       | Yes, from a WAV                      | -                                            | 100M               | **CC-BY-4.0**, gated repository            |
| Kyutai TTS 1.6B en_fr   | -    | Native                                              | Precomputed voices only              | -                                            | 1.6B               | CC-BY-4.0                                  |
| IndexTTS-2.5            | -    | No                                                  | Yes                                  | Emotion vector                               | -                  | bilibili licence                           |
| Piper                   | -    | Not checked                                         | No                                   | No                                           | small              | GPL-3.0 code; robotic next to the others   |

Also gone or ruled out: Microsoft VibeVoice (TTS code removed, weights listed as disabled), and
F5-TTS (CC-BY-NC weights, per secondary sources only).

### 18.5 Local voice-over: the choice

- **The Mac offers three studio voices**, all with permissive weights and French: VoxCPM2,
  Qwen3-TTS and Ming-3.0. The person picks one in the model menu, or adds their own (18.9).
  VoxCPM2 is preselected until the listening test below says otherwise.
- **Preselected: VoxCPM2** (OpenBMB, 2B, Apache-2.0). It is the only candidate with all of these:
  weights a fork may sell, native French with the best French WER we found, cloning from a short
  clip, voice design from a sentence ("a warm, low female voice, calm"), style hints, and 48 kHz
  output. On a Mac it runs through mlx-audio at RTF 0.48 in bf16 and 0.85 in 8-bit, so faster
  than real time.
- **Honest trade-offs:** no arena Elo backs it, since it is not on the board. Its card warns of
  occasional instability on very long or very expressive input, and says voice design varies
  between runs. Its official runtime is CUDA, so the Mac path rests on the mlx-audio port. On a
  CPU-only VPS it is slower than real time.
- **Guard:** before the build starts, Bryan runs a blind listening test on the Mac, with one
  2-minute French script and one English script: VoxCPM2 against Qwen3-TTS 1.7B and Ming-3.0
  0.5B. The winner is preselected; the other two stay in the menu.
- **Qwen3-TTS 1.7B** (Apache-2.0): French among 10 languages, cloning from 3 s plus its
  transcript, instructions for style. More CPU ports than VoxCPM2.
- **Ming-3.0-tts 0.5B** (MIT): the best-ranked open model with permissive weights (Elo 1183),
  with emotion, speed, pitch and voice design. Its authors call French its clearest gap, and its
  official runtime is CUDA, so the Mac path rests on mlx-audio.
- **Fast voice, and the server default: Kyutai Pocket TTS** (100M, CC-BY-4.0). French and cloning,
  any text length, about 6x real time on two cores of an M4, and an official Rust binary. It is
  less expressive than the 2B models, and it is the one that sounds good on a CPU-only VPS.
- **Not the default, and why:** Fish, Breeze, Higgs, Voxtral TTS and XTTS have non-commercial or
  research weights, and Drama 3 also needs far more than 31 GB. Chatterbox is retired and
  watermarks every file. Kokoro has one weak French voice, so it stays as an English-only quick
  preview. IndexTTS has no French. Piper sounds robotic next to the rest.

Desktop menu (Mac, Apple silicon):

| Menu label                    | Engine, model                | Speed on the Mac                 |
| ----------------------------- | ---------------------------- | -------------------------------- |
| Studio: VoxCPM2 (preselected) | mlx-audio, VoxCPM2 8-bit     | Faster than real time (RTF 0.85) |
| Studio: Qwen3-TTS             | mlx-audio, Qwen3-TTS 1.7B    | To measure                       |
| Studio: Ming-3.0              | mlx-audio, Ming-3.0-tts 0.5B | To measure                       |
| Fast voice                    | Pocket TTS (Rust)            | About 6x real time               |
| Quick preview, English only   | Kokoro 82M                   | Instant                          |
| Your own model                | 18.9                         | Smoke-tested before use          |

Server menu (8 CPU cores, no GPU), the curated list an instance admin installs from:

| Menu label                  | Engine, model                        | Expected on the VPS                                                             |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| Fast voice (default)        | Pocket TTS (Rust), mirrored (18.15)  | Faster than real time (to measure)                                              |
| Studio on CPU (slow)        | Qwen3-TTS 0.6B int8 (GGUF, C++ port) | Slower than real time: about 3x RTF on 4 vCPU by a third party; to measure on 8 |
| Quick preview, English only | Kokoro 82M (sherpa-onnx)             | About 5x real time                                                              |
| An admin's own model        | 18.9                                 | Smoke-tested before use                                                         |

VoxCPM2 and Ming-3.0 are not on the server list: their CPU paths are PyTorch only or missing. An
admin may still add one as their own model (18.9), and its smoke test marks it slow.

- **Long form:** the text is cut into sentences, each generated with the previous one as context
  where the engine takes it, then joined with 30 ms crossfades. Each sentence keeps its take, so
  one bad sentence is regenerated alone. Five minutes of narration is the tested length.
- **Word timings for captions:** local engines give none, so the installed ASR model transcribes
  the generated audio once, and its words become the caption source (14.9).

### 18.6 ElevenLabs on the person's key

- **A connection kind:** `elevenlabs-key` in `model_accounts`, its key sealed like every other
  (`server/secretBox.ts`), connected in Settings, Diazo Agent, under a new **Voice** group beside
  "Image model". It is never an agent runner: `listRunners` and `resolveDefault` skip it, and the
  composer's picker never lists it.
- **Voices:** `GET /v2/voices` (search, language, `page_size` up to 100, `next_page_token`),
  cached per account for ten minutes. The person's own cloned voices on ElevenLabs appear there.
  Diazo never uploads a voice sample to ElevenLabs in the first version.
- **Models** (verified 2026-11-16 on the models page; the menu also follows the live list where
  the API gives one):

| Model                    | Languages | Characters per request | Price per 1,000 characters | Note                        |
| ------------------------ | --------- | ---------------------- | -------------------------- | --------------------------- |
| `eleven_v4` (default)    | 90+       | 10,000                 | $0.08                      | Most expressive             |
| `eleven_v4_turbo`        | 90+       | Not listed             | $0.04                      | About 100 ms latency        |
| `eleven_v3`              | 70+       | 5,000                  | $0.08                      |                             |
| `eleven_multilingual_v2` | 29        | 10,000                 | $0.08                      | The API's own default       |
| `eleven_flash_v2_5`      | 32        | 40,000                 | $0.04                      | Long scripts in one request |

`eleven_turbo_v2_5` and `eleven_turbo_v2` are deprecated and not offered. `eleven_flash_v2` is
English only and not offered.

- **Calls:** `POST /v1/text-to-speech/{voice_id}/with-timestamps` returns the audio and a
  character alignment, which Diazo folds into words for captions. Long scripts go one paragraph
  per request with `previous_text` and `next_text`, so the narration stays continuous.
- **Cost:** before a run, the panel shows the character count times the model's price, and the
  run lands in the usage meter (`shared/modelPrices.ts` gains the ElevenLabs rows). Prices are
  dated in that file, and the panel says "as of" that date.
- **The same key transcribes:** ElevenLabs Scribe runs on this connection (18.7).

### 18.7 Cloud transcription on the person's key

For people who want speed, a language Parakeet lacks, or have neither the app nor a server
install. Both routes are opt-in, per job or by preference, and the panel says the audio leaves the
instance.

| Route                               | Connection                  | Model            | Word timings                           | Speakers                                 | Limits            | Price (2026-11-16)                     |
| ----------------------------------- | --------------------------- | ---------------- | -------------------------------------- | ---------------------------------------- | ----------------- | -------------------------------------- |
| **ElevenLabs Scribe** (recommended) | `elevenlabs-key`            | `scribe_v3`      | Yes (`timestamps_granularity: word`)   | Yes (`diarize`, `num_speakers` up to 32) | Files under 5 GB  | $0.20 an hour of audio                 |
| OpenAI, words                       | `openai-key` (API key only) | `whisper-1`      | Yes (`timestamp_granularities[]=word`) | No                                       | 25 MB per request | Read from OpenAI's price list at build |
| OpenAI, text only                   | `openai-key` (API key only) | `gpt-transcribe` | No                                     | No                                       | 25 MB per request | Read from OpenAI's price list at build |

- **OpenAI's catch:** its recommended `gpt-transcribe` returns text and languages only. Word
  timings come only from `whisper-1`, and speakers only from `gpt-4o-transcribe-diarize`; both are
  deprecated and shut down on 2027-02-26. So v1 offers `whisper-1`, labelled with that date, and
  `gpt-transcribe` as "text only, no cuts by word". When `whisper-1` is gone, an OpenAI text is
  aligned to the audio by the installed local model where there is one (18.16).
- **Size:** Diazo sends mono 16 kHz Opus. Past 25 MB (about an hour), an OpenAI request is cut at
  silences with a one-second overlap, and the parts are joined by time.
- **Cost:** the duration times the route's price is shown before the run, and the run lands in the
  usage meter (`shared/modelPrices.ts` gains the rows, dated).
- **Results:** the same word list as a local transcript, with `target: 'cloud'` and the provider.

### 18.8 Speaker labels

- **Cloud:** Scribe labels speakers itself (`diarize: true`, an optional speaker count). Each word
  arrives with its `speaker_id`.
- **Local, the default on both targets:** sherpa-onnx's speaker diarization. It pairs pyannote's
  segmentation-3.0 model (MIT; sherpa-onnx publishes the ONNX conversion in its
  `speaker-segmentation-models` release, with no gate and no token, about 7 MB) with a 3D-Speaker
  CAM++ embedding (about 30 MB, from its `speaker-recongition-models` release, licence confirmed
  at build) and clusters the result. It runs on the CPU in the same engine as Parakeet, with no
  Python. Each word takes the speaker of the segment it overlaps most.
- **Better quality, with the person's own token:** pyannote's `speaker-diarization-community-1`
  (CC-BY-4.0, gated behind accepting its terms) is offered as an add-your-own model (18.9) with
  the `pyannote` runtime. The person (or an admin, on the server) pastes their own Hugging Face
  token once; it is sealed, used only to download, and never shown back. Diazo does not mirror it,
  since its gate asks each user to accept the terms.
- **Excluded:** sherpa-onnx's Rev diarization models (non-commercial).
- **Editing:** speakers are listed as `S1`, `S2` and so on, and renamed once per media ("Bryan",
  "Guest"). A word's speaker can be corrected, which splits the turn. Captions may show the name.
- **Off by default** for a single voice; the panel offers it when the clip has more than one.

### 18.9 Add your own model

One contract for every target and both kinds. A person adds one on their Mac; on the server, only
instance admins do (18.11).

- **Source**, one of:
  - a Hugging Face repository id (`owner/name`) and a revision. The revision is resolved to a
    commit hash when the model is added, and every later download uses that commit. A gated
    repository takes the person's own token (sealed, download only).
  - on the desktop only, files picked in the native file panel (`speech_choose_files`). The page
    never sends a path; the shell copies the files into its own folder.
- **Runtime**, from a fixed set; anything else is refused:

| Runtime       | Kind               | Targets         | What it loads                                                                                                                 |
| ------------- | ------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sherpa-onnx` | ASR, TTS, speakers | Desktop, server | ONNX: transducer, CTC, Whisper and Parakeet for ASR; VITS, Matcha and Kokoro for TTS; segmentation and embedding for speakers |
| `whisper.cpp` | ASR                | Desktop, server | ggml or GGUF Whisper weights                                                                                                  |
| `mlx-audio`   | TTS, ASR           | Desktop only    | A model type mlx-audio lists (VoxCPM2, Qwen3-TTS, Ming, Kokoro, Parakeet and others)                                          |
| `pocket-tts`  | TTS                | Desktop, server | Pocket TTS-format weights, such as fine-tunes                                                                                 |
| `pyannote`    | Speakers           | Desktop, server | pyannote pipelines, in a private Python environment                                                                           |

A llama.cpp-style GGUF runtime for TTS is not in v1: each GGUF TTS port ships its own binary,
and there is no common one to pin. It joins the set once one settles.

- **Files:** safetensors, ONNX, ggml or GGUF only. Pickle files (`.bin`, `.pt`, `.ckpt`) are
  refused, and no runtime runs with remote code enabled.
- **Checks:** the SHA-256 of every file comes from Hugging Face's file metadata at the pinned
  commit (or is computed when a local file is picked), and is checked again after the download.
  The size is shown before anything downloads, and refused past a cap: free disk minus 5 GB on the
  desktop; 15 GB a model, and the volume's free space, on the server.
- **Licence:** the dialog shows the licence the repository declares (an SPDX id, or the text of a
  custom one), and the person ticks "I have read the licence and my use complies". A licence that
  is non-commercial, research-only or unknown gets a warning line. Diazo checks no licence; it
  records the acknowledgement (who, when, which licence text).
- **Smoke test** before the model is enabled. It stays disabled, with the log, until one passes:
  - ASR: a bundled 8-second clip (French, then English) must come back as at least five words with
    timings inside the clip, under 50% WER.
  - TTS: a fixed sentence must come back as 1 to 20 seconds of audio that is not silence, and the
    installed ASR model, when there is one, must hear at least half its words.
  - Speakers: a bundled two-voice clip must come back with two speakers.
  - Every test records how long it took, so the menu can mark the model slow.
- **In the menus:** a "Custom" badge, the licence and the measured speed. Agents may use it by its
  model id like any other. Uninstall works as for the curated models. There are no updates, since
  the commit is pinned: a new revision is a new model.

### 18.10 One-click install, on the desktop

- **Where:** `~/Library/Application Support/design.doop.desktop/speech/`, holding
  `engines/<engine>/<version>/`, `models/<model id>/<revision>/` and `speech.json` (what is
  installed, when it was last used).
- **What the page can ask:** `speech_status`, `speech_install(modelId)`,
  `speech_uninstall(modelId)` and `speech_cancel(jobId)` (`desktop/src-tauri/src/speech.rs`,
  advertised as `__DIAZO_SPEECH__`). A model id names an entry of the catalog compiled into the
  shell, or a custom model the person added (18.9), which carries only a Hugging Face repository
  id and a commit hash, both checked for shape, and downloads only from `huggingface.co`. The page
  never sends a URL, a path or an argument.
- **Download:** engine binaries come from Diazo's own `speech-engines-v*` release, built in CI from
  pinned upstream tags (sherpa-onnx, whisper.cpp with Metal, Pocket TTS) and signed with the
  updater's minisign key. Python engines (mlx-audio) are installed by a pinned `uv` binary into a
  private environment, from a lock file. Models come from Hugging Face at a pinned commit.
- **Checks:** every file streams to `.part`, resumes after a drop, and is checked against the
  catalog's SHA-256 before it moves into place; a mismatch deletes it and says so. Free disk
  space is checked first.
- **Progress:** `speech-progress` events (bytes, total, and the step: download, verify, warm up);
  the Settings row shows a bar and a Cancel. The warm-up runs a two-second sample, so "Ready"
  means the model actually ran.
- **Hardware:** whisper.cpp uses Metal, sherpa-onnx the CPU (or Core ML where a build-time
  measurement shows it is faster), mlx-audio Metal through MLX. The Studio voice needs Apple
  silicon.
- **Processes:** each engine runs as a child process with fixed arguments, one job at a time. It
  is killed with its process group on cancel or quit, and unloaded after 10 idle minutes.
- **Jobs:** the page or an agent creates a job on the server. The shell polls for jobs addressed
  to this desktop (as `localAgentRuns` does), fetches the audio from `/a/`, runs it, and posts the
  words or the audio back. The person's Mac does the work; the result is stored on the canvas
  like any edit.
- **Uninstall** removes the model folder, and the engine when no model uses it any more.
- **Updates:** a catalog entry with a newer revision shows "Update" on its row. The new files
  install beside the old ones, which go only once the new model has warmed up.

### 18.11 One-click install, on the server

- **A sidecar, not the app process:** a `diazo-speech` service runs the engines, so a transcript
  can never starve or kill the canvas. In k3s it is a Deployment in the `doop` namespace with a
  `ClusterIP` Service only (ADR 0004); in Compose it is an optional service. The app reaches it at
  `DOOP_SPEECH_URL` with a bearer `DOOP_SPEECH_TOKEN` from `doop-secrets`. When these are unset,
  the server target says "not available on this instance" and gives the line to add.
- **Resource limits (k3s):** requests of 100m CPU and 256 Mi; limits of 6 CPUs and 10 Gi, which
  leaves two cores and the rest of the 31 GB to the app, Postgres and the renderer. Engines run
  with six threads under `nice 10`, one job at a time, with a queue of 20, and unload after 10
  idle minutes.
- **Models:** a `speech-models` volume (a 20 Gi PVC) is mounted at `/models`. The image carries
  the engine binaries (the same `speech-engines-v*` builds), never the weights.
- **Only instance admins** install, uninstall, update or add their own model on the server
  (decided by Bryan, 2026-11-16): the cores and the volume are shared by everyone on the
  instance. Everyone else uses the models the admins installed, or installs on their own Mac.
- **One click:** Admin, Speech lists the curated catalog and the admins' own models. Install calls `POST /api/speech/server/installs/:modelId`; the app asks the sidecar to
  download, verify and warm up, and progress reaches the page as `speech:progress`. Uninstall and
  Update work as on the desktop.
- **Sidecar API** (internal only): `GET /v1/installs`, `POST /v1/installs`,
  `DELETE /v1/installs/:id`, `POST /v1/transcribe`, `POST /v1/speak`, `GET /healthz`.

### 18.12 Which target runs a job

- Each person has `speech_preferences`: a target for transcription and one for voice-over
  (`auto`, `desktop`, `server`, `cloud`), a model, a cloud provider for transcription
  (`elevenlabs` or `openai`), a voice provider (`local` or `elevenlabs`), a voice, a language, and
  whether to label speakers.
- `auto` means the desktop when this person's app is online and has the model, else the server
  when it has the model, else the panel offers to install (on the desktop first when the person is
  in the app). `auto` never picks `cloud`: sending audio out is always the person's explicit
  choice. An agent's call follows the same rule for the person it acts for.
- The editor shows where a job runs ("On your Mac", "On the Diazo server", "ElevenLabs, about
  $0.12"), and the person can switch it per job.

### 18.13 Data model, API and tools

- `speech_installs` (server target only): model id, engine, revision, state (`downloading`,
  `verifying`, `ready`, `failed`), bytes, installed by, installed at, last used. Desktop installs
  live in the shell's `speech.json`, are reported with each poll, and are kept in memory per
  device.
- `speech_jobs`: id, kind (`transcribe`, `speak`), target, device, model, input asset, state,
  progress, output (words, or an audio asset with its words), requested by, error, timestamps.
- `speech_preferences`: one row per person (18.12).
- `speech_custom_models`: an added model (18.9): owner (a person, or the instance for the server),
  target, kind, runtime, source (repository and commit, or `local`), files with size and SHA-256,
  licence id and text, acknowledged by and at, sealed Hugging Face token, smoke test result and
  timing, enabled. Desktop custom models also live in the shell's `speech.json`; the row keeps
  what the server needs to route a job.
- `voices`: a cloned voice per person: name, sample asset, sample transcript, consent time, and
  the engines it works with. Samples are private assets of their owner.
- The media row (`scene_media`, renamed after the branch's tables when built) gains
  `transcript = { language, words[], speakers, engine, model, target, provider, jobId }`, where a
  word is `{ text, start, end, confidence, speaker? }` and `speakers` maps `S1` to a name. A voice-over layer keeps
  `generation = { provider, model, voice, text, style, cost }` (14.11).
- REST: `GET /api/speech/catalog` (models, and installs per target),
  `POST`/`DELETE /api/speech/server/installs/:modelId` (admins),
  `POST /api/speech/custom-models` (resolve, then add; admins for the server),
  `POST /api/speech/custom-models/:id/test`, `DELETE /api/speech/custom-models/:id`,
  `PUT /api/speech/media/:mediaId/speakers`, `POST /api/speech/jobs`,
  `GET /api/speech/jobs/:id`, `GET`/`PUT /api/speech/preferences`, `GET`/`POST`/`DELETE
/api/voices`, `GET /api/model-account/voices?kind=elevenlabs-key`, and the desktop relay
  `/api/speech/desktop/poll` and `/api/speech/desktop/finish/:id`.
- Room messages: `speech:progress`, `media:transcribed`.
- MCP and resident agent, same names:
  - `list_speech_engines`: what is installed, and where.
  - `transcribe_clip { canvas_id, media_id, language?, target?, model?, provider?, speakers? }`:
    waits up to 60 s, else returns the job to poll with `get_transcript`. `target: 'cloud'` runs
    only when the person's preference allows the cloud; otherwise it is refused with the reason.
  - `set_speakers { canvas_id, media_id, names }`: renames speakers.
  - `get_transcript`, `list_voices`.
  - `generate_voiceover { canvas_id, page_id, text, provider?, voice?, model?, language?, style?, at? }`:
    adds an audio layer at `at` seconds, with its words.
  - An agent can neither install, uninstall nor add a model.
- Env: `DOOP_SPEECH_URL`, `DOOP_SPEECH_TOKEN`; `DOOP_SPEECH=false` turns every target off, and
  `DOOP_ELEVENLABS=false` hides the connection.

### 18.14 Privacy and licences

- **Local stays local:** a desktop job sends nothing to a third party. The audio already lives on
  the person's Diazo server, and only the words or the generated audio go back to it. A server
  job stays on the instance. Only a cloud provider the person picks by name receives anything:
  ElevenLabs gets the script for a voice-over, and ElevenLabs or OpenAI get the audio for a cloud
  transcript, each time with a line saying so. A voice sample never leaves the instance.
- **Cloning needs consent:** a voice is cloned only from a sample the person uploads with a
  checkbox saying it is their voice or that they have the speaker's permission. The sample is
  never shared, copied with a canvas or sent to a provider.
- **Attribution:** Parakeet v3, Pocket TTS and the speaker models (CC-BY-4.0, MIT), VoxCPM2 and
  Qwen3-TTS (Apache-2.0), Ming-3.0 (MIT) and the engines are listed in `THIRD-PARTY-LICENSES` and in Settings, About. Weights are downloaded at install
  and never committed to the repository.
- **A generated voice says so:** the voice-over layer and the export's metadata mark it as
  synthetic, as VoxCPM2's card asks.

### 18.15 Mirrored weights: Pocket TTS

Decided by Bryan, 2026-11-16: we mirror Pocket TTS's weights, so the one click needs no Hugging
Face account.

- **What the gate asks** (read 2026-11-16): users share their Hugging Face details, comply with
  the law, never clone or impersonate a voice without explicit and lawful consent, and never
  present generated audio as a genuine recording of real people or events. The licence is
  CC-BY-4.0, which allows redistribution with attribution. The gate's conditions are terms of use,
  and Diazo passes them on: the install dialog shows them, and the consent rule and the synthetic
  mark (18.14) already meet them.
- **Where: a GitHub release asset,** `speech-models-v<n>` on `BRYANN2K/diazo`, beside
  `speech-engines-v*`: the files at the pinned upstream commit, unchanged, a `SHA256SUMS` signed
  with the updater's minisign key, and the attribution file. The catalog points at the release, and
  the installer checks the signature, then each hash. Anonymous, no token, the same download path
  as the engines, and far under the 2 GB asset limit.
- **Rejected: a GHCR OCI artifact** (`oras push`). Anonymous pulls work for a public package, but
  it adds an OCI client to the shell and the sidecar for a 100M model.
- **Attribution** (`ATTRIBUTION.md` in the release and beside the weights on every target, in
  `THIRD-PARTY-LICENSES` and in Settings, About): "Pocket TTS" by Manu Orsini, Simon Rouard,
  Gabriel De Marmiesse, Václav Volhejn, Neil Zeghidour and Alexandre Défossez (Kyutai), the paper
  (arXiv:2509.06926), the source `https://huggingface.co/kyutai/pocket-tts` at the pinned commit,
  the licence (CC-BY-4.0, linked), "not modified", and the gate's conditions of use.
- **Updates:** a new upstream commit is read, mirrored as a new release by hand, and the catalog
  revision is bumped in the same pull request.

### 18.16 Open questions

1. When OpenAI shuts `whisper-1` down (2027-02-26), keep OpenAI as a text-only route aligned by
   the local model, or drop it? Recommended: keep it text-only, aligned where a local model exists.
2. The listening test (18.5) decides which studio voice is preselected: VoxCPM2, Qwen3-TTS or
   Ming-3.0. All three stay in the menu.
3. The 3D-Speaker CAM++ embedding's licence is confirmed at build; if it is not permissive, a
   WeSpeaker or NeMo embedding from the same release takes its place.
4. OpenAI's transcription prices were not on the pricing page we read; they are read again, and
   dated, when the route is built.

### 18.17 Sources (all read 2026-11-16)

- Open ASR Leaderboard: https://huggingface.co/spaces/hf-audio/open_asr_leaderboard
- Parakeet TDT 0.6B v3: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- sherpa-onnx models: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- whisper.cpp: https://github.com/ggml-org/whisper.cpp and https://huggingface.co/ggerganov/whisper.cpp
- Whisper large-v3-turbo: https://huggingface.co/openai/whisper-large-v3-turbo
- distil-large-v3.5: https://huggingface.co/distil-whisper/distil-large-v3.5
- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- WhisperX: https://github.com/m-bain/whisperX; pyannote:
  https://huggingface.co/pyannote/speaker-diarization-community-1
- Qwen3-ASR: https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- Cohere Transcribe: https://huggingface.co/CohereLabs/cohere-transcribe-03-2026
- Voxtral Mini: https://huggingface.co/mistralai/Voxtral-Mini-3B-2507
- Nemotron 3.5 Transcribe: https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B
- parakeet-mlx: https://github.com/senstella/parakeet-mlx; onnx-asr: https://github.com/istupakov/onnx-asr;
  FluidAudio: https://github.com/FluidInference/FluidAudio
- Open-weights speech board: https://artificialanalysis.ai/text-to-speech/leaderboard/open-weights
- VoxCPM2: https://huggingface.co/openbmb/VoxCPM2 and https://voxcpm.readthedocs.io/en/latest/faq.html
- Qwen3-TTS: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- Pocket TTS: https://github.com/kyutai-labs/pocket-tts and https://huggingface.co/kyutai/pocket-tts
- Kyutai TTS: https://huggingface.co/kyutai/tts-1.6b-en_fr
- Ming-3.0-tts: https://github.com/inclusionAI/Ming-3.0-tts
- Fish Audio: https://huggingface.co/fishaudio/drama-3 and https://huggingface.co/fishaudio/s2-pro
- Voxtral TTS: https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- Chatterbox: https://github.com/resemble-ai/chatterbox
- Kokoro voices: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- IndexTTS: https://github.com/index-tts/index-tts; Piper: https://github.com/OHF-Voice/piper1-gpl;
  VibeVoice: https://github.com/microsoft/VibeVoice
- mlx-audio: https://github.com/Blaizzy/mlx-audio
- Qwen3-TTS on CPU: https://ocdevel.com/blog/20260711-quantized-cpu-tts
- sherpa-onnx speaker diarization: https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html
  and https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models
- ElevenLabs Scribe: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- OpenAI speech to text: https://developers.openai.com/api/docs/guides/speech-to-text
- ElevenLabs: https://elevenlabs.io/docs/overview/models, https://elevenlabs.io/pricing/api,
  https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps,
  https://elevenlabs.io/docs/api-reference/voices/search
