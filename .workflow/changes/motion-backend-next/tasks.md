# Tasks — Motion Studio backend, phases 2 to 5

Built on `feat/motion-backend-next` (from `dev`), worktree `doop-wt/motion-next`.

## Phase 2 — timeline depth and code export

- [x] 1. Contract: transitions on clips, camera presets (seeded), text animators (`data-doop-split`, `animators` in `data-doop-motion`), mask/path properties.
- [x] 2. CSS and WAAPI code export (`export_composition`, token names kept).
- [x] 3. GIF and PNG-sequence render formats (contract, upload sniffing, desktop ffmpeg).
- [x] 4. Library clip seek-safe verdict and `insert_clip`.
- [x] 5. Scene version list/restore and time-range comments.
- [x] 6. Resident tools, parity, motion-api.md.

## Phase 3 — media, speech and generation

- [ ] 7. Media contract: `scene_media`, clip speed/fades/cuts, beats, transcript, generation recipe, ducking, captions from transcript.
- [ ] 8. `generate_video` on OpenRouter and Gemini.
- [ ] 9. Speech: catalog, installs, jobs, preferences, voices, REST.
- [ ] 10. Speech: desktop bridge (`desktop/src-tauri/src/speech.rs`).
- [ ] 11. Speech: cloud transcription (ElevenLabs Scribe, OpenAI), ElevenLabs voice-over, custom models, MCP tools, `diazo-speech` sidecar client.
- [ ] 12. Pocket TTS mirror: design doc and script (not published).

## Phase 4 — 3D and Blender

- [ ] 13. Contract: `3d` clips, glTF→three.js layer, scroll/pointer drivers, fallback image.
- [ ] 14. Blender bridge: approvals, write/render tools, `blender_*` agent tools, blender render target.

## Phase 5 — server renders and interchange

- [ ] 15. Server renders through the renderer gate (60 s / 1080p / 30 fps / one per account).
- [ ] 16. Lottie import and export (vector subset).
- [ ] 17. HyperFrames project import and export.
- [ ] 18. The motion duel.

## Close

- [ ] 19. TECHSTACK.md, FEATURES.md, CHANGELOG; evidence.md; final report.
