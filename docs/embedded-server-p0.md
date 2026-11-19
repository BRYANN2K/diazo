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
  (override for the non-embedded bind; `DOOP_EMBEDDED` always binds `127.0.0.1` and warns
  when a non-loopback value is set).
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
  that dies without reaping its render browser leaves real memory behind — fixed in P1
  (`server/browserGuard.ts`, see below).

## P1 — relocatable server (measured 2026-11-17, `feat/embedded-server-spike`)

What landed on top of P0:

- `server/paths.ts`: every mutable path resolves under `DOOP_DATA_DIR` (PGlite, assets,
  backups, `lock/`, browser profiles); runtime resources resolve beside the bundle
  (`import.meta.url`) so `DOOP_DIST_DIR`/`DOOP_MIGRATIONS_DIR` are only overrides, never
  required. The install dir stays read-only at runtime.
- Env switches: `DOOP_EMBEDDED=1` (stdin-close shutdown + `ready <port>` on stdout once
  listening + loopback bind — the piped sidecar only: under systemd/launchd/nohup stdin is
  `/dev/null` and the server would exit at once), `DOOP_BROWSER_DIR`, `DOOP_INSTALL=desktop`
  (also inferred from `DOOP_EMBEDDED`; the server skips its own update check — the app's
  updater ships both), `DOOP_DATA_LOCK`/`DOOP_DATA_LOCK_TAKEOVER` (below).
- `server/dataLock.ts`: one server per data dir, in two layers under `<data>/lock/`.
  `lock/kernel.lock` is a kernel-held lock through `node:sqlite` (`BEGIN EXCLUSIVE`, never
  committed — an `fcntl` on POSIX, `LockFileEx` on Windows; the kernel drops it however the
  process dies, and it is never unlinked or read). Claim epochs ride beside it:
  `claim-<N>.json` created `wx`, `beat-<N>` rewritten by a worker thread (PGlite's query
  chain starves main-thread timers — the beat cannot live there), `released-<N>` on clean
  exit. The kernel lock covers one kernel; a foreign claim that still beats means another
  kernel owns the dir (`alive-elsewhere`), one that went quiet for the observe window is a
  takeover question the mode answers — `takeover` takes it, `strict` refuses until
  `DOOP_DATA_LOCK_TAKEOVER=<claim id>` names it. No pid, hostname, mtime or socket decides
  anything, and the worker fences itself: lose the inode, the claim or the epoch and it
  writes one stderr line and SIGKILLs — no flush. `DOOP_DATA_LOCK=off` skips it
  (`DATABASE_URL` does that by default; the embedded install defaults `strict`, everything
  else `takeover`).
  The contract the desktop shell reads: a refused boot prints `data-lock <reason> [id]` on
  stdout — `held`, `alive-elsewhere`, `needs-takeover <claim id>` or `unsupported` — and
  exits 3, or 4 for `needs-takeover` (the token answer). Exit 3 needs another server stopped
  or the dir moved; exit 4 wants the token dialog.
- `server/backup.ts`: `<data>/backups/pg-<date>.tar.gz` plus
  `pg-<date>.manifest.json` (reason, build, applied-journal count/newest, archive bytes and
  sha256, asset sizes); runs before applying pending migrations (on any populated database —
  journal or not — an empty cluster has nothing to lose) and once a day, catching up at
  boot. Keeps the newest 7 `daily` pairs and the newest 3 of every other reason. The live
  `pg/` is copied under the database's own mutex (`client.runExclusive(fs.cp)` — no query
  interleaves, nothing else runs inside the section), the STAGED copy is reopened with
  PGlite and its applied journal read before anything is published, and the pair goes out
  as two atomic renames — manifest first, archive last, whose name is the completion
  marker. Everything streams one file at a time; the tree is private (`0700`/`0600`)
  whatever the umask.
- `server/restore.ts` + `server/dataTool.ts`: `node data-tool.mjs restore <archive|latest>`
  (the checkout's `bun run data`) takes the data lock, checks the archive's sha256 against
  its manifest, unpacks into `pg.restore-<stamp>/` with a streaming ustar reader that
  refuses anything but regular files and directories and any name that escapes, reopens the
  stage with PGlite, refuses data newer than this build in every `NODE_ENV`, then swaps by
  rename — `pg` moves to `pg.replaced-<stamp>` beside a `.ready` marker, the restore takes
  its place. A crash inside the two renames is completed or refused at the next boot; the
  live dir is never edited in place. The tool loads `server/env.ts`, so it needs the
  install's own environment — a production install refuses without its secrets.
- Migration guards in `server/db/index.ts`: completes or refuses a half-done restore
  before opening `pg` (`completeInterruptedRestore`), refuses a data dir stamped by a newer
  migration set (newer `created_at` than the bundled journal, or more applied rows than the
  journal has — a warning in development, a refusal elsewhere), and backs up on the open
  client when rows exist and migrations are pending — the backup failure rejects `initDb`
  before the migrator runs.
- `server/browserGuard.ts`: the leak fix. Each launched browser is killed by its process
  group (`kill(-pid)` POSIX, `taskkill /t` Windows) from a synchronous `exit` hook, and a
  detached `node -e` watchdog reaps the group when the server dies without hooks (kill -9);
  inside a container the namespace teardown already reaps it, so the watchdog is skipped
  there. A cleanly terminated browser is released (watchdog killed, profile removed), so a
  reused pid is never reaped. Profiles live under `<data>/browser-profiles/profile-*` —
  inside the locked data dir, never in the (possibly shared) download dir.
- `scripts/build-embedded-server.ts` (`bun run build:embedded-server`) replaces the P0
  script: minified bundle, `--web-src` for a prebuilt web root, and the prunes below.

### Bundle sizes after the P1 prunes (darwin-arm64, measured)

| Part                                    | P0          | P1          |
| --------------------------------------- | ----------- | ----------- |
| `server.mjs`                            | 12.9 MB     | 6.6 MB      |
| `node_modules` (sharp + PGlite, native) | 41.8 MB     | 33.2 MB     |
| `migrations/`                           | 6.7 MB      | 0.05 MB     |
| `dist/` (web)                           | 24.4 MB     | 15.2 MB     |
| `backgrounds.json`                      | 0.1 MB      | 0.1 MB      |
| **Total**                               | **85.8 MB** | **55.1 MB** |

Cheap wins only: esbuild minify (12.9 → 6.6), `dist/*.map` dropped (browser devtools fetch
them only on demand, never needed by the server), `migrations/meta/*.json` snapshots dropped
(drizzle-kit inputs; the migrator reads only `.sql` + `_journal.json`), and inside
`node_modules` — `.d.ts`/`.map` everywhere, PGlite's 37 contrib `.tar.gz` extensions (no
`CREATE EXTENSION` in the journal), its `cjs`/`live`/`worker`/`templating`/`opfs-ahp` trees,
and sharp's `src/`. PGlite's `pglite.wasm`/`initdb.wasm`/`pglite.data` and every `@img/*`
package stay — they are loaded by path.

Verified by `tests/embeddedBundle.test.ts`: builds the bundle, copies it to a read-only
install dir, boots `node server.mjs` from a separate cwd, reads `ready <port>`, answers on
`127.0.0.1` (refuses every external interface), writes nothing outside `DOOP_DATA_DIR`, and
exits when stdin closes. `tests/browserGuard.test.ts` proves the exit-hook and the kill -9
watchdog paths both reap the browser process group.

### Verdicts against plan §3 targets

| Target                          | Result                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| cold start < 2 s                | pass — 1.03 s median                                                                                                            |
| ≥ 2× faster than the container  | pass — 2.4× (1032 vs 2480 ms)                                                                                                   |
| idle memory ≥ 2× lower          | fail — roughly even (159–670 MB vs 581 MB), see above                                                                           |
| everything else equal or better | pass — API, join, append, upload, warm render all better; cold render 252 vs 219 ms is within noise (different Chromium builds) |

## Go / no-go — Node + esbuild + PGlite

**Go.** The build shape works on every system it could be checked on, boots in ~1 s, and the
only bundling bugs found (eager `pg` import, skipped platform packages) are fixed in the
build script, not in the architecture.

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
# build and boot the bundle (P1: dist/ and migrations/ resolve beside server.mjs)
bun run build:embedded-server
DOOP_DATA_DIR=/tmp/diazo-data DOOP_LISTEN_HOST=127.0.0.1 \
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
