# All-in-one Mac install

## Intent

One command takes a Mac from nothing to a signed-in canvas on a local Diazo server, and keeps both up to date.

## Acceptance criteria

- AC-1: On Apple silicon with macOS 26 and `container` 1.0 or later, `scripts/install.sh` runs `install-local.sh install` and `install-desktop.sh`, waits for `/healthz` and opens the app on the sign-up screen.
- AC-2: On a Mac that cannot run the server, it installs nothing, prints the download link and the `--app-only` hint, and exits with code 1.
- AC-3: A per-user LaunchAgent starts the server at login when `/healthz` does not answer; logs go to `~/Library/Logs/Diazo`.
- AC-4: The app's `server.json` points at `http://127.0.0.1:4400` unless another server is already chosen; `--use-local` replaces it.
- AC-5: The `diazo` command offers `start`, `stop`, `restart`, `status`, `logs`, `update`, `open` and `uninstall [--purge]`; `uninstall` keeps data, secrets and the app's session unless `--purge` is given.
- AC-6: Running the installer again, or `diazo update`, updates what `install.conf` records and keeps canvases and secrets.
- AC-7: `--dry-run` prints the steps and changes nothing.
- AC-8: The desktop Local Server menu shows the status and starts, stops or restarts the server with a native confirmation, running fixed commands on the `diazo` container only.
- AC-9: `tests/install.test.ts`, the existing installer tests and the shell's Rust tests pass.
