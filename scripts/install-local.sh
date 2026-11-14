#!/bin/sh
# doop-local: run doop on this Mac in one container, with Apple's `container`.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/redoop/main/scripts/install-local.sh | sh
#
# One container (ghcr.io/bryann2k/redoop), its embedded Postgres (PGlite) and its
# uploads in ~/.doop/data, its secrets in ~/.doop/doop.env (generated here, mode
# 600). Published on 127.0.0.1 only. Re-running it updates the image and
# restarts the container; data and secrets are kept.
#
# The installer also copies itself to ~/.doop/bin/doop-local:
#   doop-local [install|update|start|stop|restart|status|logs|uninstall]
#
# Settings (environment): DOOP_HOME (~/.doop), DOOP_PORT (4400), DOOP_IMAGE,
# DOOP_NAME (doop), DOOP_REF (branch built by --build), DOOP_HEALTH_TIMEOUT (s).

set -eu

DOOP_HOME=${DOOP_HOME:-"$HOME/.doop"}
DOOP_PORT=${DOOP_PORT:-4400}
DOOP_NAME=${DOOP_NAME:-doop}
DOOP_IMAGE=${DOOP_IMAGE:-ghcr.io/bryann2k/redoop:main}
DOOP_REF=${DOOP_REF:-main}
DOOP_REPO=${DOOP_REPO:-BRYANN2K/redoop}
DOOP_HEALTH_TIMEOUT=${DOOP_HEALTH_TIMEOUT:-240}
DOOP_SCRIPT_URL=${DOOP_SCRIPT_URL:-"https://raw.githubusercontent.com/$DOOP_REPO/$DOOP_REF/scripts/install-local.sh"}
LOCAL_TAG=doop-local:latest

ENV_FILE="$DOOP_HOME/doop.env"
DATA_DIR="$DOOP_HOME/data"
BIN_DIR="$DOOP_HOME/bin"

ACTION=install
BUILD=0
ASSUME_YES=0
# set by pick_image: the image to run and the extra `container run` flags it needs
RUN_IMAGE=
RUN_PLATFORM=

say() { printf '%s\n' "doop: $*"; }
die() {
  printf '%s\n' "doop: error: $*" >&2
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
  status            show the container and whether doop answers
  logs              follow the container's logs
  uninstall         remove the container and image; asks before deleting ~/.doop

Options:
  --build           build the image on this Mac from source instead of pulling it
  --yes, -y         uninstall: delete ~/.doop without asking
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
  [ "$(uname -s)" = Darwin ] || die "the local install needs macOS (this is $(uname -s)). Elsewhere, use the hosted path: docker compose up"
  [ "$(uname -m)" = arm64 ] || die "Apple's container runs on Apple silicon only (this Mac is $(uname -m)). Use Docker instead: docker compose up"
  major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  if [ -n "$major" ] && [ "$major" -lt 26 ]; then
    say "warning: Apple's container is supported on macOS 26 and later (this is $(sw_vers -productVersion))"
  fi
}

check_container() {
  if ! command -v container >/dev/null 2>&1; then
    cat >&2 <<'EOF'
doop: error: Apple's `container` CLI is not installed.

  1. Download the signed installer (container-<version>-installer-signed.pkg) from
     https://github.com/apple/container/releases/latest
  2. Open it and follow the steps (it installs to /usr/local/bin/container).
  3. Run this installer again.
EOF
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the secrets"
}

start_system() {
  if container system status >/dev/null 2>&1; then
    return 0
  fi
  say "starting Apple container services (first run downloads a Linux kernel)"
  container system start --enable-kernel-install
}

# ---------------------------------------------------------------- files
gen_hex() { openssl rand -hex 32; }
gen_key() { printf 'local:%s' "$(openssl rand -base64 32)"; }

# Writes ~/.doop/doop.env once; later runs only add a key that is missing, so
# the secrets (and anything the user added) survive every update.
write_env_file() {
  umask 077
  mkdir -p "$DOOP_HOME" "$DATA_DIR"
  chmod 700 "$DOOP_HOME"
  if [ ! -f "$ENV_FILE" ]; then
    cat >"$ENV_FILE" <<EOF
# doop local install. Generated on this Mac; never commit or share this file.
# BETTER_AUTH_URL and PORT are set by doop-local from DOOP_PORT.
# Add any optional setting from .env.example here (ANTHROPIC_API_KEY, SMTP_*, ...),
# then run: doop-local restart
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
  target="$BIN_DIR/doop-local"
  if [ -f "$0" ] && grep -q '^# doop-local: run doop on this Mac' "$0" 2>/dev/null; then
    cmp -s "$0" "$target" || cp "$0" "$target"
  else
    curl -fsSL "$DOOP_SCRIPT_URL" -o "$target.tmp" && mv "$target.tmp" "$target"
  fi
  chmod 755 "$target"
}

# ---------------------------------------------------------------- image
# Pull the arm64 image (native). If the registry has no arm64 build, run the
# amd64 one under Rosetta rather than building ~2 GB of image on this Mac.
pick_image() {
  if [ "$BUILD" = 1 ]; then
    build_image
    RUN_IMAGE=$LOCAL_TAG
    RUN_PLATFORM=
    return 0
  fi
  say "pulling $DOOP_IMAGE"
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
}

build_image() {
  src=$(mktemp -d "${TMPDIR:-/tmp}/doop-src.XXXXXX")
  say "downloading $DOOP_REPO@$DOOP_REF"
  curl -fsSL "https://codeload.github.com/$DOOP_REPO/tar.gz/refs/heads/$DOOP_REF" | tar -xz -C "$src" --strip-components 1
  say "building $LOCAL_TAG (several minutes the first time)"
  container build --platform linux/arm64 -t "$LOCAL_TAG" "$src"
  rm -rf "$src"
}

# ---------------------------------------------------------------- container
exists() { container inspect "$DOOP_NAME" >/dev/null 2>&1; }

remove_container() {
  if exists; then
    container stop "$DOOP_NAME" >/dev/null 2>&1 || true
    container delete --force "$DOOP_NAME" >/dev/null
  fi
}

# The `container run` invocation, one argument per line (the tests read it).
run_args() {
  printf '%s\n' run --detach --name "$DOOP_NAME" \
    --publish "127.0.0.1:$DOOP_PORT:4400" \
    --volume "$DATA_DIR:/app/data" \
    --env-file "$ENV_FILE" \
    --env "BETTER_AUTH_URL=http://localhost:$DOOP_PORT" \
    --env PORT=4400
  if [ "$RUN_PLATFORM" = amd64 ]; then
    printf '%s\n' --platform linux/amd64 --rosetta
  fi
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
  container "$@" >/dev/null
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
  say "doop did not answer within ${DOOP_HEALTH_TIMEOUT}s. Last log lines:"
  container logs -n 40 "$DOOP_NAME" >&2 || true
  exit 1
}

ready() {
  cat <<EOF

doop is running: http://localhost:$DOOP_PORT
  MCP endpoint:  http://localhost:$DOOP_PORT/mcp
  data:          $DATA_DIR
  secrets:       $ENV_FILE
  manage it:     $BIN_DIR/doop-local [start|stop|restart|status|logs|update|uninstall]
After a reboot, run: $BIN_DIR/doop-local start
EOF
}

do_install() {
  check_platform
  check_container
  start_system
  write_env_file
  install_helper
  pick_image
  remove_container
  say "starting $DOOP_NAME on 127.0.0.1:$DOOP_PORT"
  run_container
  wait_healthy
  ready
}

do_start() {
  check_container
  start_system
  exists || die "no '$DOOP_NAME' container yet: run the installer first"
  container start "$DOOP_NAME" >/dev/null
  wait_healthy
  ready
}

do_stop() {
  check_container
  if exists; then
    container stop "$DOOP_NAME" >/dev/null
    say "stopped (data kept in $DATA_DIR)"
  else
    say "no '$DOOP_NAME' container"
  fi
}

do_status() {
  check_container
  container list --all
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
  check_container
  remove_container
  container image delete "$DOOP_IMAGE" >/dev/null 2>&1 || true
  container image delete "$LOCAL_TAG" >/dev/null 2>&1 || true
  say "container and image removed"
  if [ -d "$DOOP_HOME" ]; then
    if confirm "Delete $DOOP_HOME (every canvas, upload and secret)?"; then
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
      check_container
      container logs --follow "$DOOP_NAME"
      ;;
    uninstall) do_uninstall ;;
  esac
}

# DOOP_INSTALL_LIB=1 defines the functions without running anything (tests).
if [ "${DOOP_INSTALL_LIB:-0}" != 1 ]; then
  main "$@"
fi
