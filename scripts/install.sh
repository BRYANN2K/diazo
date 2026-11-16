#!/bin/sh
# diazo: install, update and run Diazo on this Mac, the server and the app.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install.sh | sh
#   ... | sh -s -- --app-only        the app only (it connects to another server)
#   ... | sh -s -- --server-only     the server only (use it from a browser)
#   ... | sh -s -- --dry-run         print the steps, change nothing
#
# The all-in-one install. It runs the two installers it is made of rather
# than repeating them: scripts/install-local.sh sets up the `diazo` container
# (Apple `container`, 127.0.0.1:4400, data in ~/.diazo, or a pre-rename
# ~/.doop kept where it is) and scripts/install-desktop.sh installs Diazo.app.
# Around them it adds:
#   - a LaunchAgent (~/Library/LaunchAgents/dev.bryann2k.diazo.server.plist)
#     that starts the container services and the `diazo` container at login,
#     logging to ~/Library/Logs/Diazo;
#   - the app's server choice, server.json in ~/Library/Application Support/
#     dev.bryann2k.diazo, set to this Mac's server unless another one is
#     already chosen (--use-local replaces it), so the app opens it directly;
#   - the `diazo` command (this script, copied to <data folder>/bin/diazo with
#     the two installers in <data folder>/lib, and linked into /usr/local/bin
#     or ~/.local/bin), which drives the container, the LaunchAgent and the
#     app together.
# Re-running it (or `diazo update`) updates both; data, secrets and the
# server choice are kept.
#
# Settings (environment): those of install-local.sh (DOOP_HOME, DOOP_PORT,
# DOOP_NAME, DOOP_IMAGE, ...) and install-desktop.sh (DOOP_DESKTOP_DIR, ...),
# plus DIAZO_REPO / DIAZO_REF (where the scripts are downloaded from),
# DIAZO_LIB (a folder holding install-local.sh and install-desktop.sh to use
# instead of downloading them), DIAZO_LINK_DIRS (where `diazo` is linked,
# first usable one wins: "/usr/local/bin $HOME/.local/bin").

set -eu

DIAZO_REPO=${DIAZO_REPO:-BRYANN2K/diazo}
DIAZO_REF=${DIAZO_REF:-main}
DIAZO_RAW=${DIAZO_RAW:-"https://raw.githubusercontent.com/$DIAZO_REPO/$DIAZO_REF/scripts"}
DIAZO_LINK_DIRS=${DIAZO_LINK_DIRS:-"/usr/local/bin $HOME/.local/bin"}
DOOP_PORT=${DOOP_PORT:-4400}
DOOP_NAME=${DOOP_NAME:-diazo}
# Apple's container from this version on (the first stable release)
MIN_CONTAINER_MAJOR=1
CONTAINER_RELEASES=https://github.com/apple/container/releases/latest

LABEL=dev.bryann2k.diazo.server
BUNDLE_ID=dev.bryann2k.diazo
APP_DATA="$HOME/Library/Application Support/$BUNDLE_ID"
# the app's folder before the rename, copied over on Diazo's first launch
OLD_APP_DATA="$HOME/Library/Application Support/design.doop.desktop"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Diazo"
SYSTEM_APPS=${DOOP_DESKTOP_SYSTEM_APPS:-/Applications}
LOCAL_URL="http://127.0.0.1:$DOOP_PORT"

# The data folder, by install-local.sh's rule: an explicit DOOP_HOME, else
# ~/.diazo, else a pre-rename ~/.doop kept in place.
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
export DOOP_HOME DOOP_PORT DOOP_NAME
BIN_DIR="$DOOP_HOME/bin"
LIB_HOME="$DOOP_HOME/lib"
# which parts this Mac has: server=1, app=1 (read by `diazo update`)
CONF="$DOOP_HOME/install.conf"
COMMAND="$BIN_DIR/diazo"

ACTION=install
WANT_SERVER=1
WANT_APP=1
USE_LOCAL=0
DRY_RUN=0
PURGE=0
OPEN_APP=1
VERSION=
WORK=
LIB=

say() { printf '%s\n' "diazo: $*"; }
die() {
  printf '%s\n' "diazo: error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]
       diazo <command> [options]

Installs or updates Diazo on this Mac: the server (a container on
127.0.0.1:4400, started at login) and the app (Diazo.app, opening that server).

Commands (of the installed `diazo` command; install.sh with none installs):
  start             start the server (and its container services)
  stop              stop the server (data kept)
  restart           stop, then start
  status            the server, the LaunchAgent, the app and its server choice
  logs              follow the server's logs (login starts: ~/Library/Logs/Diazo)
  update            download the latest scripts, then update the server and the app
  open              open Diazo.app (or the server in a browser without the app)
  uninstall         as --uninstall (with --purge: as --uninstall --purge)

Options:
  --app-only        install the app only (no container)
  --server-only     install the server only (no app)
  --use-local       point the app at this Mac's server even if another one is chosen
  --version X.Y.Z   install that app release instead of the latest one
  --dry-run         print what would be done, change nothing
  --uninstall       remove the server, the LaunchAgent, the app and the command;
                    canvases, secrets and the app's sign-in are kept
  --purge           with --uninstall: delete those too
  -h, --help        this help
EOF
}

# ---------------------------------------------------------------- arguments
parse_args() {
  # the installed command does nothing unasked; the installer installs
  case ${0##*/} in
    diazo) ACTION=help ;;
  esac
  while [ $# -gt 0 ]; do
    case $1 in
      install | --install) ACTION=install ;;
      update | --update) ACTION=update ;;
      start | stop | restart | status | logs | open | autostart) ACTION=$1 ;;
      --no-open) OPEN_APP=0 ;;
      uninstall | --uninstall) ACTION=uninstall ;;
      --purge) PURGE=1 ;;
      --app-only) WANT_SERVER=0 ;;
      --server-only) WANT_APP=0 ;;
      --use-local) USE_LOCAL=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --version)
        [ $# -ge 2 ] || die "--version needs a version, e.g. --version 0.16.0"
        VERSION=$2
        shift
        ;;
      --version=*) VERSION=${1#--version=} ;;
      -h | --help | help) ACTION=help ;;
      *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done
  [ "$WANT_SERVER" = 1 ] || [ "$WANT_APP" = 1 ] || die "--app-only and --server-only leave nothing to install"
  if [ "$PURGE" = 1 ] && [ "$ACTION" != uninstall ]; then
    die "--purge goes with --uninstall"
  fi
}

# ---------------------------------------------------------------- checks
# Why this Mac cannot run the server, or nothing when it can.
server_blocker() {
  if [ "$(uname -m)" != arm64 ]; then
    printf '%s' "the server runs on Apple silicon only (this Mac is $(uname -m))"
    return 0
  fi
  version=$(sw_vers -productVersion 2>/dev/null || true)
  major=${version%%.*}
  case $major in
    '' | *[!0-9]*) ;;
    *)
      if [ "$major" -lt 26 ]; then
        printf '%s' "the server needs macOS 26 or later (this is $version)"
        return 0
      fi
      ;;
  esac
  if ! command -v container >/dev/null 2>&1; then
    printf '%s' "Apple's container is not installed"
    return 0
  fi
  cv=$(container --version 2>/dev/null | sed -n 's/[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p' | head -n 1)
  case ${cv%%.*} in
    '' | *[!0-9]*)
      printf '%s' "could not read Apple's container version"
      return 0
      ;;
  esac
  if [ "${cv%%.*}" -lt "$MIN_CONTAINER_MAJOR" ]; then
    printf '%s' "Apple's container is $cv; the server needs $MIN_CONTAINER_MAJOR.0 or later"
  fi
}

check_platform() {
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS (this is $(uname -s)). Elsewhere, self-host with: docker compose up"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  [ "$WANT_SERVER" = 1 ] || return 0
  blocker=$(server_blocker)
  [ -n "$blocker" ] || return 0
  printf '%s\n' "diazo: $blocker." >&2
  case $blocker in
    *container*)
      cat >&2 <<EOF

  Install Apple's container ($MIN_CONTAINER_MAJOR.0 or later):
  1. Download the signed installer (container-<version>-installer-signed.pkg) from
     $CONTAINER_RELEASES
  2. Open it and follow the steps (it installs to /usr/local/bin/container).
  3. Run this installer again.

EOF
      ;;
  esac
  if [ "$WANT_APP" = 1 ] && confirm "Install only the Diazo app now (it can connect to another server)?"; then
    WANT_SERVER=0
    return 0
  fi
  if [ "$WANT_APP" = 1 ]; then
    say "nothing was installed. For the app alone, run this again with --app-only"
  else
    say "nothing was installed"
  fi
  exit 1
}

# Reads the answer from the terminal: under `curl | sh` stdin is the script.
confirm() {
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

# ---------------------------------------------------------------- the scripts
cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

work_dir() {
  if [ -z "$WORK" ]; then
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/diazo-install.XXXXXX")
    trap cleanup EXIT
    trap 'exit 130' INT TERM
  fi
}

fetch() { curl -fsSL --retry 3 --proto '=https' -o "$2" "$1"; }

# This script's own file, when it runs from one (not under `curl | sh`).
self_file() {
  case $0 in
    */*) if [ -f "$0" ] && grep -q '^# diazo: install, update and run Diazo' "$0" 2>/dev/null; then printf '%s' "$0"; fi ;;
  esac
}

has_libs() { [ -f "$1/install-local.sh" ] && [ -f "$1/install-desktop.sh" ]; }

# Where install-local.sh and install-desktop.sh are: DIAZO_LIB, else beside
# this script (a checkout, or a fresh download by `diazo update`), else
# downloaded. `fresh` (installing) never takes the copies installed in
# <data folder>/lib, which are the previous version's.
find_libs() {
  self=$(self_file)
  if [ -n "${DIAZO_LIB:-}" ]; then
    has_libs "$DIAZO_LIB" || die "DIAZO_LIB ($DIAZO_LIB) holds no install-local.sh and install-desktop.sh"
    LIB=$DIAZO_LIB
  elif [ -n "$self" ] && has_libs "$(dirname "$self")"; then
    LIB=$(dirname "$self")
  elif [ "${1:-}" != fresh ] && has_libs "$LIB_HOME"; then
    LIB=$LIB_HOME
  else
    work_dir
    for script in install-local.sh install-desktop.sh; do
      fetch "$DIAZO_RAW/$script" "$WORK/$script" || die "could not download $DIAZO_RAW/$script (offline?)"
    done
    LIB=$WORK
  fi
}

# `cp` then `mv`: a running copy of the command keeps reading its old file.
put() {
  cp "$1" "$2.tmp.$$"
  chmod "$3" "$2.tmp.$$"
  mv "$2.tmp.$$" "$2"
}

# ---------------------------------------------------------------- the server
install_server() {
  say "setting up the server (install-local.sh)"
  DIAZO_COMMAND=$COMMAND sh "$LIB/install-local.sh" install
}

# Escapes a value for the plist.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

write_plist() {
  mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
  cat >"$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$(xml "$COMMAND")</string>
    <string>autostart</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOOP_HOME</key>
    <string>$(xml "$DOOP_HOME")</string>
    <key>DOOP_PORT</key>
    <string>$DOOP_PORT</string>
    <key>DOOP_NAME</key>
    <string>$(xml "$DOOP_NAME")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG_DIR/server.log")</string>
</dict>
</plist>
EOF
  mv "$PLIST.tmp" "$PLIST"
}

# Loaded again on every install, so an edited plist takes effect; bootout
# fails harmlessly when it was not loaded.
register_agent() {
  write_plist
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$PLIST" || die "could not load the LaunchAgent $PLIST"
  say "the server starts at login (LaunchAgent $LABEL, logs in $LOG_DIR)"
}

unregister_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    say "removed the LaunchAgent"
  fi
}

# ---------------------------------------------------------------- the app
install_app() {
  say "installing the app (install-desktop.sh)"
  if [ -n "$VERSION" ]; then
    sh "$LIB/install-desktop.sh" --version "$VERSION"
  else
    sh "$LIB/install-desktop.sh"
  fi
}

# The url of a server.json, empty when there is none or it names none.
chosen_url() {
  [ -f "$1" ] || return 0
  sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

has_entries() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

# The server the app is set to open: its own server.json, or, before Diazo's
# first launch copies the pre-rename folder over, the old app's.
current_choice() {
  if [ -f "$APP_DATA/server.json" ]; then
    chosen_url "$APP_DATA/server.json"
  elif ! has_entries "$APP_DATA"; then
    chosen_url "$OLD_APP_DATA/server.json"
  fi
}

# Points the app at this Mac's server, unless another server is chosen and
# --use-local was not given. The shell reads it at launch (server.rs); a
# server on this computer may be plain http.
choose_local_server() {
  current=$(current_choice)
  if [ "$current" = "$LOCAL_URL" ]; then
    say "the app already opens this Mac's server"
    return 0
  fi
  if [ -n "$current" ] && [ "$USE_LOCAL" = 0 ]; then
    say "the app keeps the server it was set to ($current); --use-local points it at this Mac's"
    return 0
  fi
  mkdir -p "$APP_DATA"
  printf '{"url":"%s"}' "$LOCAL_URL" >"$APP_DATA/server.json.tmp"
  mv "$APP_DATA/server.json.tmp" "$APP_DATA/server.json"
  say "the app opens this Mac's server ($LOCAL_URL)"
}

app_installed() {
  [ -d "${DOOP_DESKTOP_DIR:-$SYSTEM_APPS}/Diazo.app" ] || [ -d "$SYSTEM_APPS/Diazo.app" ] || [ -d "$HOME/Applications/Diazo.app" ]
}

# ---------------------------------------------------------------- the record
record_parts() {
  mkdir -p "$DOOP_HOME"
  printf 'server=%s\napp=%s\n' "$1" "$2" >"$CONF"
}

conf_value() {
  [ -f "$CONF" ] || return 0
  sed -n "s/^$1=//p" "$CONF" | head -n 1
}

# ---------------------------------------------------------------- install
plan() {
  say "[dry run] nothing is changed. The steps:"
  if [ "$WANT_SERVER" = 1 ]; then
    printf '  %s\n' \
      "run install-local.sh: container '$DOOP_NAME' on 127.0.0.1:$DOOP_PORT, data in $DOOP_HOME" \
      "write $PLIST and load it (starts the server at login, logs in $LOG_DIR)"
  fi
  if [ "$WANT_APP" = 1 ]; then
    printf '  %s\n' "run install-desktop.sh${VERSION:+ --version $VERSION}: Diazo.app"
    if [ "$WANT_SERVER" = 1 ]; then
      current=$(current_choice)
      if [ -z "$current" ] || [ "$USE_LOCAL" = 1 ] || [ "$current" = "$LOCAL_URL" ]; then
        printf '  %s\n' "set the app's server to $LOCAL_URL ($APP_DATA/server.json)"
      else
        printf '  %s\n' "keep the app's server ($current)"
      fi
    fi
  fi
  printf '  %s\n' "install the diazo command in $COMMAND"
  if [ "$WANT_APP" = 1 ]; then
    printf '  %s\n' "open Diazo.app"
  fi
}

do_install() {
  check_platform
  if [ "$DRY_RUN" = 1 ]; then
    plan
    return 0
  fi
  find_libs fresh
  mkdir -p "$DOOP_HOME"
  install_command
  if [ "$WANT_SERVER" = 1 ]; then
    install_server
    register_agent
  fi
  if [ "$WANT_APP" = 1 ]; then
    # before the app installs, so an app it relaunches opens the right server
    if [ "$WANT_SERVER" = 1 ]; then
      choose_local_server
    fi
    install_app
  fi
  record_parts "$WANT_SERVER" "$WANT_APP"
  finish
}

finish() {
  printf '\n%s\n' "Diazo is installed."
  if [ "$WANT_SERVER" = 1 ]; then
    printf '  %s\n' "server:  http://localhost:$DOOP_PORT (starts at login)"
  fi
  printf '  %s\n' "manage:  diazo start|stop|restart|status|logs|update|open|uninstall"
  if [ "$WANT_APP" = 1 ] && [ "$OPEN_APP" = 1 ]; then
    if [ "$WANT_SERVER" = 1 ]; then
      printf '%s\n' "Opening Diazo: create your account (the first one on this server is its admin)."
    fi
    open -b "$BUNDLE_ID" 2>/dev/null || say "open Diazo from your Applications folder"
  fi
}

# ---------------------------------------------------------------- commands
# The server commands, for a Mac whose install has one (an install made by
# install-local.sh alone, with no record, counts).
need_server() {
  [ "$(uname -s)" = Darwin ] || die "Diazo's local server runs on macOS"
  if [ "$(conf_value server)" = 0 ]; then
    die "this Mac has no Diazo server (installed with --app-only). Run the installer without --app-only to add it"
  fi
  find_libs
}

local_cmd() { DIAZO_COMMAND=$COMMAND sh "$LIB/install-local.sh" "$@"; }

agent_loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

do_status() {
  if [ "$(conf_value server)" != 0 ]; then
    need_server
    local_cmd status || true
    if agent_loaded; then
      say "starts at login (LaunchAgent $LABEL, logs in $LOG_DIR)"
    elif [ -f "$PLIST" ]; then
      say "the LaunchAgent is not loaded: diazo update registers it again"
    else
      say "does not start at login (no LaunchAgent)"
    fi
  else
    say "no server on this Mac (app only)"
  fi
  if app_installed; then
    current=$(current_choice)
    say "Diazo.app is installed, set to ${current:-its default server}"
  else
    say "Diazo.app is not installed"
  fi
}

do_open() {
  if app_installed; then
    open -b "$BUNDLE_ID"
  else
    open "http://localhost:$DOOP_PORT"
  fi
}

# What is installed, as install flags: both unless the record says otherwise.
part_flags() {
  if [ "$(conf_value server)" = 0 ]; then
    printf '%s' --app-only
  elif [ "$(conf_value app)" = 0 ]; then
    printf '%s' --server-only
  fi
}

# Updates what this Mac has with the latest scripts: downloaded fresh, then
# run (this file is the previous version). With DIAZO_LIB or from a checkout,
# the scripts at hand are used.
do_update() {
  flags=$(part_flags)
  [ "$flags" != --app-only ] || WANT_SERVER=0
  [ "$flags" != --server-only ] || WANT_APP=0
  self=$(self_file)
  if [ -n "${DIAZO_LIB:-}" ] || { [ -n "$self" ] && has_libs "$(dirname "$self")"; }; then
    OPEN_APP=0
    do_install
    return 0
  fi
  work_dir
  for script in install.sh install-local.sh install-desktop.sh; do
    fetch "$DIAZO_RAW/$script" "$WORK/$script" || die "could not download $DIAZO_RAW/$script (offline?)"
  done
  # shellcheck disable=SC2086 # one flag or none
  sh "$WORK/install.sh" install --no-open $flags ${VERSION:+--version "$VERSION"}
}

# The LaunchAgent's login run: nothing when the server already answers.
do_autostart() {
  say "$(date '+%Y-%m-%d %H:%M:%S') starting at login"
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$DOOP_PORT/healthz" 2>/dev/null; then
    say "already answering on http://localhost:$DOOP_PORT"
    return 0
  fi
  need_server
  local_cmd start
}

# ---------------------------------------------------------------- uninstall
do_uninstall() {
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry run] would remove the LaunchAgent, the '$DOOP_NAME' container, Diazo.app and the diazo command"
    if [ "$PURGE" = 1 ]; then
      say "[dry run] and delete $DOOP_HOME, $APP_DATA and $LOG_DIR"
    fi
    return 0
  fi
  find_libs
  unregister_agent
  # the app first: purging the server deletes the data folder, lib/ included
  sh "$LIB/install-desktop.sh" --uninstall
  if command -v container >/dev/null 2>&1; then
    if [ "$PURGE" = 1 ]; then
      sh "$LIB/install-local.sh" uninstall --yes
    else
      sh "$LIB/install-local.sh" uninstall --keep-data
    fi
  fi
  remove_command
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DOOP_HOME" "$APP_DATA" "$LOG_DIR"
    say "deleted $DOOP_HOME, $APP_DATA and $LOG_DIR"
  else
    rm -f "$CONF"
    say "kept $DOOP_HOME (canvases, secrets) and $APP_DATA (sign-in); --uninstall --purge deletes them"
  fi
}

# ---------------------------------------------------------------- the command
install_command() {
  mkdir -p "$BIN_DIR" "$LIB_HOME"
  self=$(self_file)
  if [ -n "$self" ]; then
    [ "$self" -ef "$COMMAND" ] || put "$self" "$COMMAND" 755
  else
    work_dir
    fetch "$DIAZO_RAW/install.sh" "$WORK/install.sh" || die "could not download $DIAZO_RAW/install.sh"
    put "$WORK/install.sh" "$COMMAND" 755
  fi
  for script in install-local.sh install-desktop.sh; do
    [ "$LIB/$script" -ef "$LIB_HOME/$script" ] || put "$LIB/$script" "$LIB_HOME/$script" 644
  done
  link_command
}

# Links `diazo` into the first folder of DIAZO_LINK_DIRS that takes it: one
# that exists and is writable, or one under $HOME, created. A `diazo` there
# that is not our link is left alone.
link_command() {
  for dir in $DIAZO_LINK_DIRS; do
    case $dir in
      "$HOME"/*) mkdir -p "$dir" 2>/dev/null || continue ;;
    esac
    [ -d "$dir" ] && [ -w "$dir" ] || continue
    if [ -e "$dir/diazo" ] && [ ! -L "$dir/diazo" ]; then
      say "left $dir/diazo alone (not a link this installer made)"
      continue
    fi
    rm -f "$dir/diazo"
    ln -s "$COMMAND" "$dir/diazo"
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) say "add $dir to your PATH to type diazo: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zprofile" ;;
    esac
    return 0
  done
  say "run the command as $COMMAND"
}

remove_command() {
  for dir in $DIAZO_LINK_DIRS; do
    if [ -L "$dir/diazo" ] && [ "$(readlink "$dir/diazo")" = "$COMMAND" ]; then
      rm -f "$dir/diazo"
    fi
  done
  rm -f "$COMMAND"
  rm -rf "$LIB_HOME"
}

main() {
  parse_args "$@"
  case $ACTION in
    help) usage ;;
    install) do_install ;;
    update) do_update ;;
    uninstall) do_uninstall ;;
    start | stop | restart)
      need_server
      local_cmd "$ACTION"
      ;;
    logs)
      need_server
      say "login starts log to $LOG_DIR/server.log; the container's own logs follow"
      local_cmd logs
      ;;
    status) do_status ;;
    open) do_open ;;
    autostart) do_autostart ;;
  esac
}

# DOOP_INSTALL_LIB=1 defines the functions without running anything (tests).
if [ "${DOOP_INSTALL_LIB:-0}" != 1 ]; then
  main "$@"
fi
