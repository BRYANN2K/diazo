# Cross-platform installers: detect the system, separate local and remote installs

## Intent

One install line per platform puts the Diazo app on macOS, Linux or Windows, and the all-in-one installer either sets up server and app on this machine (local) or the app pointed at a server elsewhere (remote).

## Acceptance criteria

- AC-1: `install-desktop.sh` on macOS (arm64 or x86_64) behaves as before: `Diazo_<v>_universal.app.tar.gz`, `SHA256SUMS`, minisign when present.
- AC-2: On Linux x86_64 it picks `Diazo_<v>_amd64.deb` on Debian/Ubuntu-family systems, `Diazo-<v>-1.x86_64.rpm` on Fedora/RHEL/openSUSE-family systems, and `Diazo_<v>_amd64.AppImage` (into `~/.local/bin` or `~/Applications`, chmod +x, `.desktop` entry in `~/.local/share/applications`) elsewhere or under `--appimage`; every download is checked against `SHA256SUMS`.
- AC-3: On Linux arm64 it says no package is published, names the releases page and exits non-zero. On a Windows `uname` it prints the `install-desktop.ps1` one-liner and exits.
- AC-4: `scripts/install-desktop.ps1` downloads `Diazo_<v>_x64-setup.exe`, checks it against `SHA256SUMS` and runs it silently (`/S`); `--uninstall` removes per platform and `--dry-run` prints the steps.
- AC-5: Local mode on macOS is unchanged; on Linux the server runs in Docker (Podman when Docker is missing) with the same image, `~/.diazo/data`, generated `diazo.env` (600) and `127.0.0.1:4400`, autostarted by the systemd user unit `~/.config/systemd/user/diazo.service`; container-runtime specifics live in one small function per runtime in `install-local.sh`. On Windows local mode prints the WSL2 + Docker / remote pointer.
- AC-6: After `/healthz` answers, local mode writes `server.json` = `http://127.0.0.1:4400` (unless another server is chosen; `--use-local` replaces) at `~/Library/Application Support/dev.bryann2k.diazo/` on macOS and `${XDG_DATA_HOME:-~/.local/share}/dev.bryann2k.diazo/` on Linux.
- AC-7: `install.sh --remote <url>` (and a terminal prompt offering local/remote when no mode is given) installs only the app and writes `server.json`; the URL is normalized like `server.rs` (https, or http on loopback only) and `<origin>/api/locale-config` must answer before anything is written; no container, LaunchAgent or unit is installed in this mode.
- AC-8: `--app-only`, `--server-only`, `--use-local`, `--version`, `--dry-run`, `--uninstall [--purge]` keep working, and the `diazo` command (`start|stop|restart|status|logs|update|open|uninstall`) is routed per OS; `diazo update` redoes what `install.conf` records.
- AC-9: The extended installer tests pass with stubbed `uname`, `/etc/os-release`, `docker`/`podman`, `systemctl`, package managers and `curl`, covering macOS unchanged, Linux deb/rpm/AppImage/arm64, the Windows hint, remote mode and Linux local under both runtimes; `bun run typecheck`, `lint` and `format:check` are green.
