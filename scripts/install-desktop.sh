#!/bin/sh
# install-desktop: install or update the Diazo desktop app on this computer.
#
#   curl -fsSL https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts/install-desktop.sh | sh
#   ... | sh -s -- --version 0.15.0     a given release
#   ... | sh -s -- --uninstall          remove the app (your data stays)
#
# It detects the system and picks the right package of a desktop-v<version>
# release of BRYANN2K/diazo:
#   - macOS (Apple silicon or Intel): Diazo_<v>_universal.app.tar.gz, Diazo.app
#     at its root, swapped into /Applications (~/Applications when /Applications
#     is not writable), a running app quit first. The app is not signed by
#     Apple: a file curl downloads carries no quarantine flag, so Gatekeeper
#     does not stop it, and the flag is cleared anyway.
#   - Linux x86_64: Diazo_<v>_amd64.deb through the package manager on Debian/
#     Ubuntu-family systems, Diazo-<v>-1.x86_64.rpm on Fedora/RHEL/openSUSE-
#     family ones (the family comes from /etc/os-release), else
#     Diazo_<v>_amd64.AppImage into ~/.local/bin with a .desktop entry;
#     --appimage forces the last. Linux arm64 has no package yet.
#   - Windows: no shell installer; the script prints the PowerShell one-liner.
# Every download is checked against the release's SHA256SUMS, and its minisign
# signature when `minisign` is installed. ~/Library/Application Support/
# dev.bryann2k.diazo (or the Linux and Windows data folders: sign-in, chosen
# server, profile) is never touched.
#
# Before the rename the app was doop.app (bundle design.doop.desktop), the name
# and identifier of the official doop app too. A doop.app is removed once
# Diazo.app is in place only when its binary carries this fork's updater key,
# i.e. it is the redoop build; the official doop app is never touched. Its
# data folder stays: Diazo copies what it needs from it on its first launch.
#
# Settings (environment): DOOP_DESKTOP_REPO (BRYANN2K/diazo), DOOP_DESKTOP_DIR
# (install folder, overrides the choice above), DOOP_DESKTOP_RELEASES (base URL
# of the release downloads), DOOP_DESKTOP_QUIT_TIMEOUT (seconds, 20),
# DOOP_DESKTOP_APPIMAGE_DIR (where the AppImage lands, ~/.local/bin or
# ~/Applications), DOOP_OS_RELEASE (the os-release file, /etc/os-release).

set -eu

DOOP_DESKTOP_REPO=${DOOP_DESKTOP_REPO:-BRYANN2K/diazo}
DOOP_DESKTOP_RELEASES=${DOOP_DESKTOP_RELEASES:-"https://github.com/$DOOP_DESKTOP_REPO/releases/download"}
DOOP_DESKTOP_QUIT_TIMEOUT=${DOOP_DESKTOP_QUIT_TIMEOUT:-20}
DOOP_OS_RELEASE=${DOOP_OS_RELEASE:-/etc/os-release}
SYSTEM_APPS=${DOOP_DESKTOP_SYSTEM_APPS:-/Applications}
USER_APPS="$HOME/Applications"
APP_NAME=Diazo.app
BUNDLE_ID=dev.bryann2k.diazo
DATA_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
XDG_DATA=${XDG_DATA_HOME:-$HOME/.local/share}
XDG_DATA_DIR="$XDG_DATA/$BUNDLE_ID"
DESKTOP_DIR="$XDG_DATA/applications"
# the name the AppImage gives its own entry on first launch (appimage.rs):
# writing the same one means no duplicate menu item
DESKTOP_FILE="$DESKTOP_DIR/doop-desktop-appimage.desktop"
# the pre-rename redoop shell, replaced only when it trusts our key
LEGACY_APP=doop.app
# plugins.updater.pubkey in desktop/src-tauri*/tauri.conf.json: the minisign
# key every release package is signed with (base64 of the .pub file)
PUBKEY=dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxMzc1RjdFODhCOEZDNzIKUldSeS9MaUlmbDgzc2ZjNVZYMkxjYmMvaDB5SlNTTXhZMXQrSjJ0YVB3emRRQjBrY3ZYZ1BhNEwK
POWERSHELL_LINE="irm https://raw.githubusercontent.com/$DOOP_DESKTOP_REPO/main/scripts/install-desktop.ps1 | iex"
RELEASES_PAGE="https://github.com/$DOOP_DESKTOP_REPO/releases"

ACTION=install
OS=
VERSION=
FORCE=0
APPIMAGE=0
DRY_RUN=0
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

Installs or updates the Diazo desktop app on this computer: Diazo.app on
macOS, the .deb or .rpm package of this Linux distribution (the AppImage
elsewhere or under --appimage) on Linux x86_64. A doop.app left by the redoop
build is removed; the official doop app is never touched. On Windows the
script prints the PowerShell one-liner that does the install.

Options:
  --version X.Y.Z   install that release instead of the latest one
  --appimage        on Linux: the AppImage, whatever the distribution
  --force           reinstall even when this version is already installed
  --dry-run         print what would be done, change nothing
  --uninstall       remove the app (sign-in, server choice and data are kept)
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
      --appimage) APPIMAGE=1 ;;
      --force) FORCE=1 ;;
      --dry-run | --dry) DRY_RUN=1 ;;
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
detect_os() {
  case $(uname -s) in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    MINGW* | MSYS* | CYGWIN*) OS=windows ;;
    *) OS=other ;;
  esac
}

check_platform() {
  case $OS in
    macos)
      case $(uname -m) in
        arm64 | x86_64) ;;
        *) die "unsupported Mac architecture: $(uname -m)" ;;
      esac
      command -v tar >/dev/null 2>&1 || die "tar is required"
      ;;
    linux)
      case $(uname -m) in
        x86_64 | amd64) ;;
        aarch64 | arm64)
          cat >&2 <<EOF
diazo: error: no Linux arm64 package is published yet.
  The $RELEASES_PAGE page lists what each desktop-v* release carries
  (x86_64 only so far); the AppImage there is x86_64 too.
EOF
          exit 1
          ;;
        *) die "no Diazo package for this Linux architecture ($(uname -m))" ;;
      esac
      ;;
    windows)
      cat >&2 <<EOF
diazo: this shell installer does not run on Windows. In PowerShell:

  $POWERSHELL_LINE

EOF
      exit 1
      ;;
    *) die "unsupported system: $(uname -s)" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required"
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

# The release asset for this install, and the dry-run line for it.
pick_asset() {
  case $OS in
    macos) printf 'Diazo_%s_universal.app.tar.gz' "$VERSION" ;;
    linux)
      case $(pick_kind) in
        deb) printf 'Diazo_%s_amd64.deb' "$VERSION" ;;
        rpm) printf 'Diazo-%s-1.x86_64.rpm' "$VERSION" ;;
        *) printf 'Diazo_%s_amd64.AppImage' "$VERSION" ;;
      esac
      ;;
  esac
}

# Downloads the asset and its SHA256SUMS, verifies the checksum, and the
# minisign signature when minisign is installed (every release asset has one;
# a missing one is a broken release, so that fails too).
download() {
  asset=$1
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

# ---------------------------------------------------------------- the app (macOS)
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

# ---------------------------------------------------------------- the app (Linux)
# deb, rpm or appimage: --appimage forces the last, else the /etc/os-release
# family decides (a distribution that knows neither family gets the AppImage).
pick_kind() {
  if [ "$APPIMAGE" = 1 ]; then
    printf 'appimage'
    return 0
  fi
  ids=$(
    (
      set +u
      # shellcheck disable=SC1090 # the distribution's own file
      . "$DOOP_OS_RELEASE" 2>/dev/null
      printf '%s %s' "${ID:-}" "${ID_LIKE:-}"
    ) 2>/dev/null || true
  )
  case $ids in
    *debian* | *ubuntu*) printf 'deb' ;;
    *fedora* | *rhel* | *centos* | *suse*) printf 'rpm' ;;
    *) printf 'appimage' ;;
  esac
}

# The root the package commands need, empty when already root.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "installing the package needs root and sudo is not installed; run this as root or use --appimage"
  fi
}

# Version of the installed diazo package (deb or rpm database), empty when
# none; the AppImage answer is its filename's version.
linux_version() {
  case $1 in
    deb)
      if command -v dpkg-query >/dev/null 2>&1; then
        dpkg-query -W -f '${Version}' diazo 2>/dev/null | sed -e 's/^[0-9]*://' -e 's/[+-].*//' || true
      elif command -v dpkg >/dev/null 2>&1; then
        dpkg -s diazo 2>/dev/null | sed -n 's/^Version: //p' | sed -e 's/^[0-9]*://' -e 's/[+-].*//' || true
      fi
      ;;
    rpm)
      if command -v rpm >/dev/null 2>&1; then
        rpm -q --qf '%{VERSION}' diazo 2>/dev/null | grep -v 'not installed' || true
      fi
      ;;
    appimage)
      for file in "$(appimage_dir)"/Diazo_*_amd64.AppImage; do
        [ -f "$file" ] || continue
        printf '%s' "${file##*/}" | sed -n 's/Diazo_\([0-9][0-9.]*\)_amd64\.AppImage/\1/p'
        return 0
      done
      ;;
  esac
}

# Where the AppImage goes: DOOP_DESKTOP_APPIMAGE_DIR (or DOOP_DESKTOP_DIR),
# else ~/.local/bin, else ~/Applications when only that one exists.
appimage_dir() {
  if [ -n "${DOOP_DESKTOP_APPIMAGE_DIR:-${DOOP_DESKTOP_DIR:-}}" ]; then
    printf '%s' "${DOOP_DESKTOP_APPIMAGE_DIR:-$DOOP_DESKTOP_DIR}"
  elif [ -d "$HOME/.local/bin" ] || [ ! -d "$USER_APPS" ]; then
    printf '%s' "$HOME/.local/bin"
  else
    printf '%s' "$USER_APPS"
  fi
}

# The packaged binary is doop-desktop (mainBinaryName); an AppImage's own
# launcher carries its path in the command line.
linux_app_running() {
  pgrep -x doop-desktop >/dev/null 2>&1 || pgrep -f "Diazo.*AppImage" >/dev/null 2>&1
}

quit_linux_app() {
  linux_app_running || return 0
  WAS_RUNNING=1
  say "quitting Diazo"
  pkill -x doop-desktop >/dev/null 2>&1 || true
  pkill -f "Diazo.*AppImage" >/dev/null 2>&1 || true
  sleep 2
}

install_deb() {
  say "installing the .deb package"
  if command -v apt >/dev/null 2>&1; then
    as_root apt install -y "$PACKAGE" || die "apt could not install $PACKAGE"
  elif command -v dpkg >/dev/null 2>&1; then
    as_root dpkg -i "$PACKAGE" || die "dpkg could not install $PACKAGE (a missing dependency? try: sudo apt install -f)"
  else
    die "neither apt nor dpkg is installed; use --appimage instead"
  fi
}

install_rpm() {
  say "installing the .rpm package"
  if command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y "$PACKAGE" || die "dnf could not install $PACKAGE"
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive install "$PACKAGE" || die "zypper could not install $PACKAGE"
  elif command -v rpm >/dev/null 2>&1; then
    as_root rpm -i "$PACKAGE" || die "rpm could not install $PACKAGE"
  else
    die "neither dnf, zypper nor rpm is installed; use --appimage instead"
  fi
}

# Exec quoting as the app itself writes it (appimage.rs): the path in one
# quoted argument (\ " ` $ backslashed, % doubled), then the whole value's
# backslashes doubled for the Desktop Entry format.
# shellcheck disable=SC2016 # a literal $ is the point here
desktop_exec() {
  printf '%s' "$1" |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/`/\\`/g' -e 's/\$/\\$/g' -e 's/%/%%/g' |
    sed 's/\\/\\\\/g'
}

install_appimage() {
  dir=$(appimage_dir)
  mkdir -p "$dir" "$DESKTOP_DIR" || die "cannot create $dir"
  target="$dir/Diazo_${VERSION}_amd64.AppImage"
  for old in "$dir"/Diazo_*_amd64.AppImage; do
    [ -f "$old" ] && [ "$old" != "$target" ] && rm -f "$old"
  done
  cp "$PACKAGE" "$target.tmp.$$"
  chmod 755 "$target.tmp.$$"
  mv "$target.tmp.$$" "$target"
  # the same entry the app writes on its first launch (same name, same Exec):
  # the menu works at once and the icon lands when the app drops it there
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Diazo
Exec="$(desktop_exec "$target")"
Icon=$XDG_DATA_DIR/icon.png
StartupWMClass=doop-desktop
Terminal=false
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
  say "installed $target (menu entry: $DESKTOP_FILE)"
}

# The app it replaces was running: start the new one. Packages land on the
# menu (doop-desktop.desktop); the AppImage is launched by path.
relaunch_linux() {
  case $1 in
    appimage) "$(appimage_dir)/Diazo_${VERSION}_amd64.AppImage" >/dev/null 2>&1 & ;;
    *)
      if command -v gtk-launch >/dev/null 2>&1; then
        gtk-launch doop-desktop >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

done_message() {
  if [ "$OS" = linux ]; then
    cat <<EOF

Diazo $VERSION is installed.
  updates:  automatic, from https://github.com/$DOOP_DESKTOP_REPO/releases
  data:     $XDG_DATA_DIR (kept across updates and reinstalls)

Use your own server (self-hosted or your Diazo instance): on the sign-in
screen, click the cog, enter its address (https://…, or http://localhost:4400
for a local install) and confirm. The app saves it as server.json in the data
folder above and restarts onto it.
EOF
    return 0
  fi
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

# ---------------------------------------------------------------- dry run
plan() {
  say "[dry run] nothing is changed. The steps:"
  case $OS in
    macos) printf '  %s\n' "download Diazo_${VERSION:-<latest>}_universal.app.tar.gz, check SHA256SUMS (and the signature with minisign)" \
      "swap Diazo.app into $(pick_dir), quitting a running Diazo first" ;;
    linux)
      case $(pick_kind) in
        deb) printf '  %s\n' "download Diazo_${VERSION:-<latest>}_amd64.deb, check SHA256SUMS, install with apt or dpkg (as root)" ;;
        rpm) printf '  %s\n' "download Diazo-${VERSION:-<latest>}-1.x86_64.rpm, check SHA256SUMS, install with dnf, zypper or rpm (as root)" ;;
        *) printf '  %s\n' "download Diazo_${VERSION:-<latest>}_amd64.AppImage, check SHA256SUMS, install into $(appimage_dir)" \
          "write the menu entry $DESKTOP_FILE" ;;
      esac
      ;;
  esac
}

do_install() {
  check_platform
  if [ "$DRY_RUN" = 1 ]; then
    plan
    return 0
  fi
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/diazo-desktop.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [ -z "$VERSION" ]; then
    VERSION=$(latest_version)
  fi
  if [ "$OS" = linux ]; then
    kind=$(pick_kind)
    current=$(linux_version "$kind")
    if [ "$FORCE" = 0 ] && [ "$current" = "$VERSION" ]; then
      say "Diazo $VERSION is already installed (--force reinstalls it)"
      return 0
    fi
    download "$(pick_asset)"
    quit_linux_app
    case $kind in
      deb) install_deb ;;
      rpm) install_rpm ;;
      *) install_appimage ;;
    esac
    done_message
    if [ "$WAS_RUNNING" = 1 ]; then
      relaunch_linux "$kind"
    fi
    return 0
  fi
  dir=$(pick_dir)
  current=$(installed_version "$dir/$APP_NAME")
  if [ "$FORCE" = 0 ] && [ "$current" = "$VERSION" ] && trusts_our_key "$dir/$APP_NAME"; then
    say "Diazo $VERSION is already installed in $dir (--force reinstalls it)"
    remove_legacy
    return 0
  fi
  download "$(pick_asset)"
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
  case $OS in
    windows)
      cat >&2 <<EOF
diazo: this shell installer does not run on Windows. In PowerShell:

  \$env:DOOP_DESKTOP_UNINSTALL='1'; $POWERSHELL_LINE

EOF
      exit 1
      ;;
    linux)
      kind=$(pick_kind)
      removed=0
      for file in "$(appimage_dir)"/Diazo_*_amd64.AppImage; do
        if [ -f "$file" ]; then
          quit_linux_app
          rm -f "$file"
          say "removed $file"
          removed=1
        fi
      done
      if [ -f "$DESKTOP_FILE" ]; then
        rm -f "$DESKTOP_FILE"
        say "removed $DESKTOP_FILE"
      fi
      if [ "$kind" = deb ] && command -v dpkg >/dev/null 2>&1 && dpkg -s diazo >/dev/null 2>&1; then
        quit_linux_app
        if command -v apt >/dev/null 2>&1; then
          as_root apt remove -y diazo || die "apt could not remove diazo"
        else
          as_root dpkg -r diazo || die "dpkg could not remove diazo"
        fi
        say "removed the diazo package"
        removed=1
      elif [ "$kind" = rpm ] && command -v rpm >/dev/null 2>&1 && rpm -q diazo >/dev/null 2>&1; then
        quit_linux_app
        if command -v dnf >/dev/null 2>&1; then
          as_root dnf remove -y diazo || die "dnf could not remove diazo"
        elif command -v zypper >/dev/null 2>&1; then
          as_root zypper --non-interactive remove diazo || die "zypper could not remove diazo"
        else
          as_root rpm -e diazo || die "rpm could not remove diazo"
        fi
        say "removed the diazo package"
        removed=1
      fi
      [ "$removed" = 1 ] || say "Diazo is not installed"
      say "kept $XDG_DATA_DIR (delete it to forget the sign-in and the chosen server)"
      return 0
      ;;
    macos) ;;
    *) die "unsupported system: $(uname -s)" ;;
  esac
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
  detect_os
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
