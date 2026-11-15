#!/bin/sh
# install-desktop: install or update the Diazo desktop app (Diazo.app) on this Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.sh | sh
#   ... | sh -s -- --version 0.15.0     a given release
#   ... | sh -s -- --uninstall          remove the app (your data stays)
#
# Downloads the universal app package (Diazo_<version>_universal.app.tar.gz,
# Diazo.app at its root) of a desktop-v<version> release of BRYANN2K/diazo,
# checks it against the release's SHA256SUMS (and its updater signature when
# `minisign` is installed), quits a running Diazo, and replaces Diazo.app in
# /Applications (~/Applications when /Applications is not writable). The app is
# not signed by Apple: a file curl downloads carries no quarantine flag, so
# Gatekeeper does not stop it, and the quarantine flag is cleared anyway. The
# app then updates itself from the same releases. ~/Library/Application
# Support/dev.diazo.desktop (sign-in, chosen server, Chromium profile) is never
# touched.
#
# Before the rename the app was doop.app (bundle design.doop.desktop), the name
# and identifier of the official doop app too. A doop.app is removed once
# Diazo.app is in place only when its binary carries this fork's updater key,
# i.e. it is the redoop build; the official doop app is never touched. Its
# data folder stays: Diazo copies what it needs from it on its first launch.
#
# Settings (environment): DOOP_DESKTOP_REPO (BRYANN2K/diazo), DOOP_DESKTOP_DIR
# (install folder, overrides the choice above), DOOP_DESKTOP_RELEASES (base URL
# of the release downloads), DOOP_DESKTOP_QUIT_TIMEOUT (seconds, 20).

set -eu

DOOP_DESKTOP_REPO=${DOOP_DESKTOP_REPO:-BRYANN2K/diazo}
DOOP_DESKTOP_RELEASES=${DOOP_DESKTOP_RELEASES:-"https://github.com/$DOOP_DESKTOP_REPO/releases/download"}
DOOP_DESKTOP_QUIT_TIMEOUT=${DOOP_DESKTOP_QUIT_TIMEOUT:-20}
SYSTEM_APPS=${DOOP_DESKTOP_SYSTEM_APPS:-/Applications}
USER_APPS="$HOME/Applications"
APP_NAME=Diazo.app
BUNDLE_ID=dev.diazo.desktop
DATA_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
# the pre-rename redoop shell, replaced only when it trusts our key
LEGACY_APP=doop.app
# plugins.updater.pubkey in desktop/src-tauri*/tauri.conf.json: the minisign
# key every release package is signed with (base64 of the .pub file)
PUBKEY=dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxMzc1RjdFODhCOEZDNzIKUldSeS9MaUlmbDgzc2ZjNVZYMkxjYmMvaDB5SlNTTXhZMXQrSjJ0YVB3emRRQjBrY3ZYZ1BhNEwK

ACTION=install
VERSION=
FORCE=0
WORK=
WAS_RUNNING=0

say() { printf '%s\n' "diazo: $*"; }
die() {
  printf '%s\n' "diazo: error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-desktop.sh [options]

Installs or updates Diazo.app (the Diazo desktop app) on this Mac. A doop.app
left by the redoop build is removed; the official doop app is never touched.

Options:
  --version X.Y.Z   install that release instead of the latest one
  --force           reinstall even when this version is already installed
  --uninstall       remove Diazo.app (sign-in, server choice and data are kept)
  -h, --help        this help
EOF
}

# ---------------------------------------------------------------- arguments
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a version, e.g. --version 0.15.0"
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
  asset="Diazo_${VERSION}_universal.app.tar.gz"
  base="$DOOP_DESKTOP_RELEASES/desktop-v$VERSION"
  say "downloading Diazo $VERSION"
  fetch "$base/$asset" "$WORK/$asset" || die "could not download $base/$asset (is desktop-v$VERSION released? Releases before 0.15.0 are the doop.app of redoop)"
  fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS" || die "could not download $base/SHA256SUMS"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$WORK/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS does not list $asset"
  actual=$(sha256 "$WORK/$asset")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
  say "checksum verified"

  if command -v minisign >/dev/null 2>&1; then
    fetch "$base/$asset.sig" "$WORK/$asset.sig.b64" || die "could not download $base/$asset.sig"
    printf '%s' "$PUBKEY" | openssl base64 -d -A >"$WORK/diazo.pub"
    openssl base64 -d -A <"$WORK/$asset.sig.b64" >"$WORK/$asset.minisig"
    minisign -V -q -p "$WORK/diazo.pub" -x "$WORK/$asset.minisig" -m "$WORK/$asset" >/dev/null 2>&1 ||
      die "the signature of $asset does not verify against Diazo's key; nothing was installed"
    say "signature verified"
  else
    say "(install minisign, e.g. brew install minisign, to also check the release signature)"
  fi
  PACKAGE="$WORK/$asset"
}

# ---------------------------------------------------------------- the app
# Where Diazo.app lives (or will): where it already is, else /Applications if
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

# An installed shell trusts this fork's key when the key is in its binary (any
# executable in Contents/MacOS, whatever it is named). A Diazo.app without it
# is reinstalled even at the same version number; a doop.app without it is the
# official doop app and is left alone.
trusts_our_key() {
  [ -d "$1/Contents/MacOS" ] || return 1
  for bin in "$1"/Contents/MacOS/*; do
    if [ -f "$bin" ] && grep -qF "$PUBKEY" "$bin" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# A process running from that bundle (by path, so a doop.app elsewhere, such as
# the official one, never counts).
running() { pgrep -f "$1/Contents/MacOS/" >/dev/null 2>&1; }

quit_app() {
  app=$1
  running "$app" || return 0
  WAS_RUNNING=1
  say "quitting Diazo"
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  waited=0
  while running "$app"; do
    if [ "$waited" -ge "$DOOP_DESKTOP_QUIT_TIMEOUT" ]; then
      die "Diazo is still running: quit it (Diazo → Quit) and run this again"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# The redoop doop.app of this Mac's two Applications folders: removed when it
# carries our key and is not running. Its bundle id is the official app's too,
# so it is never asked to quit (that would quit the official app as well).
remove_legacy() {
  for ldir in ${DOOP_DESKTOP_DIR:+"$DOOP_DESKTOP_DIR"} "$SYSTEM_APPS" "$USER_APPS"; do
    legacy="$ldir/$LEGACY_APP"
    [ -d "$legacy" ] || continue
    trusts_our_key "$legacy" || continue
    if running "$legacy"; then
      say "the old redoop doop.app in $ldir is running: quit it and run this again to remove it"
      continue
    fi
    if rm -rf "${legacy:?}"; then
      say "removed the old redoop doop.app from $ldir (Diazo.app replaces it; its data is kept)"
    else
      say "could not remove $legacy"
    fi
  done
}

replace_app() {
  dir=$1
  mkdir -p "$dir" || die "cannot create $dir"
  [ -w "$dir" ] || die "$dir is not writable"
  # unpacked next to its destination, so the swap is two renames on one volume
  stage=$(mktemp -d "$dir/.diazo-install.XXXXXX")
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

Diazo $VERSION is installed: $1/$APP_NAME
  updates:  automatic, from https://github.com/$DOOP_DESKTOP_REPO/releases (Diazo → Check for Updates…)
  data:     $DATA_DIR (kept across updates and reinstalls)

Use your own server (self-hosted or your Diazo instance): on the sign-in
screen, click the cog, enter its address (https://…, or http://localhost:4400
for a local install) and confirm. The app saves it as server.json in the data
folder above and restarts onto it.
EOF
}

do_install() {
  check_platform
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/diazo-desktop.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [ -z "$VERSION" ]; then
    VERSION=$(latest_version)
  fi
  dir=$(pick_dir)
  current=$(installed_version "$dir/$APP_NAME")
  if [ "$FORCE" = 0 ] && [ "$current" = "$VERSION" ] && trusts_our_key "$dir/$APP_NAME"; then
    say "Diazo $VERSION is already installed in $dir (--force reinstalls it)"
    remove_legacy
    return 0
  fi
  download
  quit_app "$dir/$APP_NAME"
  if [ -n "$current" ]; then
    say "replacing Diazo $current in $dir"
  else
    say "installing into $dir"
  fi
  replace_app "$dir"
  remove_legacy
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
      quit_app "$dir/$APP_NAME"
      rm -rf "${dir:?}/$APP_NAME" || die "could not remove $dir/$APP_NAME"
      say "removed $dir/$APP_NAME"
      removed=1
    fi
  done
  [ "$removed" = 1 ] || say "Diazo.app is not installed"
  remove_legacy
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
