# Motion Studio

Status: proposal, not built. Research dated 2026-11-15. Screens: canvas `bIK8evKpnI`, page
"18 Motion Studio". Not a paid feature: redoop is not commercialised. The only costs are the
user's own (their provider accounts, their GPU, their Octane licence), shown like the usage meter.

## 1. Thesis

**A film is a page with a clock.** A redoop frame is already a live HTML document. Motion Studio
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
- redoop has the frames, the tokens, the components, a 959-family Motion category in the design
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
| OpenRouter video                | One endpoint for Veo 3.1, Gemini Omni, Kling 3.0, Seedance 2.5, Hailuo 3, Runway | Yes (`POST /api/v1/videos`, poll); reported as alpha | **Integrate first**: the account kind already exists in redoop     |
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

## 4. Concepts, in redoop terms

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
2. **Doop animates it.** The agent reads the order, the notes, the tokens and the pixels of pasted
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
- Transcription runs locally where possible (Whisper through the desktop shell), else on the user's
  account. Fillers and silences (ffmpeg `silencedetect` or the word gaps) become suggested cuts.
- Captions are an HTML track styled by tokens, kept inside the title-safe box.
- Audio: per-layer gain, ducking under voice, fades. Mixed by ffmpeg at render; previewed with Web
  Audio.

### 7.7 Collaboration

- The scene is canvas state: edits broadcast like frame edits, one undo step per gesture.
- Each person has their own playhead. "Follow" shares one.
- Comments anchor to a time range on a scene, shown on the ruler.
- Frame versions keep keyframes. A scene keeps its last 20 states.

## 8. Blender, three.js, Octane

- **Licences.** Blender is GPL: redoop never bundles it or its code. The desktop shell talks to a
  running Blender as a separate process. A redoop add-on, if one is needed, lives in its own GPL
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

- **Licence:** Apache-2.0, compatible with redoop's AGPL-3.0 for inclusion.
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

| Phase   | Scope                                                                                                                                                       | Done when                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0       | Runtime, markup contract, `MO-*` lint, `get_scene_snapshot`                                                                                                 | An agent-written frame scrubs and snapshots at any time    |
| 1 (MVP) | Storyboard page, camera across frames, timeline panel (scenes, camera, captions), Doop animates a storyboard, MP4 and WebM from the browser and the desktop | A 15 s film from three frames, with no tool outside redoop |
| 2       | Layer keyframes and easing in the inspector, library Motion items as clips, GIF, CSS and WAAPI code export, time-range comments                             | A motion spec a developer can paste                        |
| 3       | Media layers: video and audio, trim, transcript cuts, captions track, ducking; `generate_video` on OpenRouter and Gemini                                    | A narrated walkthrough cut inside redoop                   |
| 4       | Blender link, three.js layers, Cycles and Eevee shots, Octane option                                                                                        | A 3D hero that is also a shot in the film                  |
| 5       | Server renders, Lottie export, HyperFrames import and export, motion duel                                                                                   | -                                                          |

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
  agents), and redoop's agents and editor use it through the app. Which Blender MCP server (official
  or the MIT community one) is decided at build time after a licence check; Mac first.

The other questions below stay open.

## 13. Open questions

1. Is the storyboard a new page kind, or an ordinary page that gains a timeline when asked?
   Recommended: an ordinary page.
2. MVP output: is MP4 from the browser and the desktop enough, with server renders in phase 5?
   Recommended: yes.
3. Should Doop rebuild pasted screenshots as HTML by default, or ask per shot? Recommended: ask in
   the plan, default to rebuild for interface screenshots.
4. Video generation: OpenRouter first, then Gemini. Add fal.ai as a new connection kind in phase 3
   or wait for demand?
5. Is local Whisper through the desktop shell acceptable as a dependency the user installs, or
   should transcription use their model account by default?
6. Blender: use the official Blender MCP server (licence to verify) or the community one (MIT)?
   And is a Mac-only first version fine?
7. Octane: worth a phase at all, given Prime is CUDA and one GPU? Recommended: keep the option in
   the design, build it last.
8. Lottie export covers only vector layers with transform and opacity. Is that useful enough, or
   should it wait for demand?
9. Should the HyperFrames registry be a clip source, given per-block licence checks?
10. Confirm two licence points before building: GSAP's clause on animation tools, and the official
    Blender MCP server's licence.
