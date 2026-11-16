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

## Phase 3 — media, speech and generation

Checked 2026-02, branch `feat/motion-backend-next`.

| Check                                                                                                                                                         | Result                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun run typecheck`                                                                                                                                           | pass                                                                                                                           |
| `bunx vitest run` on the media/speech suites (`tests/motionMedia.test.ts`, `tests/speech*.test.ts`, `tests/speechCustom.test.ts`, `tests/motionHttp.test.ts`) | pass                                                                                                                           |
| `cargo test` in `desktop/src-tauri`                                                                                                                           | 105 pass, incl. `speech::tests` (path rejection, pubkey decode, Blake2b RFC-7693 vectors, minisig shape, sha256, sums parsing) |
| `scripts/prepare-speech-mirror.sh` against `hf-internal-testing/tiny-random-bert`                                                                             | end-to-end pass (SHA256SUMS + ATTRIBUTION produced)                                                                            |

AC-6 — `scene_media` rows (migration 0073) carry speed/fades/cuts/beats, the
transcript and the generation recipe; captions come off the transcript and
ducking keyframes are editable (`shared/motionMedia.ts`, routes + parity).

AC-7 — `generate_video` resolves `openrouter-key` and `gemini-key` accounts
(`server/videoModels.ts` + shared catalog); the recipe persists on the media
row. Live provider calls unverified (no keys in CI).

AC-8 — the fixed engine catalog (`shared/speech.ts`), admin-only installs on
the server, per-file verification and custom-model smoke gating land in
`server/speech*.ts` (migrations 0074–0076); the desktop bridge
(`desktop/src-tauri/src/speech.rs`) installs catalog entries through the
signed GitHub mirror (Ed25519 + minisign BLAKE2b-512 prehash against the
updater key) or pinned Hugging Face commits, hash-checks and resumes
downloads, and runs the `diazo-speech` sidecar — **not yet built or
published**. The Pocket TTS mirror doc + script
(`docs/speech-mirror.md`, `scripts/prepare-speech-mirror.sh`) produce a
signed release locally but **no weights are published** (upstream repo is
gated; needs a maintainer's `HF_TOKEN`).

AC-9 — MCP and resident share `server/speechTools.ts`; cloud routes
estimate cost before spending on the user's own key; local jobs never leave
the desktop. Real model listening tests unverified.

## Phase 4 — 3D and Blender

Checked 2026-02, branch `feat/motion-backend-next`.

| Check                                                                         | Result       |
| ----------------------------------------------------------------------------- | ------------ |
| `bun run typecheck`                                                           | pass         |
| `bunx vitest run tests/blender.test.ts tests/motion.test.ts` (+motion suites) | 26 + 63 pass |
| `bun run doc-lint`                                                            | pass         |

AC-10 — `MotionClipSource` accepts `{ type: '3d', assetId, fallbackAssetId?,
driver? }` with `time`/`scroll`/`pointer` drivers (`data-doop-driver`);
`RENDER_TARGETS` gained `blender` with `engine` validated against
`BLENDER_ENGINES` (eevee/cycles/octane — Octane is only an engine name).
The op relay queues server-side (`server/blenderOps.ts`, migration 0077
`blender_ops`), the desktop shell claims it and runs the allowlisted
blender-mcp process behind read/write/render grants
(`desktop/src-tauri/src/blender.rs`); MCP and resident share
`server/blenderTools.ts`. End-to-end against a real Blender unverified.

## Phase 5 — server renders and interchange

Checked 2026-02, branch `feat/motion-backend-next`.

| Check                                                                                    | Result  |
| ---------------------------------------------------------------------------------------- | ------- |
| `bun run typecheck`                                                                      | pass    |
| `bunx vitest run tests/motionPhase5.test.ts tests/motionHttp.test.ts tests/duel.test.ts` | 32 pass |

AC-11 — `target: 'server'` renders through the renderer gate at background
priority (`server/motionRender.ts`): webm/pngseq only, ≤60 s, ≤1080p,
≤30 fps, one open render per account (429), `SERVER_RENDER_DISABLED` for
instances without headless Chromium (503). The worker mints a signed
better-auth session row to load the `/c/<id>/motion-render` harness and
deletes it on every path out; results land as `/a/` assets.
Lottie (`compositionToLottie`/`lottieToTracks`) and HyperFrames
(`compositionToHyperframes`/`hyperframesToTracks`) interchange covers the
transform subset only — position, scale, rotate, opacity on element
tracks — with malformed or foreign documents rejected at
`POST …/composition/import`; export rides `?format=` on the code-export
route. The motion duel (`POST …/motion-duels`, `kind: 'motion'` on
`model_duels`, migration 0078) duplicates the storyboard page once per
pick, queues one scoped card each and archives every frame of the losing
pages on pick. A real headless server render end-to-end is unverified —
the caps, route, worker plumbing and ZIP writer are tested.

Covered by `tests/motionPhase5.test.ts` (caps, `zipStore`, both converters,
duel copy/pick) and the phase-5 describes in `tests/motionHttp.test.ts`
(interchange routes, motion-duel route).
