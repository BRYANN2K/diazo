# Tasks

- [x] 1. Change record (proposal, spec) from the approved brief.
- [x] 2. `install-desktop.sh`: OS and architecture detection; Linux deb, rpm, AppImage; arm64 refusal; Windows hint; `--appimage`, `--dry-run`.
- [x] 3. `scripts/install-desktop.ps1`: Windows NSIS setup, SHA256SUMS check, silent `/S`, `-Server` writes `server.json`, `-Uninstall`, `-DryRun`.
- [x] 4. `install-local.sh`: one function per container runtime (Apple `container`, docker, podman); Linux runs Docker or Podman.
- [x] 5. `install.sh`: `--remote` and the mode prompt; Linux local (systemd user unit); `server.json` per OS; `diazo` command routed per OS; `install.conf` records the mode.
- [x] 6. Tests: extend the three installer test files per the brief.
- [x] 7. Docs: `docs/RELEASE.md`, `README.md`, `docs/FEATURES.md`; CHANGELOG `[Unreleased]`.
- [ ] 8. Checks: `typecheck`, `lint`, `format:check`, `doc-lint`, the three test files; shellcheck on the scripts; commits.
