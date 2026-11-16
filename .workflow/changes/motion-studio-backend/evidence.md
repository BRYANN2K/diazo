# Evidence

Recorded 2026-11-17 on `feat/motion-backend-next` after the review fixes of 2026-11-16/17.

| AC    | Result     | Evidence                                                                                                                                                                                                                        |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | passed     | `tests/motion.test.ts` (parsers and validation) passes.                                                                                                                                                                         |
| AC-2  | passed     | `tests/motionHttp.test.ts` passes; `PUT` and `PATCH …/composition` answer 200 with revisions.                                                                                                                                   |
| AC-3  | passed     | `tests/motion.test.ts` runtime cases; `tests/motionElementCss.test.ts` reads `frameStateAt` for element tracks.                                                                                                                 |
| AC-4  | passed     | `tests/motion.test.ts` lint cases (`MO-*`).                                                                                                                                                                                     |
| AC-5  | unverified | Covered by `tests/motionHttp.test.ts` on PGlite; the renumbered migrations (0074–0080) were not exercised against a real Postgres here.                                                                                         |
| AC-6  | passed     | `tests/motionHttp.test.ts` room cases.                                                                                                                                                                                          |
| AC-7  | passed     | `tests/motionServerRender.test.ts` (12 tests) covers the worker: render-scoped tokens, the request guard, seconds seeks, frame-by-frame WebM, incremental caps, the on-disk zip. `sniffVideoMime` gates uploads.                |
| AC-8  | passed     | MCP and resident tool tests pass; tool schemas bound `first_frame`/`last_frame`/`refs` and `generate_video` refuses to run without a connected payer.                                                                           |
| AC-9  | unverified | The render page answers `__doopMotionSeek`/`__doopMotionCapture` and Rust `motion::tests` pass under `cargo test` (110 tests), but no render ran inside a live desktop shell here.                                              |
| AC-10 | passed     | `blender::tests` pass under `cargo test`: per-origin grants, strict args, no caller filepath. `blender_approve` requires a native dialog; renders land under `<appData>/blender-renders`. Still gated on `DOOP_BLENDER_BRIDGE`. |
| AC-11 | unverified | Affected tests pass here (`motionServerRender`, `env`, `blender`, `motionPhase5`: 37 tests); `cargo test` passes (110 tests); the full bun suite was not re-run in this pass.                                                   |
