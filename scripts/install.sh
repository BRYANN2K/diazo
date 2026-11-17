#!/bin/sh
# diazo: install, update and run Diazo on this computer, the server and the app.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install.sh | sh
#   ... | sh -s -- --remote https://diazo.example.com   the app only, on that server
#   ... | sh -s -- --app-only        the app only (it connects to another server)
#   ... | sh -s -- --server-only     the server only (use it from a browser)
#   ... | sh -s -- --dry-run         print the steps, change nothing
#
# The all-in-one install. It detects the system and picks one of two modes:
#
#   local   the server runs on this machine: in an Apple `container` on macOS
#           (Apple silicon, macOS 26+), in Docker or Podman on Linux, from
#           scripts/install-local.sh; scripts/install-desktop.sh installs the
#           app, pointed at http://127.0.0.1:4400 unless another server is
#           already chosen (--use-local replaces it). The server starts at
#           login: a LaunchAgent on macOS, a systemd user unit on Linux. On
#           Windows it does not run: use WSL2 + Docker, or --remote.
#   remote  the app only, pointed at a server elsewhere (--remote <url>, or
#           the interactive choice when run on a terminal). The address is
#           checked the way the app checks it (https, or http on this
#           computer) and <origin>/api/locale-config must answer; then the
#           app's server.json is written. No container or autostart is set up.
#
# Around them it installs the `diazo` command (this script, copied to
# <data folder>/bin/diazo with the two installers in <data folder>/lib, and
# linked into /usr/local/bin or ~/.local/bin), which drives the container, the
# autostart and the app together. Re-running it (or `diazo update`) updates
# what <data folder>/install.conf records; data, secrets and the server
# choice are kept. On Windows (a Git Bash / MSYS / Cygwin uname) it prints the
# PowerShell installer's one-liner.
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
OLD_BUNDLE_ID=design.doop.desktop
LOCAL_URL="http://127.0.0.1:$DOOP_PORT"
POWERSHELL_LINE="irm https://raw.githubusercontent.com/$DIAZO_REPO/$DIAZO_REF/scripts/install-desktop.ps1 | iex"

# The system this script runs on: macos, linux or windows.
detect_os() {
  case $(uname -s) in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    MINGW* | MSYS* | CYGWIN*) OS=windows ;;
    *) OS=other ;;
  esac
}
detect_os

# Per-system folders: the app's data (server.json, sign-in), its pre-rename
# one the first launch migrates, autostart and logs.
case $OS in
  macos)
    APP_DATA="$HOME/Library/Application Support/$BUNDLE_ID"
    OLD_APP_DATA="$HOME/Library/Application Support/$OLD_BUNDLE_ID"
    ;;
  linux)
    XDG_DATA=${XDG_DATA_HOME:-$HOME/.local/share}
    APP_DATA="$XDG_DATA/$BUNDLE_ID"
    OLD_APP_DATA="$XDG_DATA/$OLD_BUNDLE_ID"
    ;;
  *)
    APP_DATA=
    OLD_APP_DATA=
    ;;
esac
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Diazo"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/diazo.service"
SYSTEM_APPS=${DOOP_DESKTOP_SYSTEM_APPS:-/Applications}
# how install-local.sh's messages name the login start
case $OS in
  macos) AUTOSTART_DESC="LaunchAgent $LABEL" ;;
  *) AUTOSTART_DESC="systemd user unit diazo.service" ;;
esac

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
# what this install recorded: mode (local or remote), server=, app=, remote=
CONF="$DOOP_HOME/install.conf"
COMMAND="$BIN_DIR/diazo"

ACTION=install
MODE=local
MODE_GIVEN=0
REMOTE_URL=
REMOTE_ORIGIN=
# 1 when --remote came from the person (flag or the prompt), 0 when
# `diazo update` replayed the record: only an explicit one may replace a
# server picked in the app
REMOTE_EXPLICIT=0
WANT_SERVER=1
WANT_APP=1
APP_ONLY=0
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

Installs or updates Diazo on this computer. Two modes:

  local (default)   the server runs here: an Apple `container` on macOS,
                    Docker or Podman on Linux, plus the app pointed at it;
                    the server starts at login
  --remote <url>    the app only, pointed at a Diazo server elsewhere
                    (https, or http on this computer)

Run on a terminal with no mode given, it asks which one. On Windows the
script prints the PowerShell installer's one-liner.

Commands (of the installed `diazo` command; install.sh with none installs):
  start             start the server (and its container services)
  stop              stop the server (data kept)
  restart           stop, then start
  status            the server, the login start, the app and its server choice
  logs              follow the server's logs
  update            download the latest scripts, then update what install.conf records
  open              open the app (or the server in a browser without the app)
  uninstall         as --uninstall (with --purge: as --uninstall --purge)

Options:
  --remote <url>    remote mode: install the app pointed at that server
  --local           local mode without asking (the default; skips the prompt)
  --app-only        local mode without the server (the app picks a server itself)
  --server-only     local mode without the app (serve browsers, or a VPS)
  --use-local       point the app at this computer's server even if another one is chosen
  --version X.Y.Z   install that app release instead of the latest one
  --dry-run         print what would be done, change nothing
  --uninstall       remove the server, the autostart, the app and the command;
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
      --app-only)
        WANT_SERVER=0
        APP_ONLY=1
        MODE_GIVEN=1
        ;;
      --local)
        MODE=local
        MODE_GIVEN=1
        ;;
      --server-only)
        WANT_APP=0
        MODE_GIVEN=1
        ;;
      --use-local) USE_LOCAL=1 ;;
      --remote)
        case ${2:-} in
          -*) die "--remote needs a server address, e.g. --remote https://diazo.example.com" ;;
          '') die "--remote needs a server address, e.g. --remote https://diazo.example.com" ;;
        esac
        MODE=remote
        MODE_GIVEN=1
        REMOTE_URL=$2
        REMOTE_EXPLICIT=1
        shift
        ;;
      --remote=*)
        MODE=remote
        MODE_GIVEN=1
        REMOTE_URL=${1#--remote=}
        REMOTE_EXPLICIT=1
        ;;
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
  if [ "$MODE" = remote ]; then
    WANT_SERVER=0
    if [ "$APP_ONLY" = 1 ] || [ "$WANT_APP" = 0 ] || [ "$USE_LOCAL" = 1 ]; then
      die "--remote cannot go with --app-only, --server-only or --use-local"
    fi
    [ -n "$REMOTE_URL" ] || die "--remote needs a server address"
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

# Why this Linux box cannot run the server, or nothing when it can.
linux_server_blocker() {
  if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
    return 0
  fi
  printf '%s' "the local server runs in a container, and neither Docker nor Podman is installed"
}

# The mode, when the arguments did not pick one and a terminal can answer.
ask_mode() {
  [ "$MODE_GIVEN" = 0 ] || return 0
  [ "$ACTION" = install ] || return 0
  case $OS in
    macos | linux) ;;
    *) return 0 ;;
  esac
  if ! { [ -r /dev/tty ] && { true </dev/tty; } 2>/dev/null; }; then
    return 0
  fi
  cat >/dev/tty <<'EOF'

Where does the Diazo server run?
  1) On this computer (local install: server and app)
  2) On another machine (remote server: the app only)
EOF
  printf '%s' "Choose [1]: " >/dev/tty
  read -r answer </dev/tty || answer=
  case $answer in
    2 | remote | r)
      MODE=remote
      printf '%s' "The server's address (https://…): " >/dev/tty
      read -r REMOTE_URL </dev/tty || REMOTE_URL=
      [ -n "$REMOTE_URL" ] || die "no server address given"
      REMOTE_EXPLICIT=1
      WANT_SERVER=0
      ;;
    *) ;;
  esac
}

check_platform() {
  case $OS in
    windows)
      if [ "$MODE" = remote ] && [ -n "$REMOTE_URL" ]; then
        cat >&2 <<EOF
diazo: this shell installer does not run on Windows. In PowerShell:

  \$env:DOOP_DESKTOP_SERVER='$REMOTE_URL'; $POWERSHELL_LINE

EOF
      else
        cat >&2 <<EOF
diazo: this shell installer does not run on Windows. In PowerShell:

  $POWERSHELL_LINE

The local server needs macOS or Linux; on Windows use WSL2 with Docker, or
run the app pointed at a server (the -Server choice, or the app's cog).
EOF
      fi
      exit 1
      ;;
    other) die "unsupported system: $(uname -s)" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required"
  [ "$WANT_SERVER" = 1 ] || return 0
  case $OS in
    macos) blocker=$(server_blocker) ;;
    linux) blocker=$(linux_server_blocker) ;;
  esac
  [ -n "$blocker" ] || return 0
  printf '%s\n' "diazo: $blocker." >&2
  case $blocker in
    *container*)
      if [ "$OS" = macos ]; then
        cat >&2 <<EOF

  Install Apple's container ($MIN_CONTAINER_MAJOR.0 or later):
  1. Download the signed installer (container-<version>-installer-signed.pkg) from
     $CONTAINER_RELEASES
  2. Open it and follow the steps (it installs to /usr/local/bin/container).
  3. Run this installer again.

EOF
      else
        cat >&2 <<'EOF'

  Install Docker:   https://docs.docker.com/engine/install/
  (or Podman:       https://podman.io/docs/installation)
  then run this installer again.

EOF
      fi
      ;;
  esac
  if [ "$WANT_APP" = 1 ] && confirm "Install only the Diazo app now (it can connect to another server)?"; then
    WANT_SERVER=0
    return 0
  fi
  if [ "$WANT_APP" = 1 ]; then
    say "nothing was installed. For the app alone, run this again with --app-only, or --remote <url> for a server elsewhere"
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
  DIAZO_COMMAND=$COMMAND DIAZO_AUTOSTART="$AUTOSTART_DESC" sh "$LIB/install-local.sh" install
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

# ---------------------------------------------------------------- the unit (Linux)
# A systemd user unit does what the LaunchAgent does on macOS: at login,
# `diazo autostart` starts the container when /healthz does not answer. (The
# container's own restart policy covers crashes and, under Docker, reboots.)
write_unit() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT.tmp" <<EOF
[Unit]
Description=Diazo local server

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=DOOP_HOME=$DOOP_HOME
Environment=DOOP_PORT=$DOOP_PORT
Environment=DOOP_NAME=$DOOP_NAME
ExecStart=$COMMAND autostart

[Install]
WantedBy=default.target
EOF
  mv "$UNIT.tmp" "$UNIT"
}

# Enabled on every install; a user session without a working systemd (older
# distributions, containers) gets a note instead of an autostart.
register_unit() {
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user daemon-reload >/dev/null 2>&1; then
    say "no systemd user session: the server does not start at login (start it with: $COMMAND start; loginctl enable-linger also starts it at boot)"
    return 0
  fi
  write_unit
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable diazo.service >/dev/null 2>&1 || die "could not enable $UNIT"
  say "the server starts at login (systemd user unit diazo.service; logs: journalctl --user -u diazo.service)"
}

unregister_unit() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable diazo.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -f "$UNIT" ]; then
    rm -f "$UNIT"
    say "removed the systemd user unit"
  fi
}

register_autostart() {
  case $OS in
    macos) register_agent ;;
    linux) register_unit ;;
  esac
}

unregister_autostart() {
  case $OS in
    macos) unregister_agent ;;
    linux) unregister_unit ;;
  esac
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

# Writes server.json (mkdir first) and says so.
write_server_json() {
  mkdir -p "$APP_DATA"
  printf '{"url":"%s"}' "$1" >"$APP_DATA/server.json.tmp"
  mv "$APP_DATA/server.json.tmp" "$APP_DATA/server.json"
}

# Points the app at this computer's server, unless another server is chosen
# and --use-local was not given. The shell reads it at launch (server.rs); a
# server on this computer may be plain http.
choose_local_server() {
  current=$(current_choice)
  if [ "$current" = "$LOCAL_URL" ]; then
    say "the app already opens this computer's server"
    return 0
  fi
  if [ -n "$current" ] && [ "$USE_LOCAL" = 0 ]; then
    say "the app keeps the server it was set to ($current); --use-local points it at this computer's"
    return 0
  fi
  write_server_json "$LOCAL_URL"
  say "the app opens this computer's server ($LOCAL_URL)"
}

# ---------------------------------------------------------------- remote mode
# What server.rs's `secure` accepts for plain http: `localhost`, or an IP
# literal that parses as loopback — 127.0.0.0/8 as four numeric octets
# (`127.example.com` or `127.1.2.3.evil.com` are a name, not the address), or
# ::1. Anything else needs https.
is_loopback() {
  case $1 in
    localhost | ::1 | 0:0:0:0:0:0:0:1) return 0 ;;
    *:*)
      # every IPv6 spelling of ::1: all-zero or empty groups, then a last
      # group of 1 — the same set IpAddr::is_loopback() accepts
      old_ifs=$IFS
      IFS=:
      # shellcheck disable=SC2086 # the groups, split on purpose
      set -- $1
      IFS=$old_ifs
      while [ $# -gt 1 ]; do
        case $1 in
          '' | 0 | 00 | 000 | 0000) shift ;;
          *) return 1 ;;
        esac
      done
      case $1 in
        1 | 01 | 001 | 0001) return 0 ;;
        *) return 1 ;;
      esac
      ;;
  esac
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # the four octets, split on purpose
  set -- $1
  IFS=$old_ifs
  if [ $# -ne 4 ] || [ "$1" != 127 ]; then
    return 1
  fi
  for octet do
    case $octet in
      '' | *[!0-9]* | 0?*) return 1 ;;
    esac
    [ "$octet" -le 255 ] || return 1
  done
}

# A typed server address as the origin it names, checked the way the app's
# server.rs checks it: https, or plain http on this computer only; never the
# original doop service.
normalize_remote() {
  in=$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$in" ] || die "enter the address of a Diazo server"
  case $in in *://*) ;; *) in="https://$in" ;; esac
  rest=${in#*://}
  [ "$rest" != "$in" ] || die "the address must start with https:// or http://"
  scheme=$(printf '%s' "${in%%://*}" | tr '[:upper:]' '[:lower:]')
  case $scheme in
    http | https) ;;
    *) die "the address must start with https:// or http://" ;;
  esac
  authority=$(printf '%s' "$rest" | sed 's#[/?#].*$##')
  case $authority in
    *@*) die "the address must not contain a user name or password" ;;
  esac
  case $authority in
    \[*\]*)
      host=$(printf '%s' "$authority" | sed -n 's/^\[\([^]]*\)\].*/\1/p')
      port=$(printf '%s' "$authority" | sed -n 's/^\[[^]]*\]:\(.*\)/\1/p')
      # nothing but the port may follow the closing bracket
      case ${authority#*\]} in
        '' | :*) ;;
        *) die "'$1' is not a web address" ;;
      esac
      ;;
    *:*)
      host=${authority%%:*}
      port=${authority##*:}
      ;;
    *)
      host=$authority
      port=
      ;;
  esac
  host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
  [ -n "$host" ] || die "'$1' is not a web address"
  # the host goes raw into server.json and is replayed unquoted by
  # `diazo update`: a domain name, or a bracketed IPv6 literal, nothing else
  case $host in
    *:*)
      case $host in
        *[!0-9a-f:.]*) die "'$1' is not a valid host name" ;;
      esac
      ;;
    *)
      case $host in
        *[!a-z0-9.-]*) die "'$1' is not a valid host name" ;;
      esac
      ;;
  esac
  case $port in
    '') ;;
    *[!0-9]*) die "not a port in '$1'" ;;
    *) [ "$port" -le 65535 ] || die "not a port in '$1'" ;;
  esac
  loopback=0
  is_loopback "$host" && loopback=1
  if [ "$scheme" != https ] && [ "$loopback" = 0 ]; then
    die "$scheme://$host is not secure. Use an https:// address; plain http:// only works for a server on this computer"
  fi
  case $host in
    doop.design | www.doop.design)
      die "$host is the original doop service, not a Diazo server. Use the doop app for it"
      ;;
  esac
  case $host in
    *:*) origin="$scheme://[$host]" ;;
    *) origin="$scheme://$host" ;;
  esac
  if [ -n "$port" ]; then
    case $scheme:$port in
      https:443 | http:80) ;;
      *) origin="$origin:$port" ;;
    esac
  fi
  printf '%s' "$origin"
}

# Every Diazo server answers this public route, so a typo or another site is
# caught before anything is written. Like server.rs's probe: redirects are
# followed, and the origin that actually answered — checked again the same
# way, so a redirect to plain http off this computer fails too — is the one
# REMOTE_ORIGIN keeps.
probe_remote() {
  say "checking $1/api/locale-config"
  work_dir
  answered=$(curl -fsSL --max-time 8 -o "$WORK/probe-body" -w '%{url_effective}' "$1/api/locale-config" 2>/dev/null) ||
    die "no Diazo server answered at $1; check the address and try again"
  case $(cat "$WORK/probe-body") in
    *defaultLocale*) ;;
    *) die "no Diazo server answered at $1; check the address and try again" ;;
  esac
  REMOTE_ORIGIN=$(normalize_remote "$answered")
}

# Points the app at the remote server. An explicit --remote replaces another
# choice; a `diazo update` replay keeps a server picked in the app, the way a
# local-mode update already does.
choose_remote_server() {
  current=$(current_choice)
  if [ "$current" = "$REMOTE_ORIGIN" ]; then
    say "the app already opens $REMOTE_ORIGIN"
    return 0
  fi
  if [ "$REMOTE_EXPLICIT" = 0 ] && [ -n "$current" ]; then
    say "the app keeps the server it was set to ($current); run the installer with --remote <url> to change it"
    return 0
  fi
  write_server_json "$REMOTE_ORIGIN"
  say "the app opens $REMOTE_ORIGIN"
}

app_installed() {
  case $OS in
    macos)
      [ -d "${DOOP_DESKTOP_DIR:-$SYSTEM_APPS}/Diazo.app" ] || [ -d "$SYSTEM_APPS/Diazo.app" ] || [ -d "$HOME/Applications/Diazo.app" ]
      ;;
    linux)
      for file in "$HOME"/.local/bin/Diazo_*_amd64.AppImage "$HOME"/Applications/Diazo_*_amd64.AppImage; do
        [ -f "$file" ] && return 0
      done
      if command -v dpkg >/dev/null 2>&1 && dpkg -s diazo >/dev/null 2>&1; then
        return 0
      fi
      if command -v rpm >/dev/null 2>&1 && rpm -q diazo >/dev/null 2>&1; then
        return 0
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------- the record
record_parts() {
  mkdir -p "$DOOP_HOME"
  remote=
  if [ "$MODE" = remote ]; then
    remote=${REMOTE_ORIGIN:-$(conf_value remote)}
  fi
  printf 'mode=%s\nserver=%s\napp=%s\nremote=%s\n' "$MODE" "$1" "$2" "$remote" >"$CONF"
}

conf_value() {
  [ -f "$CONF" ] || return 0
  sed -n "s/^$1=//p" "$CONF" | head -n 1
}

# The recorded mode: empty (a record from before modes existed, meaning
# local), local or remote. Anything else was written by a newer installer;
# replaying it would turn e.g. an embedded install into a container install,
# so it is an error instead.
conf_mode() {
  mode=$(conf_value mode)
  case $mode in
    '' | local | remote) printf '%s' "$mode" ;;
    *) die "$CONF records mode '$mode', which this installer does not know. Get the latest Diazo installer and run this again" ;;
  esac
}

# ---------------------------------------------------------------- install
plan() {
  say "[dry run] nothing is changed. The steps:"
  if [ "$MODE" = remote ]; then
    printf '  %s\n' \
      "check $REMOTE_URL (https or http on this computer, /api/locale-config answers)" \
      "run install-desktop.sh${VERSION:+ --version $VERSION}: the app for this system" \
      "set the app's server to that origin ($APP_DATA/server.json)" \
      "install the diazo command in $COMMAND"
    return 0
  fi
  if [ "$WANT_SERVER" = 1 ]; then
    case $OS in
      macos)
        printf '  %s\n' \
          "run install-local.sh: container '$DOOP_NAME' on 127.0.0.1:$DOOP_PORT, data in $DOOP_HOME" \
          "write $PLIST and load it (starts the server at login, logs in $LOG_DIR)"
        ;;
      linux)
        printf '  %s\n' \
          "run install-local.sh: container '$DOOP_NAME' (Docker or Podman) on 127.0.0.1:$DOOP_PORT, data in $DOOP_HOME" \
          "write $UNIT and enable it (starts the server at login)"
        ;;
    esac
  fi
  if [ "$WANT_APP" = 1 ]; then
    printf '  %s\n' "run install-desktop.sh${VERSION:+ --version $VERSION}: the app for this system"
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
    printf '  %s\n' "open the app"
  fi
}

do_install() {
  ask_mode
  check_platform
  if [ "$MODE" = remote ]; then
    # `diazo update` replays the recorded --remote (DIAZO_UPDATE marks the
    # re-run): a remembered choice, not a new one, so a server picked in the
    # app wins
    [ "${DIAZO_UPDATE:-0}" = 1 ] && REMOTE_EXPLICIT=0
    REMOTE_ORIGIN=$(normalize_remote "$REMOTE_URL")
  fi
  if [ "$DRY_RUN" = 1 ]; then
    plan
    return 0
  fi
  if [ "$MODE" = remote ]; then
    # the probe comes before anything is written; a server the app already
    # opens is trusted as chosen (it also lets `diazo update` run while it
    # is down). An update replaying the record has nothing new to check or
    # write against a server picked in the app.
    current=$(current_choice)
    if [ "$current" != "$REMOTE_ORIGIN" ] && { [ "$REMOTE_EXPLICIT" = 1 ] || [ -z "$current" ]; }; then
      probe_remote "$REMOTE_ORIGIN"
    fi
  fi
  find_libs fresh
  mkdir -p "$DOOP_HOME"
  install_command
  if [ "$MODE" = remote ]; then
    install_app
    choose_remote_server
  else
    if [ "$WANT_SERVER" = 1 ]; then
      install_server
      register_autostart
    fi
    if [ "$WANT_APP" = 1 ]; then
      # before the app installs, so an app it relaunches opens the right server
      if [ "$WANT_SERVER" = 1 ]; then
        choose_local_server
      fi
      install_app
    fi
  fi
  record_parts "$WANT_SERVER" "$WANT_APP"
  finish
}

finish() {
  printf '\n%s\n' "Diazo is installed."
  if [ "$MODE" = remote ]; then
    printf '  %s\n' "server:  $REMOTE_ORIGIN (remote; nothing runs on this computer)"
  elif [ "$WANT_SERVER" = 1 ]; then
    printf '  %s\n' "server:  http://localhost:$DOOP_PORT (starts at login)"
  fi
  printf '  %s\n' "manage:  diazo start|stop|restart|status|logs|update|open|uninstall"
  if [ "$WANT_APP" = 1 ] && [ "$OPEN_APP" = 1 ]; then
    if [ "$WANT_SERVER" = 1 ] && [ "$MODE" = local ]; then
      printf '%s\n' "Opening Diazo: create your account (the first one on this server is its admin)."
    fi
    open_app
  fi
}

open_app() {
  case $OS in
    macos) open -b "$BUNDLE_ID" 2>/dev/null || say "open Diazo from your Applications folder" ;;
    linux)
      if command -v gtk-launch >/dev/null 2>&1; then
        gtk-launch doop-desktop >/dev/null 2>&1 || gtk-launch doop-desktop-appimage >/dev/null 2>&1 ||
          say "open Diazo from your applications menu"
      else
        say "open Diazo from your applications menu"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------- commands
# The server commands, for a computer whose install has a local server (an
# install made by install-local.sh alone, with no record, counts).
need_server() {
  case $OS in
    macos | linux) ;;
    *) die "Diazo's local server runs on macOS and Linux" ;;
  esac
  mode=$(conf_mode)
  if [ "$mode" = remote ]; then
    die "this computer has no Diazo server (a remote install: the app uses $(conf_value remote))"
  fi
  if [ "$(conf_value server)" = 0 ]; then
    die "this computer has no Diazo server (installed with --app-only). Run the installer without --app-only to add it"
  fi
  find_libs
}

local_cmd() { DIAZO_COMMAND=$COMMAND DIAZO_AUTOSTART="$AUTOSTART_DESC" sh "$LIB/install-local.sh" "$@"; }

agent_loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

unit_enabled() { command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled diazo.service >/dev/null 2>&1; }

autostart_status() {
  case $OS in
    macos)
      if agent_loaded; then
        say "starts at login (LaunchAgent $LABEL, logs in $LOG_DIR)"
      elif [ -f "$PLIST" ]; then
        say "the LaunchAgent is not loaded: diazo update registers it again"
      else
        say "does not start at login (no LaunchAgent)"
      fi
      ;;
    linux)
      if unit_enabled; then
        say "starts at login (systemd user unit diazo.service)"
      elif [ -f "$UNIT" ]; then
        say "the user unit is not enabled: diazo update registers it again"
      else
        say "does not start at login (no systemd user unit)"
      fi
      ;;
  esac
}

do_status() {
  mode=$(conf_mode)
  if [ "$mode" = remote ]; then
    say "no server on this computer (remote install: the app uses $(conf_value remote))"
  elif [ "$(conf_value server)" != 0 ]; then
    need_server
    local_cmd status || true
    autostart_status
  else
    say "no server on this computer (app only)"
  fi
  if app_installed; then
    current=$(current_choice)
    say "the Diazo app is installed, set to ${current:-its default server}"
  else
    say "the Diazo app is not installed"
  fi
}

do_open() {
  if app_installed; then
    open_app
  else
    case $OS in
      macos) open "http://localhost:$DOOP_PORT" ;;
      linux) xdg-open "http://localhost:$DOOP_PORT" >/dev/null 2>&1 || say "open http://localhost:$DOOP_PORT in a browser" ;;
      *) die "Diazo's local server runs on macOS and Linux" ;;
    esac
  fi
}

# What is installed, as install flags, from the record.
part_flags() {
  mode=$(conf_mode)
  if [ "$mode" = remote ]; then
    printf '%s' "--remote $(conf_value remote)"
  elif [ "$(conf_value server)" = 0 ]; then
    printf '%s' --app-only
  elif [ "$(conf_value app)" = 0 ]; then
    printf '%s' --server-only
  fi
}

# Updates what this computer has with the latest scripts: downloaded fresh,
# then run (this file is the previous version). With DIAZO_LIB or from a
# checkout, the scripts at hand are used.
do_update() {
  flags=$(part_flags)
  self=$(self_file)
  if [ -n "${DIAZO_LIB:-}" ] || { [ -n "$self" ] && has_libs "$(dirname "$self")"; }; then
    OPEN_APP=0
    case $flags in
      --app-only) WANT_SERVER=0 ;;
      --server-only) WANT_APP=0 ;;
      --remote*)
        MODE=remote
        MODE_GIVEN=1
        REMOTE_URL=$(conf_value remote)
        WANT_SERVER=0
        ;;
    esac
    do_install
    return 0
  fi
  # the re-run must never prompt for a mode: the record carries it
  [ -n "$flags" ] || flags=--local
  work_dir
  for script in install.sh install-local.sh install-desktop.sh; do
    fetch "$DIAZO_RAW/$script" "$WORK/$script" || die "could not download $DIAZO_RAW/$script (offline?)"
  done
  # DIAZO_UPDATE tells the re-run its --remote flag is the record, not a
  # newly typed choice: a server picked in the app must survive the update
  # shellcheck disable=SC2086 # one flag or none
  DIAZO_UPDATE=1 sh "$WORK/install.sh" install --no-open $flags ${VERSION:+--version "$VERSION"}
}

# The login start: nothing when the server already answers.
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
  case $OS in
    macos | linux) ;;
    *) die "this installer runs on macOS and Linux" ;;
  esac
  # an unknown recorded mode is an error before anything is touched
  mode=$(conf_mode)
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry run] would remove the autostart, the '$DOOP_NAME' container, the app and the diazo command"
    if [ "$PURGE" = 1 ]; then
      say "[dry run] and delete $DOOP_HOME and $APP_DATA"
    fi
    return 0
  fi
  find_libs
  unregister_autostart
  # the app first: purging the server deletes the data folder, lib/ included
  sh "$LIB/install-desktop.sh" --uninstall
  # the server part only when this install has one: a remote or app-only
  # install never made a container, and must not remove somebody else's
  runtime_present=0
  if [ "$mode" != remote ] && [ "$(conf_value server)" != 0 ]; then
    case $OS in
      macos) command -v container >/dev/null 2>&1 && runtime_present=1 ;;
      linux) { command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; } && runtime_present=1 ;;
    esac
  fi
  if [ "$runtime_present" = 1 ]; then
    if [ "$PURGE" = 1 ]; then
      sh "$LIB/install-local.sh" uninstall --yes
    else
      sh "$LIB/install-local.sh" uninstall --keep-data
    fi
  fi
  remove_command
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DOOP_HOME" "$APP_DATA" "$LOG_DIR"
    say "deleted $DOOP_HOME and $APP_DATA"
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
      *)
        case $OS in
          macos) say "add $dir to your PATH to type diazo: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zprofile" ;;
          *) say "add $dir to your PATH to type diazo: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
        esac
        ;;
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
      case $OS in
        macos) say "login starts log to $LOG_DIR/server.log; the container's own logs follow" ;;
        linux) say "login starts log to the journal (journalctl --user -u diazo.service); the container's own logs follow" ;;
      esac
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
