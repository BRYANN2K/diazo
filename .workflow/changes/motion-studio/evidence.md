# Evidence

Subject: `21cf86cfff64610bf5a53caf70d79b581b4e7a8d21d2ad4bb0850ce44220c5ed`

- AC-1: unverified — tests/motion.test.ts and tests/motionPhase2.test.ts pass in the 103-test targeted run. No rendered frame/snapshot observation was made in this continuation.
- AC-2: unverified — tests/motionHttp.test.ts covers render job lifecycle and upload sniffing. A real three-frame film export in a browser or built shell was not executed here.
- AC-3: unverified — tests/motionExport.test.ts and tests/motionPhase2.test.ts pass. Real consuming-page export validation remains pending; docs/motion-api.md describes transitions as export notes.
- AC-4: unverified — Media helpers and REST tests pass; a narrated walkthrough with real media playback/export was not completed.
- AC-5: unverified — Phase 4 is implemented on this branch: `data-doop-driver` clips, the `blender` render target and engine check, the `blender_ops` relay, and the shell's per-origin grants and native approval. Unit tests pass; a real Blender and the native dialog were never exercised.
- AC-6: unverified — Phase 5 is implemented on this branch: server renders behind the request guard and caps, the deterministic WebCodecs webm driver with an `ffprobe`-verified muxer, Lottie and HyperFrames interchange, and the motion duel. Unit tests pass; no render ran in a real Chromium.
- AC-7: unverified — the desktop install contract is implemented and tested: `speech_install` verifies per-file size and SHA-256 against the signed mirror manifest or a pinned HF commit, `speech_choose_files` stages `local` picks, and the shared `SPEECH_LIMITS` table holds server and shell equal (`tests/speechContract.test.ts`, Rust stage/read and `local` tests). One-click install on a real Mac and a 10-minute French clip were never run; the sidecar binary is not built.
- AC-8: unverified — ElevenLabs voice-over on the person's own key with the estimate gate is implemented and unit-tested (`tests/speech.test.ts`, `tests/speechHttp.test.ts`); the Mac studio voices and a real Pocket TTS run were never exercised.
- AC-9: unverified — only the internal sidecar adapter exists (`DOOP_SPEECH_URL`); no service, resource-limit deployment or benchmark was built or run.
- AC-10: unverified — Scribe/OpenAI adapters on the person's own key and the cost estimate are implemented and unit-tested. No live provider run or local diarization was exercised.
- AC-11: unverified — registration validates runtime, pinned commit, flat file names, the shared size caps, per-file SHA-256 and licence acknowledgement; smoke-test gating is covered by `tests/speechCustom.test.ts` and the shell's `local` install by Rust tests. A real download and smoke test were never run.
- AC-12: unverified — the mirror script produces a signed release locally; no `speech-models-v*` release is published and no weight is mirrored yet.

## Continuation verification, 2026-11-16

- `bun run typecheck`: passed.
- `bunx oxlint --type-aware --deny-warnings --ignore-pattern '.claude/**' . && bunx eslint . --max-warnings 0`: passed.
- `bunx vitest run tests/speech.test.ts tests/speechHttp.test.ts tests/agentRunners.test.ts tests/agentToolParity.test.ts tests/env.test.ts tests/motion.test.ts tests/motionPhase2.test.ts tests/motionExport.test.ts tests/motionMedia.test.ts tests/motionHttp.test.ts --maxWorkers=2`: 10 files, 103 tests passed.
- `bun run doc-lint`: passed with zero warnings.
- PGlite applies migrations 0074–0076 in the integration harness; real Postgres migration execution remains unverified.
- No Rust source was changed in this continuation. Cargo tests and a built desktop shell were not run; the inherited desktop changes remain unverified here.
- No real provider calls, model downloads, container builds, publication, push or pull request. Provider unit tests use simulated responses. HTTP tests use synthetic media and simulated desktop engine results.
- The initial environment documentation test found the inherited video endpoint variables missing from `.env.example`; both are now documented and the test passes.
- The initial formatter check found generated migration snapshots and two new source/test files needing formatting; they were formatted before the final checks.
- The original `motion-studio` state was still exploring with no recorded approval. The explicit continuation instruction authorized the existing brief; the proposal and acceptance criteria were not changed. Adding the tracking tasks changed the workflow digest, which was rebound to the same authorization. The change remains applying, with unmet criteria retained above.
- New contract: `docs/speech-api.md`. Remaining work: `tasks.md`.

## Second review pass, 2026-11-17

- Lines AC-5 through AC-12 above were re-read against the branch: phases 4 and 5 and the speech backend are implemented and unit-tested on `feat/motion-backend-next`; what remains unproven is every real run — real Blender, real Chromium render, a real Mac install, a live provider call and the unbuilt sidecar.
