# Evidence

Recorded 2026-11-16 on `feat/frontend-redesign`, which merged `feat/motion-backend` (`2fdd8c6b`) and `origin/dev` (`cda02310`).

| AC    | Result     | Evidence                                                                                                                                                                                                     |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-1  | passed     | `tests/motion.test.ts` (parsers and validation) passes.                                                                                                                                                      |
| AC-2  | passed     | `tests/motionHttp.test.ts` passes; local run: `PUT` and `PATCH …/composition` answered 200 with revisions.                                                                                                   |
| AC-3  | passed     | `tests/motion.test.ts` runtime cases; `tests/motionElementCss.test.ts` reads `frameStateAt` for element tracks.                                                                                              |
| AC-4  | passed     | `tests/motion.test.ts` lint cases (`MO-*`).                                                                                                                                                                  |
| AC-5  | unverified | Covered by `tests/motionHttp.test.ts` on PGlite; migration 0071 not exercised against a real Postgres here.                                                                                                  |
| AC-6  | passed     | `tests/motionHttp.test.ts` room cases; local run: the timeline followed `composition` messages and showed playheads.                                                                                         |
| AC-7  | passed     | Local run: a WebM render job went queued → rendering → done and landed as `/a/<id>.webm` (VP9, 6.18 s); `tests/motionHttp.test.ts` lifecycle (asset id regex widened in `218b63b1`).                         |
| AC-8  | passed     | MCP and resident tool tests in the full suite pass. The resident's `animate_storyboard` was not reached locally: no model account (`403 resident_limit`).                                                    |
| AC-9  | unverified | `cargo check` passes; the render page answers `__doopMotionSeek` / `__doopMotionCapture`, but no render ran in a desktop shell and the Rust `motion::tests` were not run.                                    |
| AC-10 | unverified | Not exercised; `blender::tests` not run.                                                                                                                                                                     |
| AC-11 | failed     | `tests/motion.test.ts` and `tests/motionHttp.test.ts` pass; Rust tests not run; the full suite still has two failures outside Motion (`tests/customProvider.test.ts`, `cli/test/server.test.ts` under load). |
