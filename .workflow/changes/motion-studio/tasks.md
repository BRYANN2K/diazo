# Tasks — Motion Studio backend, phases 2–5

Status: partial, updated 2026-11-16

The continuation follows the existing five commits on `feat/motion-backend-next`.
Implementation checkboxes below describe code present, not full acceptance of a phase.

## Phase 2 — existing commits

- [x] Camera presets, text animators, transitions and path properties (`0af8363c`).
- [x] Desktop GIF and PNG sequence encoding (`b40ede34`).
- [x] CSS/WAAPI export, scene versions and library Motion checks (`aacccb41`).
- [ ] Verify the exported transitions and masks in a real consuming page, and render GIF/PNG sequences in a built shell.

## Phase 3 — media and speech

- [x] Media rows, clip speed, captions, ducking and transcript-cut helpers (`a6cc4f66`).
- [x] Video generation contract and adapters on connected user accounts (`40bddfce`).
- [x] Finish the pending speech schema and shared contract; persist requests and enforce one active job per user.
- [x] Authenticate REST speech routes; scope jobs to the requester, canvas and claiming desktop device.
- [x] Share speech tool definitions and execution between MCP and resident tools; retain parity coverage.
- [x] Add cloud adapter request tests, explicit cost acknowledgement, preferences and fail-closed local routing.
- [x] Store validated transcripts transactionally; store voice-over audio and insert an audio clip retaining its recipe.
- [x] Fail interrupted jobs without replaying provider requests; preserve cancellation on late completion.
- [ ] Desktop installer, resumed downloads, SHA-256 and signed releases, native file picker, Metal engine worker and smoke tests.
- [ ] Actual server speech sidecar, admin model management, progress polling, CPU/memory/PVC limits and responsiveness benchmark.
- [ ] Resolve and verify immutable curated manifests; keep approximate catalog rows unavailable for installation meanwhile.
- [ ] Custom-model registration and activation after a smoke test, gated tokens, voice consent and private samples.
- [ ] Local diarization, speaker editing, cloud text-only transcripts and alignment.
- [ ] Pocket TTS mirrored-release design, preparation script, attribution and signature verification; do not publish.
- [ ] Ten-minute French transcription on both local targets, listening tests and authorized live cloud checks.
- [ ] Verify media playback/export consumes cuts, speed, audio gain and ducking end to end; generated image layers retain prompts.

## Phase 4

- [ ] Contract and native approval for a real allowlisted Blender bridge.
- [ ] glTF/GLB frame layers, timeline 3D and scroll-driven 3D.
- [ ] Eevee/Cycles final rendering on the desktop; optional Octane through Blender.

## Phase 5

- [ ] Server render worker through the renderer gate, caps and one active render per account.
- [ ] Lottie vector-subset import/export.
- [ ] HyperFrames project import/export.
- [ ] Motion duel.

## Verification

- [x] Reconcile every acceptance criterion against fresh evidence; retain unverified status for absent engines and renderers.
- [ ] Verify migrations against real Postgres as well as PGlite.
