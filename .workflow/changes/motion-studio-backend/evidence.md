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

## Addendum — 2026-11-16, `fix/animate-storyboard-elements`

"Animate storyboard" produced camera keys only: the button's prompt asked only
for camera moves and nothing extracted the frames' shot notes. Fix:

- `server/storyboard.ts` (new): per-frame analysis — the notes blocks
  (mouvement / transition / son / voix off / notes, or the English words, by
  text or by markup) and the animatable elements, `data-doop-id`s stamped in
  one pass (`server/elementIds.ts` `stampElements`) and committed like a
  comment stamp (`server/actions.ts` `commitElementStamps`, shared with
  `ensureElementId`).
- `animate_storyboard` returns `shots[].notes` and `shots[].targets`; writes
  carry `storyboard` — the notes check (noted shots still without an element
  track, two fix passes).
- `server/guide.ts` MOTION and the `animatePrompt` strings (en, pt-BR) now
  tell the agent to animate every shot per its notes.

Evidence: `tests/storyboard.test.ts` (17 cases with `storyboardAgent.test.ts`:
FR/EN extraction, targets, stamping, coverage, fix passes, resident execTool),
`tests/motionHttp.test.ts` MCP case extended — notes, targets, stamped ids on
disk and the clearing write all pass on the real server.

## Addendum — 2026-11-17, review fixes on `fix/animate-storyboard-elements`

Code review of the addendum above found false positives and wrong counting;
fixed in place:

- Note detection narrowed to real labels only: a label + `:`/`：`, or an
  all-caps label + spaced dash; bare labels pair with the sibling holding
  the text; markup panels only via `data-doop-notes` or a `class`/`id`
  token equal to or prefixed `shot-notes`/`notes`/`voix-off`/`voice-over`.
  Tailwind classes, aria-labels, data-name and headline copy are never
  notes, and no label can promote `body`. Notes sharing a notes-only
  ancestor report it as `panelId` — the bar, title row included.
- The notes check is scoped to the composition and the run's shots
  (`frame_ids`); a shot clears only on an element track with keyframes on
  a real, non-notes element of its frame — the notes-hiding track, unknown
  ids and muted tracks do not count. `pass` counts consecutive no-progress
  rounds, not writes; progress, a rebuilt film and a rewritten timeline
  reset it. Frame reads cached by `updatedAt`.
- Guide/prompts only name mechanisms the model has (element/camera
  keyframes, caption tracks + clips, muted lanes); notes are framed as the
  intent and the minimum, and the agent reports where it went beyond them.
- `stampElements` dedupes input and re-verifies every fresh id like
  `stampElementId`; `commitElementStamps` keeps the caller's actor kind.

Evidence: `tests/storyboard.test.ts` (25 cases), `tests/storyboardAgent.test.ts`
(14: false positives, streaming, failed write, sign-off, idempotence,
frame_ids scoping, pass counter, wording), `tests/motionHttp.test.ts`.
`bun run typecheck`, oxlint `--type-aware --deny-warnings`, eslint
`--max-warnings 0`, `doc-lint`, `format:check` — all clean.
