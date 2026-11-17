#!/bin/sh
# diazo-local: run Diazo on this computer in one container.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-local.sh | sh
#
# One container (ghcr.io/bryann2k/diazo), its embedded Postgres (PGlite) and its
# uploads in ~/.diazo/data, its secrets in ~/.diazo/diazo.env (generated here,
# mode 600). Published on 127.0.0.1 only. Re-running it updates the image and
# restarts the container; data and secrets are kept.
#
# The container runtime depends on the system: Apple's `container` on macOS
# (Apple silicon, macOS 26 or later), Docker on Linux, or Podman there when
# Docker is missing; each lives behind one small function set below.
#
# An install made before the rename (redoop) lives in ~/.doop, with doop.env
# and a container named doop. That folder is used where it is: nothing is
# moved, so a container still mounting it, or an interrupted run, never loses
# a canvas. Its container is replaced by the diazo one on the next install.
#
# The installer also copies itself to <data folder>/bin/diazo-local
# (doop-local is a link to it, for old habits):
#   diazo-local [install|update|start|stop|restart|status|logs|uninstall]
#
# Settings (environment; the DOOP_ names are kept so existing setups still
# apply): DOOP_HOME (~/.diazo, or ~/.doop when only that one exists), DOOP_PORT
# (4400), DOOP_IMAGE, DOOP_NAME (diazo), DOOP_REF (branch built by --build),
# DOOP_HEALTH_TIMEOUT (s), DOOP_RUNTIME (docker|podman, overrides the Linux
# detection).
#
# scripts/install.sh (the all-in-one install of the server and the app) runs
# this one for the server part and sets DIAZO_COMMAND to its `diazo` command
# and DIAZO_AUTOSTART to the login-start description, which the messages then
# name, since the server starts at login (LaunchAgent on macOS, a systemd
# user unit on Linux).

set -eu

# The data folder: an explicit DOOP_HOME, else ~/.diazo, else a pre-rename
# ~/.doop kept in place.
pick_home() {
  if [ -n "${DOOP_HOME:-}" ]; then
    printf '%s' "$DOOP_HOME"
  elif [ ! -d "$HOME/.diazo" ] && [ -d "$HOME/.doop" ]; then
    printf '%s' "$HOME/.doop"
  else
    printf '%s' "$HOME/.diazo"
  fi
}

DOOP_HOME=$(pick_home)
DOOP_PORT=${DOOP_PORT:-4400}
DOOP_NAME=${DOOP_NAME:-diazo}
DOOP_IMAGE=${DOOP_IMAGE:-ghcr.io/bryann2k/diazo:main}
DOOP_REF=${DOOP_REF:-main}
DOOP_REPO=${DOOP_REPO:-BRYANN2K/diazo}
DOOP_HEALTH_TIMEOUT=${DOOP_HEALTH_TIMEOUT:-240}
DOOP_SCRIPT_URL=${DOOP_SCRIPT_URL:-"https://raw.githubusercontent.com/$DOOP_REPO/$DOOP_REF/scripts/install-local.sh"}
LOCAL_TAG=diazo-local:latest
# what the pre-rename installer made: its container and images
LEGACY_NAME=doop
LEGACY_IMAGE=ghcr.io/bryann2k/redoop:main
LEGACY_TAG=doop-local:latest

# a pre-rename folder keeps its doop.env; a new one gets diazo.env
if [ -f "$DOOP_HOME/doop.env" ] && [ ! -f "$DOOP_HOME/diazo.env" ]; then
  ENV_FILE="$DOOP_HOME/doop.env"
else
  ENV_FILE="$DOOP_HOME/diazo.env"
fi
DATA_DIR="$DOOP_HOME/data"
BIN_DIR="$DOOP_HOME/bin"

ACTION=install
BUILD=0
ASSUME_YES=0
KEEP_DATA=0
# the container runtime: apple (macOS), docker or podman (Linux)
RT=
# set by pick_image: the image to run and the extra run flags it needs
RUN_IMAGE=
RUN_PLATFORM=

say() { printf '%s\n' "diazo: $*"; }
die() {
  printf '%s\n' "diazo: error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-local.sh [command] [options]

Commands:
  install, update   pull the image, (re)create the container, wait until it answers (default)
  start             start the existing container
  stop              stop the container (data kept)
  restart           stop, then start
  status            show the container and whether Diazo answers
  logs              follow the container's logs
  uninstall         remove the container and image; asks before deleting the data folder

Options:
  --build           build the image on this computer from source instead of pulling it
  --yes, -y         uninstall: delete the data folder without asking
  --keep-data       uninstall: keep the data folder without asking
  --stop, --uninstall, --start, --status, --logs, --update
                    same as the commands above
  -h, --help        this help
EOF
}

# ---------------------------------------------------------------- arguments
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      install | update | --install | --update) ACTION=install ;;
      start | --start) ACTION=start ;;
      stop | --stop) ACTION=stop ;;
      restart | --restart) ACTION=restart ;;
      status | --status) ACTION=status ;;
      logs | --logs) ACTION=logs ;;
      uninstall | --uninstall) ACTION=uninstall ;;
      --build) BUILD=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      --keep-data) KEEP_DATA=1 ;;
      -h | --help | help) ACTION=help ;;
      *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done
  case $DOOP_PORT in
    '' | *[!0-9]*) die "DOOP_PORT must be a port number, got '$DOOP_PORT'" ;;
  esac
  if [ "$DOOP_PORT" -lt 1 ] || [ "$DOOP_PORT" -gt 65535 ]; then
    die "DOOP_PORT must be between 1 and 65535, got $DOOP_PORT"
  fi
}

# ---------------------------------------------------------------- checks
check_platform() {
  case $(uname -s) in
    Darwin)
      [ "$(uname -m)" = arm64 ] || die "Apple's container runs on Apple silicon only (this Mac is $(uname -m)). On Intel, self-host with: docker compose up"
      major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
      if [ -n "$major" ] && [ "$major" -lt 26 ]; then
        say "warning: Apple's container is supported on macOS 26 and later (this is $(sw_vers -productVersion))"
      fi
      ;;
    Linux) ;;
    MINGW* | MSYS* | CYGWIN*)
      die "the local install does not run on Windows. Use WSL2 with Docker, or run only the app (scripts/install-desktop.ps1) pointed at a server"
      ;;
    *) die "the local install needs macOS or Linux (this is $(uname -s)). Elsewhere, use the hosted path: docker compose up" ;;
  esac
}

# The container runtime this computer uses: apple on macOS; on Linux Docker,
# else Podman (DOOP_RUNTIME overrides).
pick_runtime() {
  case $(uname -s) in
    Darwin) RT=apple ;;
    Linux)
      case ${DOOP_RUNTIME:-} in
        docker | podman) RT=$DOOP_RUNTIME ;;
        '')
          if command -v docker >/dev/null 2>&1; then
            RT=docker
          elif command -v podman >/dev/null 2>&1; then
            RT=podman
          else
            cat >&2 <<'EOF'
diazo: error: the local server runs in a container, and neither Docker nor Podman is installed.

  Install Docker:   https://docs.docker.com/engine/install/
  (or Podman:       https://podman.io/docs/installation)
  then run this installer again.
EOF
            exit 1
          fi
          ;;
        *) die "DOOP_RUNTIME must be docker or podman, got '$DOOP_RUNTIME'" ;;
      esac
      ;;
  esac
}

check_runtime() {
  pick_runtime
  case $RT in
    apple)
      if ! command -v container >/dev/null 2>&1; then
        cat >&2 <<'EOF'
diazo: error: Apple's `container` CLI is not installed.

  1. Download the signed installer (container-<version>-installer-signed.pkg) from
     https://github.com/apple/container/releases/latest
  2. Open it and follow the steps (it installs to /usr/local/bin/container).
  3. Run this installer again.
EOF
        exit 1
      fi
      ;;
    docker | podman)
      command -v "$RT" >/dev/null 2>&1 || die "$RT is not installed (DOOP_RUNTIME picked it)"
      ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the secrets"
}

# What the runtime needs before its commands work: Apple's container services
# (first run downloads a kernel), a reachable Docker daemon, nothing for
# Podman (it has no daemon).
start_system() {
  case $RT in
    apple)
      if container system status >/dev/null 2>&1; then
        return 0
      fi
      say "starting Apple container services (first run downloads a Linux kernel)"
      container system start --enable-kernel-install
      ;;
    docker)
      if ! docker info >/dev/null 2>&1; then
        die "the Docker daemon is not running: start it (sudo systemctl start docker, or open Docker Desktop) and run this again"
      fi
      ;;
    podman) ;;
  esac
}

# ---------------------------------------------------------------- files
gen_hex() { openssl rand -hex 32; }
gen_key() { printf 'local:%s' "$(openssl rand -base64 32)"; }

# Writes the env file once; later runs only add a key that is missing, so
# the secrets (and anything the user added) survive every update.
write_env_file() {
  umask 077
  mkdir -p "$DOOP_HOME" "$DATA_DIR"
  chmod 700 "$DOOP_HOME"
  if [ ! -f "$ENV_FILE" ]; then
    cat >"$ENV_FILE" <<EOF
# Diazo local install. Generated on this computer; never commit or share this file.
# BETTER_AUTH_URL and PORT are set by diazo-local from DOOP_PORT.
# Add any optional setting from .env.example here (ANTHROPIC_API_KEY, SMTP_*, ...),
# then run: diazo-local restart
EOF
    say "created $ENV_FILE"
  fi
  ensure_key BETTER_AUTH_SECRET "$(gen_hex)"
  ensure_key SECRETS_ENCRYPTION_KEYS "$(gen_key)"
  chmod 600 "$ENV_FILE"
}

ensure_key() {
  if ! grep -q "^$1=" "$ENV_FILE"; then
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

install_helper() {
  mkdir -p "$BIN_DIR"
  target="$BIN_DIR/diazo-local"
  if [ -f "$0" ] && grep -q '^# diazo-local: run Diazo on this computer' "$0" 2>/dev/null; then
    cmp -s "$0" "$target" || cp "$0" "$target"
  else
    curl -fsSL "$DOOP_SCRIPT_URL" -o "$target.tmp" && mv "$target.tmp" "$target"
  fi
  chmod 755 "$target"
  # the pre-rename name, as a link, so `doop-local update` keeps working
  rm -f "$BIN_DIR/doop-local"
  ln -s diazo-local "$BIN_DIR/doop-local"
}

# ---------------------------------------------------------------- image
# The architecture to pull or build, as image platforms name it.
image_platform() {
  case $(uname -m) in
    x86_64 | amd64) printf 'amd64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) return 1 ;;
  esac
}

# Pull the image (native platform). Apple's container falls back to the amd64
# one under Rosetta when the registry has no arm64 build; Docker and Podman
# pick the platform's manifest.
pick_image() {
  if [ "$BUILD" = 1 ]; then
    build_image
    RUN_IMAGE=$LOCAL_TAG
    RUN_PLATFORM=
    return 0
  fi
  say "pulling $DOOP_IMAGE"
  if [ "$RT" = apple ]; then
    if container image pull --platform linux/arm64 "$DOOP_IMAGE"; then
      RUN_IMAGE=$DOOP_IMAGE
      RUN_PLATFORM=
    elif container image pull --platform linux/amd64 "$DOOP_IMAGE"; then
      say "no arm64 image published yet: running the amd64 one under Rosetta (slower; --build makes a native one)"
      RUN_IMAGE=$DOOP_IMAGE
      RUN_PLATFORM=amd64
    else
      die "could not pull $DOOP_IMAGE (offline?). Try again, or build it here with --build"
    fi
  else
    platform=$(image_platform) || die "no Diazo image for this architecture ($(uname -m)); --build builds one here"
    "$RT" pull --platform "linux/$platform" "$DOOP_IMAGE" ||
      die "could not pull $DOOP_IMAGE (offline?). Try again, or build it here with --build"
    RUN_IMAGE=$DOOP_IMAGE
    RUN_PLATFORM=
  fi
}

build_image() {
  platform=$(image_platform) || die "cannot tell this architecture ($(uname -m))"
  src=$(mktemp -d "${TMPDIR:-/tmp}/diazo-src.XXXXXX")
  say "downloading $DOOP_REPO@$DOOP_REF"
  curl -fsSL "https://codeload.github.com/$DOOP_REPO/tar.gz/refs/heads/$DOOP_REF" | tar -xz -C "$src" --strip-components 1
  say "building $LOCAL_TAG (several minutes the first time)"
  case $RT in
    apple) container build --platform "linux/$platform" -t "$LOCAL_TAG" "$src" ;;
    *) "$RT" build --platform "linux/$platform" -t "$LOCAL_TAG" "$src" ;;
  esac
  rm -rf "$src"
}

# ---------------------------------------------------------------- container
exists() {
  case $RT in
    apple) container inspect "$DOOP_NAME" >/dev/null 2>&1 ;;
    *) "$RT" inspect "$DOOP_NAME" >/dev/null 2>&1 ;;
  esac
}

remove_container() {
  if exists; then
    case $RT in
      apple)
        container stop "$DOOP_NAME" >/dev/null 2>&1 || true
        container delete --force "$DOOP_NAME" >/dev/null
        ;;
      *)
        "$RT" stop "$DOOP_NAME" >/dev/null 2>&1 || true
        "$RT" rm -f "$DOOP_NAME" >/dev/null
        ;;
    esac
  fi
}

# The inspect output of a container, used to recognize this installer's own.
inspect_container() {
  case $RT in
    apple) container inspect "$1" 2>/dev/null ;;
    *) "$RT" inspect "$1" 2>/dev/null ;;
  esac
}

# The pre-rename installer's container (named doop, on the same port and the
# same data folder): removed only when it runs one of that installer's images,
# so a container someone else named doop is left alone.
remove_legacy_container() {
  [ "$DOOP_NAME" != "$LEGACY_NAME" ] || return 0
  info=$(inspect_container "$LEGACY_NAME") || return 0
  case $info in
    *"$LEGACY_IMAGE"* | *"$LEGACY_TAG"*) ;;
    *)
      say "left the container '$LEGACY_NAME' alone (not one this installer made)"
      return 0
      ;;
  esac
  say "replacing the pre-rename container '$LEGACY_NAME'"
  case $RT in
    apple)
      container stop "$LEGACY_NAME" >/dev/null 2>&1 || true
      container delete --force "$LEGACY_NAME" >/dev/null
      ;;
    *)
      "$RT" stop "$LEGACY_NAME" >/dev/null 2>&1 || true
      "$RT" rm -f "$LEGACY_NAME" >/dev/null
      ;;
  esac
}

# SELinux relabels the mounted data folder when it enforces (Fedora and
# RHEL-family): without :Z the container gets "permission denied" on /app/data.
selinux_enforcing() {
  if command -v getenforce >/dev/null 2>&1; then
    [ "$(getenforce 2>/dev/null)" = Enforcing ]
  elif [ -r /sys/fs/selinux/enforce ]; then
    [ "$(cat /sys/fs/selinux/enforce 2>/dev/null)" = 1 ]
  else
    return 1
  fi
}

# The `run` invocation, one argument per line (the tests read it). Docker and
# Podman share their flags; the container also gets a restart policy there,
# since the systemd unit only runs at login and a crash should not idle it.
#
# The image runs as uid 10001, which cannot write a host-mounted data folder
# on Linux: Docker does not remap a bind mount's ownership (Apple's
# `container` does), and rootless Podman maps it through subuids. So the
# caller's uid is mapped into the container instead — `--user` for Docker,
# keep-id for Podman, which also gives it a passwd entry — with HOME at the
# data folder (Chromium and PGlite need a writable one; a uid with no passwd
# entry has none).
#
# keep-id:uid=10001 pins the caller to the image's own user: Podman 4.x
# (Ubuntu, Debian) still runs the process as the image's USER even with
# keep-id, and only the mapped uid can write the bind mount. Podman 5.x runs
# the process as the keep-id user, so the pin lands on the same 10001 either
# way.
run_args() {
  case $RT in
    apple)
      printf '%s\n' run --detach --name "$DOOP_NAME" \
        --publish "127.0.0.1:$DOOP_PORT:4400" \
        --volume "$DATA_DIR:/app/data" \
        --env-file "$ENV_FILE" \
        --env "BETTER_AUTH_URL=http://localhost:$DOOP_PORT" \
        --env "TRUSTED_ORIGINS=http://127.0.0.1:$DOOP_PORT" \
        --env PORT=4400 \
        --env DOOP_INSTALL=local
      if [ "$RUN_PLATFORM" = amd64 ]; then
        printf '%s\n' --platform linux/amd64 --rosetta
      fi
      ;;
    *)
      volume="$DATA_DIR:/app/data"
      if selinux_enforcing; then
        volume="$volume:Z"
      fi
      printf '%s\n' run --detach --name "$DOOP_NAME" \
        --restart unless-stopped \
        --publish "127.0.0.1:$DOOP_PORT:4400" \
        --volume "$volume" \
        --env-file "$ENV_FILE" \
        --env "BETTER_AUTH_URL=http://localhost:$DOOP_PORT" \
        --env "TRUSTED_ORIGINS=http://127.0.0.1:$DOOP_PORT" \
        --env PORT=4400 \
        --env DOOP_INSTALL=local \
        --env HOME=/app/data
      case $RT in
        docker) printf '%s\n' --user "$(id -u):$(id -g)" ;;
        podman) printf '%s\n' --userns=keep-id:uid=10001,gid=10001 ;;
      esac
      ;;
  esac
  printf '%s\n' "$RUN_IMAGE"
}

run_container() {
  # every argument is free of newlines (paths under $HOME, fixed flags)
  old_ifs=$IFS
  IFS='
'
  # shellcheck disable=SC2046 # split on newlines on purpose
  set -- $(run_args)
  IFS=$old_ifs
  case $RT in
    apple) container "$@" >/dev/null ;;
    *) "$RT" "$@" >/dev/null ;;
  esac
}

logs_tail() {
  case $RT in
    apple) container logs -n 40 "$DOOP_NAME" ;;
    *) "$RT" logs --tail 40 "$DOOP_NAME" ;;
  esac
}

logs_follow() {
  case $RT in
    apple) container logs --follow "$DOOP_NAME" ;;
    *) "$RT" logs -f "$DOOP_NAME" ;;
  esac
}

start_existing() {
  case $RT in
    apple) container start "$DOOP_NAME" >/dev/null ;;
    *) "$RT" start "$DOOP_NAME" >/dev/null ;;
  esac
}

stop_container() {
  case $RT in
    apple) container stop "$DOOP_NAME" >/dev/null ;;
    *) "$RT" stop "$DOOP_NAME" >/dev/null ;;
  esac
}

list_containers() {
  case $RT in
    apple) container list --all ;;
    *) "$RT" ps -a ;;
  esac
}

remove_image() {
  case $RT in
    apple) container image delete "$1" >/dev/null 2>&1 || true ;;
    *) "$RT" rmi "$1" >/dev/null 2>&1 || true ;;
  esac
}

wait_healthy() {
  url="http://127.0.0.1:$DOOP_PORT/healthz"
  say "waiting for $url"
  waited=0
  while [ "$waited" -lt "$DOOP_HEALTH_TIMEOUT" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  say "Diazo did not answer within ${DOOP_HEALTH_TIMEOUT}s. Last log lines:"
  logs_tail >&2 || true
  exit 1
}

ready() {
  manage="$BIN_DIR/diazo-local [start|stop|restart|status|logs|update|uninstall]"
  reboot="After a reboot, run: $BIN_DIR/diazo-local start"
  if [ -n "${DIAZO_COMMAND:-}" ]; then
    manage="$DIAZO_COMMAND [start|stop|restart|status|logs|update|open|uninstall]"
    reboot="It starts again at login (${DIAZO_AUTOSTART:-the login task})."
  fi
  cat <<EOF

Diazo is running: http://localhost:$DOOP_PORT
  MCP endpoint:  http://localhost:$DOOP_PORT/mcp
  data:          $DATA_DIR
  secrets:       $ENV_FILE
  manage it:     $manage
$reboot
EOF
}

do_install() {
  check_platform
  check_runtime
  start_system
  write_env_file
  install_helper
  pick_image
  remove_legacy_container
  remove_container
  say "starting $DOOP_NAME on 127.0.0.1:$DOOP_PORT"
  run_container
  wait_healthy
  ready
}

do_start() {
  check_platform
  check_runtime
  start_system
  exists || die "no '$DOOP_NAME' container yet: run the installer first"
  start_existing
  wait_healthy
  ready
}

do_stop() {
  check_platform
  check_runtime
  if exists; then
    stop_container
    say "stopped (data kept in $DATA_DIR)"
  else
    say "no '$DOOP_NAME' container"
  fi
}

do_status() {
  check_platform
  check_runtime
  list_containers
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$DOOP_PORT/healthz" 2>/dev/null; then
    say "answering on http://localhost:$DOOP_PORT"
  else
    say "not answering on http://localhost:$DOOP_PORT"
  fi
}

# Reads the answer from the terminal: under `curl | sh` stdin is the script.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if [ -r /dev/tty ] && { true </dev/tty; } 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=
  else
    answer=
  fi
  case $answer in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

do_uninstall() {
  check_platform
  check_runtime
  remove_legacy_container
  remove_container
  for image in "$DOOP_IMAGE" "$LOCAL_TAG" "$LEGACY_IMAGE" "$LEGACY_TAG"; do
    remove_image "$image"
  done
  say "container and image removed"
  if [ -d "$DOOP_HOME" ]; then
    if [ "$KEEP_DATA" = 1 ]; then
      say "kept $DOOP_HOME"
    elif confirm "Delete $DOOP_HOME (every canvas, upload and secret)?"; then
      rm -rf "$DOOP_HOME"
      say "deleted $DOOP_HOME"
    else
      say "kept $DOOP_HOME"
    fi
  fi
}

main() {
  parse_args "$@"
  case $ACTION in
    help) usage ;;
    install) do_install ;;
    start) do_start ;;
    stop) do_stop ;;
    restart)
      do_stop
      do_start
      ;;
    status) do_status ;;
    logs)
      check_platform
      check_runtime
      logs_follow
      ;;
    uninstall) do_uninstall ;;
  esac
}

# DOOP_INSTALL_LIB=1 defines the functions without running anything (tests).
if [ "${DOOP_INSTALL_LIB:-0}" != 1 ]; then
  main "$@"
fi
