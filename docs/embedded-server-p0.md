# Embedded server P0 — spike and baseline

Status: P0 results, measured 2026-11-17 on commit `394892f2` (`feat/embedded-server-spike`).

The P0 question: does the server run as one esbuild bundle (`server.mjs`) under plain Node 22
with PGlite and no `DATABASE_URL`, and how does that install compare to the container install
it would replace (`ghcr.io/bryann2k/diazo:main`)? Answer: yes, and it is faster or equal on
every measured metric except cold render, where it is within noise.

## Machine

- Apple M4, 24 GB RAM, macOS 27.0 (arm64). Node v22.23.1, Bun 1.3.14.
- Container side: Apple `container` 1.0 (Docker daemon unavailable — `docker` CLI exists, no
  daemon). The image ran as linux/arm64, its native arch on this machine.
- Renderer for the bundle: Chrome for Testing 157.0.8103.50 (`CHROME_PATH`). The image uses
  its bundled Debian Chromium.

## What was built

- `scripts/build-server-bundle.ts` (`bun run build:server-bundle`): esbuild →
  `out/embedded-server/` with `server.mjs`, `node_modules/` (only `sharp` and
  `@electric-sql/pglite`, native files included), `migrations/`, `backgrounds.json`, `dist/`.
  `--os linux --cpu x64|arm64` stages the other platforms' native packages via
  `bun add --os --cpu` (npm's same flags skip the optional `@img/*` packages entirely).
- Env switches added in `server/env.ts` and honoured by the server: `DOOP_DATA_DIR` (PGlite,
  assets, legacy `store.json`), `DOOP_DIST_DIR`, `DOOP_MIGRATIONS_DIR`, `DOOP_LISTEN_HOST`
  (bind `127.0.0.1` for embedded; unset keeps the container's all-interfaces behaviour).
- `.github/workflows/embedded-spike.yml`: workflow-dispatch only, builds and boots the
  bundle on `ubuntu-latest`, `macos-latest`, `windows-latest`, hits `/healthz`, then signs up
  and writes a canvas. **Not run** — the branch is not pushed.
- `scripts/bench-local.ts`: takes a base URL plus optional `--spawn`/`--stop` commands;
  seeds 3 canvases, 200 frames, 300 assets over REST; measures cold start, API, room join,
  cold/warm renders, append chunks, uploads, idle RSS; 10 runs, median + p95. No model call.

Two bundling traps worth keeping in mind for P1: esbuild's own `createRequire` import means a
banner must not redeclare it, and `drizzle-orm/node-postgres` must stay external — bundling
it hoists `import 'pg'` to the top of `server.mjs`, which then resolves eagerly and kills the
boot on a bare install dir even though PGlite never touches `pg`.

## Boot status

| System                                     | Booted      | How verified                                                                             |
| ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------- |
| macOS arm64 (this machine)                 | yes         | `node out/embedded-server/server.mjs`, `/healthz`, sign-up + canvas write, loopback only |
| linux arm64 (Apple `container`, `node:22`) | yes         | bare `/bundle` mount, `/healthz`, sign-up 401→cookie path checked                        |
| linux x64 (same, `--platform`)             | yes         | same checks                                                                              |
| Windows                                    | not checked | workflow file only; cannot push the branch                                               |

Each boot seeds the demo canvas and the 126-background catalogue; the benchmark dataset
(3 canvases / 200 frames / 300 assets) loads through the same paths.

## Bundle sizes (measured, replaces plan §2.12 estimates)

| Part                                    | darwin-arm64 | linux-x64 / arm64 |
| --------------------------------------- | ------------ | ----------------- |
| `server.mjs`                            | 12.9 MB      | 12.9 MB           |
| `node_modules` (sharp + PGlite, native) | 41.8 MB      | 59.1 MB           |
| `migrations/`                           | 6.7 MB       | 6.7 MB            |
| `dist/` (web)                           | 24.4 MB      | 24.4 MB           |
| `backgrounds.json`                      | 0.1 MB       | 0.1 MB            |
| **Total**                               | **85.8 MB**  | **103.1 MB**      |

Plan §2.12 estimated 25–35 MB for "server bundle, PGlite, sharp, migrations, web `dist/`";
measured is ~3× that, driven by uncompressed `dist/` (24 MB), the PGlite WASM+data payload and
the migration SQL. A zipped installer will shrink this substantially; the Node 22 binary
(~30–45 MB, still an estimate) and the first-use renderer download (~90 MB) come on top.
macOS stays dominated by the existing ~600 MB Chromium payload; the Windows/Linux delta is
real but small next to it.

## Benchmarks

Dataset: 3 canvases, 200 frames on the bench canvas, 300 assets, written once over REST
(`bench-local.ts`; data dir ≈ 48 MB after the run — 42 MB PGlite, 6.5 MB assets).
"n" is samples; median / p95 in ms unless noted. Render requests carry the session cookie —
anonymous `/i/` renders are capped at 12/min per IP by design, and a desktop user is signed
in anyway.

### Embedded bundle — `node out/embedded-server/server.mjs`, loopback, PGlite

| Metric                               | n   | median  | p95     | min    | max     |
| ------------------------------------ | --- | ------- | ------- | ------ | ------- |
| cold start → /healthz (restarts)     | 10  | 1032 ms | 1333 ms | 822 ms | 1333 ms |
| first boot, empty data dir           | 1   | 1.5 s   | —       | —      | —       |
| `GET /api/canvases/:id` (200 frames) | 30  | 4.5     | 6.1     | 3.9    | 10.0    |
| room join, init with all HTML        | 10  | 4.5     | 10.8    | 4.0    | 10.8    |
| render `/i/*.png` cold               | 50  | 252     | 286     | 232    | 644     |
| render `/i/*.png` warm               | 50  | 0.3     | 0.8     | 0.1    | 1.1     |
| `append` chunk                       | 100 | 1.2     | 2.1     | 1.0    | 8.3     |
| asset upload                         | 50  | 2.5     | 3.4     | 1.8    | 6.6     |
| idle RSS, node only                  | —   | 159 MB  | —       | —      | —       |

### Container baseline — `ghcr.io/bryann2k/diazo:main`, linux/arm64 in Apple `container`

Same dataset and harness; `--spawn 'container start diazo-bench'`, so "cold start" is a
stopped-container start, not a fresh VM.

| Metric                                           | n   | median  | p95     | min     | max     |
| ------------------------------------------------ | --- | ------- | ------- | ------- | ------- |
| cold start → /healthz (`container start`)        | 10  | 2480 ms | 2586 ms | 2260 ms | 2586 ms |
| first boot, fresh container + VM                 | 1   | ~5.0 s  | —       | —       | —       |
| `GET /api/canvases/:id` (200 frames)             | 30  | 6.4     | 7.9     | 5.2     | 13.4    |
| room join                                        | 10  | 6.4     | 18.1    | 5.7     | 18.1    |
| render `/i/*.png` cold                           | 50  | 219     | 252     | 197     | 587     |
| render `/i/*.png` warm                           | 50  | 0.5     | 1.0     | 0.3     | 1.5     |
| `append` chunk                                   | 100 | 1.9     | 4.9     | 1.2     | 11.7    |
| asset upload                                     | 50  | 2.8     | 4.6     | 2.3     | 27.1    |
| idle memory, whole container (`container stats`) | —   | 581 MB  | —       | —       | —       |

### Memory, honestly

- Embedded idle RSS of the node process alone: **159 MB** right after the bench (idle
  canvases evicted). With the 200-frame canvas resident and the render browser up, the
  process tree measured **~670 MB** (node ~440 MB + Chromium ~230 MB) — the store keeps
  loaded frame HTML in memory, as it does in the source install.
- The container's 581 MB counts its whole VM (node + renderer + init). The "2× lower idle"
  target from plan §3 is **not** met once a canvas is loaded; the installs are roughly even.
  What the bundle buys instead is startup, disk footprint and no container runtime.
- Observed leak risk for embedded mode: ~16 orphaned headless-Chrome processes (ppid=1, up to
  2 days old, ~45 MB each) sat on this machine from earlier kills of dev servers. A sidecar
  that dies without reaping its render browser leaves real memory behind — P2 should track it.

### Verdicts against plan §3 targets

| Target                          | Result                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| cold start < 2 s                | pass — 1.03 s median                                                                                                            |
| ≥ 2× faster than the container  | pass — 2.4× (1032 vs 2480 ms)                                                                                                   |
| idle memory ≥ 2× lower          | fail — roughly even (159–670 MB vs 581 MB), see above                                                                           |
| everything else equal or better | pass — API, join, append, upload, warm render all better; cold render 252 vs 219 ms is within noise (different Chromium builds) |

## Go / no-go — Node + esbuild + PGlite

**Go.** The build shape works on every system it could be checked on, boots in ~1 s, and the
only bundling bugs found (eager `pg` import, skipped platform packages) are fixed in
`build-server-bundle.ts`, not in the architecture.

On the three PGlite risks the plan called out:

- **Single connection.** One in-process PGlite serializes queries. At bench scale nothing
  queued visibly: 200-frame reads at ~4.5 ms, writes at 1–3 ms, all while seeding, describing
  and rendering share the same connection. A desktop install is one user plus the resident
  agent; the risk stays theoretical until a real workload multiplexes it — worth revisiting
  if P2+ adds background jobs that write while the user works.
- **WASM speed.** Not measurable as a bottleneck here: cold start ~1 s including migrations,
  queries in single-digit ms. The 200-frame canvas is ~0.5 MB of init payload — PGlite is not
  the slow part (renders at ~250 ms are the slow path, and they are Chromium-bound, matching
  the container's ~220 ms).
- **Memory on the 200-frame canvas.** The loaded canvas itself is cheap (~500 KB of HTML in
  the init); the growth comes from the store holding loaded canvases plus V8/PGlite overhead —
  node RSS went 159 MB idle → ~440 MB with the canvas resident, and `store.evictIdle` drops
  it back. That behaviour is inherited from the source server, not introduced by PGlite;
  a "very large library" would still hurt, unchanged from today, and the plan's remote-mode
  escape hatch stays the right mitigation.

Windows remains unproven until the workflow can run; Linux x64/arm64 were proven under Apple
`container`, not Docker — the code paths are identical (`node` + staged `node_modules`), and
`scripts/test-linux.sh` exists for a Docker re-check when a daemon is available.

## Reproduce

```sh
# build and boot the bundle
bun run build:server-bundle
DOOP_DATA_DIR=/tmp/diazo-data DOOP_DIST_DIR=$PWD/out/embedded-server/dist \
DOOP_MIGRATIONS_DIR=$PWD/out/embedded-server/migrations DOOP_LISTEN_HOST=127.0.0.1 \
NODE_ENV=production BETTER_AUTH_URL=http://127.0.0.1:4455 PORT=4455 \
BETTER_AUTH_SECRET=<32+ chars> node out/embedded-server/server.mjs

# bench it (spawns and kills the server itself)
DOOP_DATA_DIR=… BETTER_AUTH_… CHROME_PATH=… \
bun scripts/bench-local.ts http://127.0.0.1:4455 --spawn 'node out/embedded-server/server.mjs'

# container baseline
container run --name diazo-bench --detach -e BETTER_AUTH_SECRET=<…> \
  -e BETTER_AUTH_URL=http://127.0.0.1:4460 -p 127.0.0.1:4460:4400 ghcr.io/bryann2k/diazo:main
bun scripts/bench-local.ts http://127.0.0.1:4460 \
  --spawn 'container start diazo-bench' --stop 'container stop diazo-bench'
```
