# Evidence

Subject: `05d89398867bc6594a380b7ca40acbf047d040621a448587fddc025b1e05830d`

- AC-1: passed — tests/previews.test.ts: concurrent first-render edit stays stale for both callers; tests/thumbs.test.ts: renderedAt remains old; versioned object key assertions. tests/framePreviewHttp.test.ts: stale is no-store, current version immutable.
- AC-2: passed — tests/thumbs.test.ts: no-write move stays fresh; fresh-module restart reuses version/fingerprint ledger; persisted edit with lost notification is stale.
- AC-3: passed — tests/thumbs.test.ts: live invalidation persists again, purge during render/put cannot leave a current object, undo can persist after pending work, deletion concurrency stays four.
- AC-4: passed — tests/thumbLoader.test.ts and tests/framePreviews.test.ts: network/429/503, 60-second Retry-After, bounded attempts, stale retries, failure recovery on re-entry; browser 429 and stale scenarios pass.
- AC-5: passed — tests/framePreviews.test.ts: format comparison; byte/count limits, inactive subscribers, eviction on visible-holder release and subscriber notification. HTTP shape test checks actual transparent alpha.
- AC-6: passed — tests/framePreviews.test.ts: notifications flush once per frame. src/lib/framePreviews.ts retains decoded Image in entry; FrameImage has only the live-cover fade. Trace arrival maximum 15.572 ms.
- AC-7: passed — tests/framePreviewsBrowser.test.ts: painted pictures, no iframe, deferred stays deferred, stale/429, edit keeps old image then swaps, shape format, cover fades and leaves a live document. tests/frameImage.test.tsx: synchronous cover and three-second missing-runtime expiry.
- AC-8: passed — tests/framePreviewHttp.test.ts: real HTTP immutable fresh stage, short cache for old/missing versions and dashboard, stale no-store, invalid lod 400; shape returned as transparent PNG under initial jpg ask.
- AC-9: passed — tests/framePreviewPerformance.test.ts passed, 200 real cold server renders with production client fixture, 1440x900 dpr1. /tmp/zoom-first-out-metrics.json: longest first zoom-out 46.023 ms, arrivals 15.572 ms, zero tasks over 50 ms, 200 pictures and zero iframes. /tmp/zoom-first-out-trace.json retains trace. Mutation completion avoids polling overhead; fixture supplies canvas/session/room, not image bytes.
- AC-10: passed — Typecheck and required type-aware lint/ESLint exit 0; 11 relevant test files / 106 tests pass plus performance file / 1 test; doc-lint passed. Standing docs and /tmp/pr-drafts/zoomed-out-frames.md updated. Changed-file formatting is checked before commit; no publication or container build.

## Verification run

2026-11-16. Required typecheck, type-aware lint and ESLint exited 0. The final affected functional run passed 106 tests in 11 files; the separate performance run passed one test. No test was skipped with CHROME_PATH set to the locally cached browser. Rust was not changed.

Commands:

```sh
bun run typecheck
bunx vitest run tests/framePreviewsBrowser.test.ts tests/framePreviewHttp.test.ts tests/frameLodBrowser.test.ts tests/frameLod.test.ts tests/frameImage.test.tsx tests/framePreviews.test.ts tests/thumbLoader.test.ts tests/thumbs.test.ts tests/previews.test.ts tests/mcpScreenshotCache.test.ts tests/renderBrowser.test.ts --maxWorkers=2
bunx vitest run tests/framePreviewPerformance.test.ts --maxWorkers=2
bun run doc-lint
```

Type-aware lint used the worktree exclusion requested in the brief; ESLint used `--max-warnings 0`.

Logs: `/tmp/zoom-final-tests.log`, `/tmp/zoom-performance-final.log`. The full workflow snapshots are in `/tmp/zoom-workflow-state-full.json`; committed state retains digests to avoid duplicating unrelated repository paths. A future archive should take a new snapshot and check first. The requested change folder remains available for review rather than being archived away.

All five implementation tasks are complete. `tasks.md` retains its approved plan verbatim because its checkbox text is part of the contract digest; completion is recorded here and in the AC results. Changed-file Prettier verification and the final doc-lint run passed.

## Review disposition

Findings 1–13 and 15–17: fixed. Finding 14: deferred; position moves still change the client URL and may re-download the same picture, but do not re-render. A persisted design-version field would broaden the frame contract. Detailed per-finding evidence and measurement protocol: `/tmp/pr-drafts/zoomed-out-frames.md`.

## Performance and limits

200 cold real image renders, production client fixture, 1440×900 dpr1: first zoom-out longest task 46.023 ms, zero tasks over 50 ms, summed task time 1753.937 ms. From the first picture response: longest 15.572 ms, zero tasks over 50 ms, summed task time 1670.116 ms. All 200 pictures displayed; zero frame iframes. Raw metrics and trace are `/tmp/zoom-first-out-metrics.json` and `/tmp/zoom-first-out-trace.json`. The fixture supplies the canvas/session/room; the server, storage and image bytes are real. This is a local observation, not WebKit/touch validation or a claim of instant cold rendering.

The earlier animation-frame polling probe recorded 83.609 ms / two long tasks. Trace inspection showed the probe callback inside both long tasks. The final mutation-driven probe removes that observer cost; it does not exclude slow application tasks.

Storage persistence is best-effort. A lost/corrupt ledger or failed persist can require regeneration. Legacy objects migrate on demand. A crash between writing an object and updating the ledger can leave an orphan version. The 64 MiB client budget counts compressed blobs; visible holders can exceed it until released, and it is not a total browser/GPU memory limit.
