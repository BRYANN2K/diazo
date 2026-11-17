# Cross-platform installers: detect the system, separate local and remote installs

## Problem

Both curl installers assume a Mac. `install-desktop.sh` refuses anything but macOS although the release publishes Linux and Windows packages, and `install.sh` (the all in one) only knows the macOS path: there is no way to install just the app pointed at a server elsewhere.

## Scope

- In: `scripts/install-desktop.sh` (OS and architecture detection, `.deb`, `.rpm`, AppImage, Windows hint), a new `scripts/install-desktop.ps1` (Windows), `scripts/install-local.sh` (container runtime behind per-runtime functions: Apple `container` on macOS, Docker or Podman on Linux), `scripts/install.sh` (local and remote modes, a systemd user unit on Linux, `server.json` per OS, an interactive mode prompt on a terminal), the three installer tests, `docs/RELEASE.md`, `README.md`, `docs/FEATURES.md`.
- Out: a local install on Windows (WSL2 + Docker is only signposted), the k3s manifest and Tailscale/ingress setup, arm64 Linux packages (none is published), changes to `server.rs` or the app's Local Server menu.

## Decisions and open questions

- One POSIX `install-desktop.sh` covers macOS and Linux; Windows gets a separate PowerShell script, and the `.sh` prints its one-liner on Windows `uname`s.
- The Linux distro family comes from `/etc/os-release` (`ID`/`ID_LIKE`): deb for Debian/Ubuntu, rpm for Fedora/RHEL/openSUSE, the AppImage elsewhere or under `--appimage`.
- On Linux the local server runs in Docker, falling back to Podman, with the same image, data folder, env file and `127.0.0.1:4400`; autostart is a systemd user unit instead of the LaunchAgent.
- Remote mode (`--remote <url>` or the prompt) validates the origin the way `server.rs` does (https, or http on loopback), checks `<origin>/api/locale-config`, installs only the app and writes `server.json`.
- `install.conf` records `mode=local|remote` beside `server=`/`app=` so `diazo update` redoes the right install.
- Secrets keep living only in the generated `diazo.env` (mode 600). Internal identifiers (`DOOP_*`, `doop-local`, `~/.doop` fallback) stay.
