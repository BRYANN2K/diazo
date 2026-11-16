# Motion Studio backend, phases 2 to 5

## Intent

Carry the Motion Studio backend through the product spec's phases 2 to 5 ([../motion-studio/spec.md](../motion-studio/spec.md)), extending the composition contract additively so the timeline UI and the renderers can build against it.

## Acceptance criteria

- AC-1: Phase 2. The contract carries transitions (clip-attached, token-named duration), camera presets (seeded, deterministic), text animators (`data-doop-split` + a compiled spec in `data-doop-motion`), and the mask/path property names; `frameStateAt` stays pure.
- AC-2: Phase 2 (motion-studio AC-3). `export_composition` returns CSS and WAAPI code for layer keyframes, transitions and text animators that a developer can paste, with token names kept.
- AC-3: Phase 2. A library Motion item carries its stored seek-safe verdict; `insert_clip` refuses a non-seek-safe item with the lint reason and lands a safe one on a clip track.
- AC-4: Phase 2. Render jobs accept `gif` and `pngseq`; uploads are sniffed (GIF89a, zip PK); the desktop encodes GIF through an ffmpeg palette.
- AC-5: Phase 2. `GET …/composition/versions` lists the last states and `POST …/versions/:id/restore` replaces the composition with one (one undo step, a new version of the replaced state). Comments anchor to a scene time range.
- AC-6: Phase 3. Media clips carry speed and cut ranges; `scene_media` persists trim, cuts, beats, transcript (word timings with optional speakers) and the generation recipe; captions are built from a transcript; ducking writes editable gain keyframes.
- AC-7: Phase 3. `generate_video` runs on the person's OpenRouter or Gemini account, stores the clip as an asset, and the layer keeps `{ provider, model, prompt, seed, cost }`.
- AC-8: Phase 3 (motion-studio AC-7, AC-11, AC-12). One-click install contract on both targets: a fixed engine catalog, server installs admin-only, every file hash-checked, custom models size/hash/licence-checked and disabled until a smoke test passes, Pocket TTS installs from the signed mirror.
- AC-9: Phase 3 (motion-studio AC-8, AC-10). `transcribe_clip` and `generate_voiceover` exist for MCP and the resident agent; cloud routes show cost first and run only on the person's own key; a local job sends nothing to a third party.
- AC-10: Phase 4. A glTF asset becomes a `3d` layer (three.js in a frame) with a fallback image; scroll-driven 3D uses the same keyframe data with a scroll driver; the Blender bridge relays approved tools only.
- AC-11: Phase 5 (motion-studio AC-6). `target: 'server'` renders through the renderer gate at background priority under the caps (60 s, 1080p, 30 fps, one render per account); Lottie imports and exports the vector subset; HyperFrames projects import and export; the motion duel produces competing takes of one storyboard.
- AC-12: All phases. `bun run typecheck`, the two linters, the motion tests and the parity test pass; docs/motion-api.md, docs/TECHSTACK.md, docs/FEATURES.md and this change's tasks.md/evidence.md are current.
