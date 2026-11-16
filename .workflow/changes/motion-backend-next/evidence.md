# Evidence

## Phase 2 — timeline depth and code export

Checked 2026-02, branch `feat/motion-backend-next`.

| Check                                                                                                                      | Result                 |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `bun run typecheck` (tsgo)                                                                                                 | pass                   |
| `bunx oxlint --type-aware --deny-warnings .` + `bunx eslint . --max-warnings 0`                                            | pass                   |
| `bunx prettier --check` on changed files                                                                                   | pass (files formatted) |
| `bunx vitest run tests/motionPhase2.test.ts tests/motionExport.test.ts tests/motion.test.ts tests/agentToolParity.test.ts` | 43 pass                |
| `bunx vitest run tests/motionHttp.test.ts`                                                                                 | 11 pass                |
| `cargo test` in `desktop/src-tauri`                                                                                        | 7 pass (`motion::*`)   |
| `bun run doc-lint`                                                                                                         | pass                   |

AC-1 — transitions on clips (`update_clip` accepts/clears via `null`), camera presets
seeded in `shared/motionPresets.ts`, text animators via `data-doop-split` +
`animators` in `data-doop-motion` compiled by `expandTextAnimator`, mask/path
properties (`clipPath`, `offsetPath`, `offsetDistance`, `d`, …) lerp in
`interpolate()`; `frameStateAt` unchanged and pure. Covered by
`tests/motionPhase2.test.ts` + `tests/motion.test.ts`.

AC-2 — `shared/motionExport.ts` compiles the composition to `composition.css`
(`@keyframes`, `var(--*)` token names kept) and `composition.js` (WAAPI
`element.animate`, camera targeting `[data-doop-world]`); transition pairing
notes per clip. Exposed at `GET …/composition/export` and through the
`export_composition` tool (MCP + resident). Covered by
`tests/motionExport.test.ts` (5) and the HTTP export test.

AC-3 — `lint_motion` with `library_id`+`item_id` lints the item's motion block
and stores `seekSafe`/`seekSafeFindings`/`seekSafeAt` on `library_item_meta`
(migration 0072). `insert_clip` refuses `issues` items with the findings and
inserts safe items onto a clip track via `add_clip`. Covered in
`tests/motionHttp.test.ts` and `tests/agentToolParity.test.ts`.

AC-4 — `RENDER_FORMATS` gained `gif`/`pngseq`; uploads sniff `GIF8` and zip
`PK\x03\x04` in `server/motionJobs.ts`; desktop encodes GIF through ffmpeg's
two-pass palette (`palettegen`/`paletteuse`) and writes PNG sequences as a
dependency-free store-only zip (`desktop/src-tauri/src/motion.rs`,
`motion_render.rs`). Covered by `tests/motionHttp.test.ts` and Rust tests
`gif_two_pass`, `zip_store_writes_a_valid_archive`.

AC-5 — `GET …/composition/versions` lists newest-first (cap 20) and
`POST …/versions/:id/restore` replaces the composition while filing the
replaced state as a new version (undoable). Comments accept
`timeStart`/`timeEnd` validated against the composition duration and persist
in `comments.time_start/time_end`. Covered by `tests/motionHttp.test.ts`.

AC-12 (phase-2 portion) — all checks above pass; `docs/motion-api.md`
documents transitions, animators, presets, versions/restore, export,
scene-time comments, `gif`/`pngseq` sniffing, MO-12, and the tool surface.
