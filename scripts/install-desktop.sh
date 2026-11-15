#!/bin/sh
# install-desktop: install or update the redoop desktop app (doop.app) on this Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/redoop/main/scripts/install-desktop.sh | sh
#   ... | sh -s -- --version 0.14.0     a given release
#   ... | sh -s -- --uninstall          remove the app (your data stays)
#
# Downloads the universal app package (doop_<version>_universal.app.tar.gz) of
# a desktop-v<version> release of BRYANN2K/redoop, checks it against the
# release's SHA256SUMS (and its updater signature when `minisign` is
# installed), quits a running doop, and replaces doop.app in /Applications
# (~/Applications when /Applications is not writable). The app is not signed
# by Apple: a file curl downloads carries no quarantine flag, so Gatekeeper
# does not stop it, and the quarantine flag is cleared anyway. The app then
# updates itself from the same releases. ~/Library/Application Support/
# design.doop.desktop (sign-in, chosen server, Chromium profile) is never touched.
#
# Settings (environment): DOOP_DESKTOP_REPO (BRYANN2K/redoop), DOOP_DESKTOP_DIR
# (install folder, overrides the choice above), DOOP_DESKTOP_RELEASES (base URL
# of the release downloads), DOOP_DESKTOP_QUIT_TIMEOUT (seconds, 20).

set -eu

DOOP_DESKTOP_REPO=${DOOP_DESKTOP_REPO:-BRYANN2K/redoop}
DOOP_DESKTOP_RELEASES=${DOOP_DESKTOP_RELEASES:-"https://github.com/$DOOP_DESKTOP_REPO/releases/download"}
DOOP_DESKTOP_QUIT_TIMEOUT=${DOOP_DESKTOP_QUIT_TIMEOUT:-20}
SYSTEM_APPS=${DOOP_DESKTOP_SYSTEM_APPS:-/Applications}
USER_APPS="$HOME/Applications"
APP_NAME=doop.app
BUNDLE_ID=design.doop.desktop
EXECUTABLE=doop-desktop
DATA_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
# plugins.updater.pubkey in desktop/src-tauri*/tauri.conf.json: the minisign
# key every release package is signed with (base64 of the .pub file)
PUBKEY=dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxMzc1RjdFODhCOEZDNzIKUldSeS9MaUlmbDgzc2ZjNVZYMkxjYmMvaDB5SlNTTXhZMXQrSjJ0YVB3emRRQjBrY3ZYZ1BhNEwK

ACTION=install
VERSION=
FORCE=0
WORK=
WAS_RUNNING=0

say() { printf '%s\n' "doop: $*"; }
die() {
  printf '%s\n' "doop: error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-desktop.sh [options]

Installs or updates doop.app (the redoop desktop app) on this Mac.

Options:
  --version X.Y.Z   install that release instead of the latest one
  --force           reinstall even when this version is already installed
  --uninstall       remove doop.app (sign-in, server choice and data are kept)
  -h, --help        this help
EOF
}

# ---------------------------------------------------------------- arguments
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a version, e.g. --version 0.14.0"
        VERSION=${2#desktop-v}
        VERSION=${VERSION#v}
        shift
        ;;
      --version=*)
        VERSION=${1#--version=}
        VERSION=${VERSION#desktop-v}
        VERSION=${VERSION#v}
        ;;
      --force) FORCE=1 ;;
      --uninstall | uninstall) ACTION=uninstall ;;
      install | update | --install | --update) ACTION=install ;;
      -h | --help | help) ACTION=help ;;
      *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done
  if [ -n "$VERSION" ]; then
    check_version "$VERSION" || die "not a release version: '$VERSION' (expected X.Y.Z)"
  fi
}

# X.Y.Z with an optional -suffix; nothing that could reach a URL or a path
check_version() {
  case $1 in
    *[!0-9A-Za-z.-]* | '' | .* | -*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

# ---------------------------------------------------------------- checks
check_platform() {
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS (this is $(uname -s)). Windows and Linux installers are on https://github.com/$DOOP_DESKTOP_REPO/releases"
  case $(uname -m) in
    arm64 | x86_64) ;;
    *) die "unsupported Mac architecture: $(uname -m)" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v tar >/dev/null 2>&1 || die "tar is required"
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

fetch() { curl -fsSL --retry 3 --proto '=https' -o "$2" "$1"; }

# ---------------------------------------------------------------- release
latest_version() {
  feed="$DOOP_DESKTOP_RELEASES/desktop-updates/latest.json"
  fetch "$feed" "$WORK/latest.json" || die "could not read $feed (offline, or no desktop release yet)"
  v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/latest.json" | head -n 1)
  check_version "$v" || die "the update feed names no usable version ($feed)"
  printf '%s' "$v"
}

download() {
  asset="doop_${VERSION}_universal.app.tar.gz"
  base="$DOOP_DESKTOP_RELEASES/desktop-v$VERSION"
  say "downloading doop $VERSION"
  fetch "$base/$asset" "$WORK/$asset" || die "could not download $base/$asset (is desktop-v$VERSION released?)"
  fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS" || die "could not download $base/SHA256SUMS"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$WORK/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS does not list $asset"
  actual=$(sha256 "$WORK/$asset")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
  say "checksum verified"

  if command -v minisign >/dev/null 2>&1; then
    fetch "$base/$asset.sig" "$WORK/$asset.sig.b64" || die "could not download $base/$asset.sig"
    printf '%s' "$PUBKEY" | openssl base64 -d -A >"$WORK/doop.pub"
    openssl base64 -d -A <"$WORK/$asset.sig.b64" >"$WORK/$asset.minisig"
    minisign -V -q -p "$WORK/doop.pub" -x "$WORK/$asset.minisig" -m "$WORK/$asset" >/dev/null 2>&1 ||
      die "the signature of $asset does not verify against redoop's key; nothing was installed"
    say "signature verified"
  else
    say "(install minisign, e.g. brew install minisign, to also check the release signature)"
  fi
  PACKAGE="$WORK/$asset"
}

# ---------------------------------------------------------------- the app
# Where doop.app lives (or will): where it already is, else /Applications if
# writable, else ~/Applications.
pick_dir() {
  if [ -n "${DOOP_DESKTOP_DIR:-}" ]; then
    printf '%s' "$DOOP_DESKTOP_DIR"
  elif [ -d "$SYSTEM_APPS/$APP_NAME" ] && [ -w "$SYSTEM_APPS" ]; then
    printf '%s' "$SYSTEM_APPS"
  elif [ -d "$USER_APPS/$APP_NAME" ]; then
    printf '%s' "$USER_APPS"
  elif [ -d "$SYSTEM_APPS" ] && [ -w "$SYSTEM_APPS" ]; then
    printf '%s' "$SYSTEM_APPS"
  else
    printf '%s' "$USER_APPS"
  fi
}

# CFBundleShortVersionString of an installed bundle, empty when unreadable
installed_version() {
  plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 0
  sed -n '/<key>CFBundleShortVersionString<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist" | head -n 1
}

# An installed shell trusts redoop's key when the key is in its binary; one
# installed from doop.design carries upstream's key and must be replaced even
# at the same version number.
trusts_our_key() {
  bin="$1/Contents/MacOS/$EXECUTABLE"
  [ -f "$bin" ] && grep -qF "$PUBKEY" "$bin" 2>/dev/null
}

running() { pgrep -x "$EXECUTABLE" >/dev/null 2>&1; }

quit_app() {
  running || return 0
  WAS_RUNNING=1
  say "quitting doop"
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  waited=0
  while running; do
    if [ "$waited" -ge "$DOOP_DESKTOP_QUIT_TIMEOUT" ]; then
      die "doop is still running: quit it (doop → Quit) and run this again"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

replace_app() {
  dir=$1
  mkdir -p "$dir" || die "cannot create $dir"
  [ -w "$dir" ] || die "$dir is not writable"
  # unpacked next to its destination, so the swap is two renames on one volume
  stage=$(mktemp -d "$dir/.doop-install.XXXXXX")
  if ! tar -xzf "$PACKAGE" -C "$stage" || [ ! -f "$stage/$APP_NAME/Contents/Info.plist" ]; then
    rm -rf "$stage"
    die "the package holds no $APP_NAME; nothing was installed"
  fi
  if [ -e "$dir/$APP_NAME" ]; then
    mv "$dir/$APP_NAME" "$stage/$APP_NAME.old"
  fi
  mv "$stage/$APP_NAME" "$dir/$APP_NAME"
  rm -rf "$stage"
  # curl sets no quarantine flag; clear one a browser download may have left
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$dir/$APP_NAME" 2>/dev/null || true
  fi
}

done_message() {
  cat <<EOF

doop $VERSION is installed: $1/$APP_NAME
  updates:  automatic, from https://github.com/$DOOP_DESKTOP_REPO/releases (doop → Check for Updates…)
  data:     $DATA_DIR (kept across updates and reinstalls)

Use your own server (self-hosted or the redoop instance): on the sign-in
screen, click the cog, enter its address (https://…, or http://localhost:4400
for a local install) and confirm. The app saves it as server.json in the data
folder above and restarts onto it.
EOF
}

do_install() {
  check_platform
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/doop-desktop.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [ -z "$VERSION" ]; then
    VERSION=$(latest_version)
  fi
  dir=$(pick_dir)
  current=$(installed_version "$dir/$APP_NAME")
  if [ "$FORCE" = 0 ] && [ "$current" = "$VERSION" ] && trusts_our_key "$dir/$APP_NAME"; then
    say "doop $VERSION is already installed in $dir (--force reinstalls it)"
    return 0
  fi
  download
  quit_app
  if [ -n "$current" ]; then
    say "replacing doop $current in $dir"
  else
    say "installing into $dir"
  fi
  replace_app "$dir"
  done_message "$dir"
  if [ "$WAS_RUNNING" = 1 ]; then
    open "$dir/$APP_NAME" 2>/dev/null || true
  fi
}

do_uninstall() {
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
  removed=0
  for dir in ${DOOP_DESKTOP_DIR:+"$DOOP_DESKTOP_DIR"} "$SYSTEM_APPS" "$USER_APPS"; do
    if [ -d "$dir/$APP_NAME" ]; then
      quit_app
      rm -rf "${dir:?}/$APP_NAME" || die "could not remove $dir/$APP_NAME"
      say "removed $dir/$APP_NAME"
      removed=1
    fi
  done
  [ "$removed" = 1 ] || say "doop.app is not installed"
  say "kept $DATA_DIR (delete it to forget the sign-in and the chosen server)"
}

main() {
  parse_args "$@"
  case $ACTION in
    help) usage ;;
    install) do_install ;;
    uninstall) do_uninstall ;;
  esac
}

# DOOP_INSTALL_LIB=1 defines the functions without running anything (tests).
if [ "${DOOP_INSTALL_LIB:-0}" != 1 ]; then
  main "$@"
fi
