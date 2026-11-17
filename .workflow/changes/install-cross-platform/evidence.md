# Evidence

Status: collected after the checks, 2026-11-17. `bun run typecheck`, `bun run lint`,
`bun run format:check`, `shellcheck` on the three shell installers and
`bunx vitest run tests/install.test.ts tests/installLocal.test.ts
tests/installDesktop.test.ts` all pass (77 tests). Not checked by `stip-check` yet:
the contract awaits the owner's sign-off.

- AC-1 (macOS unchanged): the existing macOS tests still pass untouched (feed
  version, `SHA256SUMS`, minisign path, staged swap, quarantine, legacy doop.app
  rules); "installs the latest release from the feed", "quits a running app",
  "checks the release signature with minisign".
- AC-2 (Linux x86_64): `install-desktop.sh` reads `DOOP_OS_RELEASE` (default
  `/etc/os-release`), picks `.deb` → `apt`/`dpkg`, `.rpm` → `dnf`/`zypper`/`rpm`
  under `sudo`, AppImage elsewhere or under `--appimage` into `~/.local/bin`
  (or `~/Applications`) with the same `doop-desktop-appimage.desktop` entry the
  app writes itself. Tests: "installs the .deb through apt", "installs the .rpm
  through dnf", "installs the AppImage on other families, or under --appimage",
  "is idempotent through the AppImage filename". SHA256SUMS verified for each.
- AC-3 (arm64 + Windows hint): tests "refuses Linux arm64 with the releases
  link" and "prints the PowerShell line on Windows" in `installDesktop.test.ts`,
  "install.sh on Windows shells" in `install.test.ts`.
- AC-4 (`install-desktop.ps1`): downloads `Diazo_<v>_x64-setup.exe`, verifies it
  against `SHA256SUMS`, runs it `/S` silently; `-Server`/`DOOP_DESKTOP_SERVER`
  validates as `server.rs` (https or loopback http), probes
  `/api/locale-config`, writes `%APPDATA%\dev.bryann2k.diazo\server.json`;
  `-Uninstall`, `-DryRun`, `-Force`, `-Version`.
- AC-5 (Linux local): `install-local.sh` puts the runtime behind small
  per-runtime functions (`pick_runtime`, `start_system`, `exists`, `run_args`,
  `logs_*`, `remove_*`): Apple `container` on macOS, `docker` else `podman` on
  Linux; same image, `~/.diazo/data` at `/app/data`, generated `diazo.env` mode
  600, `127.0.0.1:4400`, `--restart unless-stopped`. `install.sh` writes
  `~/.config/systemd/user/diazo.service` (`ExecStart=<bin>/diazo autostart`,
  `WantedBy=default.target`) and enables it; Windows refuses with the WSL2
  pointer. Tests: "runs the same container through Docker", "uses Podman when
  Docker is missing", "says what to install when neither", "says so when the
  Docker daemon is down", install.sh "installs the server in Docker, the user
  unit and the app set to it", "uses Podman".
- AC-6 (`server.json` per OS): macOS `~/Library/Application Support/…` tests
  unchanged; Linux `${XDG_DATA_HOME:-~/.local/share}/dev.bryann2k.diazo` covered
  by "installs the server in Docker … the app set to it" and "keeps the server
  choice the app already has, unless --use-local".
- AC-7 (remote mode): `install.sh --remote` normalizes to an origin as
  `server.rs` (https, loopback http, credentials refused, doop.design refused),
  probes `/api/locale-config` before writing anything, installs only the app
  (asserted: no `run`, docker/podman/launchctl/systemctl calls), writes
  `server.json`; a same-server choice is trusted and skips the probe; the
  terminal prompt asks Local/Remote when no mode is given. Tests: the whole
  `install.sh --remote` describe.
- AC-8 (flags + command): macOS tests for `--app-only`, `--server-only`,
  `--use-local`, `--version`, `--dry-run`, `--uninstall [--purge]` still pass;
  `install.conf` now records `mode|server|app|remote`; `diazo update` replays
  them (remote test "updates what install.conf records"); Linux covered by
  "drives the container, the unit and the app through the diazo command".
- AC-9 (checks): the three test files cover every listed stub and case; all
  green (77/77) plus typecheck, lint, format:check and shellcheck clean.

## Review fixes (2026-11-17)

The eight review fixes are applied in five commits on this branch, each with
its regression test; 92 tests in the three installer files pass (one skips:
the ps1 parse check needs `pwsh`), plus `bun run typecheck`, `lint`,
`format:check`, `doc-lint` and `shellcheck` clean. The test files now allow
60s per test since each spawns real installer processes; on this Mac a single
exec costs ~50ms, so a full install run exceeds the 5s default.

- AppImage scoping: detection and cleanup match `Diazo_*_amd64.AppImage`
  (`install-desktop.sh`, `install.sh app_installed`); a foreign AppImage
  survives install, update and uninstall ("never deletes another vendor's
  AppImage…" and the foreign-file status check).
- Linux uid/data: `run_args` adds `--user $(id -u):$(id -g)` for Docker,
  `--userns=keep-id` for Podman, `HOME=/app/data` and `:Z` under SELinux
  (tests assert the flags, Enforcing vs Permissive). **Unverified:** a real
  Ubuntu/Docker or Fedora/rootless Podman run — none is available on this
  Mac.
- `install-desktop.ps1`: `$Input` renamed, `throw` + one catch instead of
  `exit`, install folder from the Uninstall key's `InstallLocation` with
  `%LOCALAPPDATA%\Diazo` default, `/D=` only when `DOOP_DESKTOP_DIR` is set,
  server.rs-style normalize/probe. **Unverified:** a real run — `pwsh` is
  not installed on this Mac; the suite parses it under pwsh where one exists.
- Remote update: `DIAZO_UPDATE=1` marks the replay so a server picked in the
  app survives `diazo update`; explicit `--remote` still replaces it
  ("keeps a server picked in the app on update; --remote replaces it").
- server.rs parity: loopback is `IpAddr::is_loopback` semantics (four
  numeric octets of 127.0.0.0/8, `::1`, `localhost`), the probe follows
  redirects and writes the origin that answered, re-checked
  ("saves the origin a redirect lands on…", the loopback and host tests).
- rpm/zypper: `rpm -U` and `zypper … --allow-unsigned-rpm` with tests on
  both paths.
- Remote uninstall: skips runtime detection and `install-local.sh`
  ("uninstalls the app and the command in remote mode, touching no
  container"); an unknown `mode=` dies before anything is touched
  ("refuses a recorded mode it does not know"); `server.json` stays
  `{"url":…}` (asserted verbatim in the remote test).
