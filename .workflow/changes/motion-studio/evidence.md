# Evidence

Subject: `21cf86cfff64610bf5a53caf70d79b581b4e7a8d21d2ad4bb0850ce44220c5ed`

- AC-1: unverified — tests/motion.test.ts and tests/motionPhase2.test.ts pass in the 103-test targeted run. No rendered frame/snapshot observation was made in this continuation.
- AC-2: unverified — tests/motionHttp.test.ts covers render job lifecycle and upload sniffing. A real three-frame film export in a browser or built shell was not executed here.
- AC-3: unverified — tests/motionExport.test.ts and tests/motionPhase2.test.ts pass. Real consuming-page export validation remains pending; docs/motion-api.md describes transitions as export notes.
- AC-4: failed — Media helpers and REST tests pass, but a narrated walkthrough with real media playback/export was not completed. See tasks.md phase 3.
- AC-5: failed — Phase 4 is not implemented in this continuation; the preexisting bridge remains groundwork only. See tasks.md phase 4.
- AC-6: failed — Phase 5 server rendering and project interchange remain pending. See tasks.md phase 5.
- AC-7: failed — tests/speechHttp.test.ts proves owner/device-scoped relay, result validation and persisted timed words on PGlite. No desktop installer or actual sidecar exists; curated manifests are blocked until pinned and verified.
- AC-8: failed — tests/speechHttp.test.ts proves audio upload, recipe/transcript persistence and timeline insertion using simulated engine output. tests/speech.test.ts proves cloud adapter request shapes with simulated responses. Real local/cloud synthesis and voice consent lifecycle remain pending.
- AC-9: failed — Only the internal sidecar adapter is present. No actual service, resource-limit deployment or responsiveness benchmark was built or run.
- AC-10: failed — tests/speech.test.ts covers cloud request shapes, two simulated Scribe speakers and estimate acknowledgement. No live provider run or local diarization implementation was exercised.
- AC-11: failed — tests/speech.test.ts covers runtime, immutable revision, path, file size/hash and licence validation. Custom-model registration, downloads and smoke-test activation are still pending.
- AC-12: failed — No Pocket TTS mirror, preparation script, signed artifact verification or attribution UI was completed or published. All unverified catalog entries are unavailable to installers.

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
