#!/usr/bin/env bash
# Prints the `tauri build --config` override for the updater packages
# (desktop-release.yml): on when TAURI_SIGNING_PRIVATE_KEY is set, required
# on a desktop-v* tag so a release always reaches installed apps. On a tag it
# also refuses a version the shells do not carry: the release job names the
# feed's packages after the tag, the bundler after tauri.conf.json.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${GITHUB_REF:-}" == refs/tags/desktop-v* ]]; then
  tag=${GITHUB_REF#refs/tags/desktop-v}
  for conf in src-tauri/tauri.conf.json src-tauri-chromium/tauri.conf.json; do
    version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$conf")
    if [ "$version" != "$tag" ]; then
      echo "::error::tag desktop-v$tag but $conf says $version; bump the desktop version first" >&2
      exit 1
    fi
  done
fi
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo '{"bundle":{"createUpdaterArtifacts":true}}'
elif [[ "${GITHUB_REF:-}" == refs/tags/desktop-v* ]]; then
  echo "::error::TAURI_SIGNING_PRIVATE_KEY is not set; a release without updater packages would strand installed apps" >&2
  exit 1
else
  echo "::warning::TAURI_SIGNING_PRIVATE_KEY not set: building without updater packages" >&2
  echo '{}'
fi
