#!/bin/sh
# diazo: stage a speech-models-v<n> release directory (docs/speech-mirror.md).
#
#   scripts/prepare-speech-mirror.sh --commit <40-hex> --release speech-models-v1 \
#     --out <dir> [--files <a.safetensors,b.json>] [--sign-key <minisign secret key>]
#
# Downloads every file of kyutai/pocket-tts at the pinned commit, writes
# SHA256SUMS, SHA256SUMS.minisig (when --sign-key is given) and
# ATTRIBUTION.md into <out>, then prints the `gh release create` command to
# run by hand. It never publishes anything itself.
#
# Settings (environment):
#   SPEECH_REPO   the upstream Hugging Face repo (default kyutai/pocket-tts)
#   SPEECH_GH     the GitHub repo the release lands on (default BRYANN2K/diazo)
#   HF_TOKEN      a Hugging Face read token — required when the repo is gated

set -eu

REPO=${SPEECH_REPO:-kyutai/pocket-tts}
GH=${SPEECH_GH:-BRYANN2K/diazo}
AUTH=()
[ -n "${HF_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $HF_TOKEN")
COMMIT=
RELEASE=
OUT=
SIGN_KEY=
FILES=

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT=$2; shift 2 ;;
    --release) RELEASE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --sign-key) SIGN_KEY=$2; shift 2 ;;
    --files) FILES=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "prepare-speech-mirror: $*" >&2; exit 1; }

[ -n "$COMMIT" ] || fail "--commit is required (the pinned 40-hex upstream commit)"
echo "$COMMIT" | grep -qE '^[0-9a-f]{40}$' || fail "--commit must be a pinned commit hash, not a ref"
[ -n "$RELEASE" ] || fail "--release is required (e.g. speech-models-v1)"
echo "$RELEASE" | grep -qE '^speech-models-v[0-9]+$' || fail "--release must look like speech-models-v<n>"
[ -n "$OUT" ] || fail "--out is required"
for tool in curl jq shasum; do command -v "$tool" >/dev/null || fail "$tool is required"; done

mkdir -p "$OUT/files"
cd "$OUT/files"

echo "==> listing files of $REPO at $COMMIT"
curl -fsSL "https://huggingface.co/api/models/$REPO/tree/$COMMIT" -o /tmp/speech-tree.$$.json
jq -r '.[] | select(.type == "file") | .path' /tmp/speech-tree.$$.json > /tmp/speech-tree-files.$$.txt
rm -f /tmp/speech-tree.$$.json
if [ -n "$FILES" ]; then
  # only the named files: each must exist upstream at this commit
  : > /tmp/speech-files.$$.txt
  old_ifs=$IFS; IFS=','
  for path in $FILES; do
    IFS=$old_ifs
    grep -qxF "$path" /tmp/speech-tree-files.$$.txt || fail "not in $REPO at $COMMIT: $path"
    echo "$path" >> /tmp/speech-files.$$.txt
  done
  IFS=$old_ifs
else
  cp /tmp/speech-tree-files.$$.txt /tmp/speech-files.$$.txt
fi
rm -f /tmp/speech-tree-files.$$.txt
[ -s /tmp/speech-files.$$.txt ] || fail "no files at that commit"

echo "==> downloading $(wc -l < /tmp/speech-files.$$.txt | tr -d ' ') file(s)"
while IFS= read -r path; do
  case "$path" in
    ..|../*|*/../*|*/..|.git|.git/*|*/.git/*|*' '*|*'"'*|*"'"*) fail "unsafe path from upstream: $path" ;;
  esac
  mkdir -p "$(dirname "$path")"
  curl -fsSL --retry 3 ${AUTH[@]+"${AUTH[@]}"} -o "$path" "https://huggingface.co/$REPO/resolve/$COMMIT/$path"
done < /tmp/speech-files.$$.txt
rm -f /tmp/speech-files.$$.txt

echo "==> hashing"
find . -type f ! -name SHA256SUMS ! -name 'SHA256SUMS.*' ! -name ATTRIBUTION.md -print0 \
  | sort -z | xargs -0 shasum -a 256 | sed 's| \./| |' > SHA256SUMS

cat > ATTRIBUTION.md <<EOF
# Pocket TTS

"Pocket TTS" by Manu Orsini, Simon Rouard, Gabriel De Marmiesse,
Václav Volhejn, Neil Zeghidour and Alexandre Défossez (Kyutai).

- Paper: https://arxiv.org/abs/2509.06926
- Source: https://huggingface.co/$REPO at commit $COMMIT — not modified.
- Licence: Creative Commons Attribution 4.0 International
  (https://creativecommons.org/licenses/by/4.0/).

Conditions of use carried over from the upstream repository's gate: comply
with the law; never clone or impersonate a voice without the explicit and
lawful consent of the person; never present generated audio as a genuine
recording of real people or events.
EOF

if [ -n "$SIGN_KEY" ]; then
  command -v minisign >/dev/null || fail "minisign is required to sign (or drop --sign-key)"
  echo "==> signing SHA256SUMS"
  minisign -S -s "$SIGN_KEY" -m SHA256SUMS -x SHA256SUMS.minisig \
    -t "diazo $RELEASE — mirrored speech weights" </dev/null
else
  echo "==> no --sign-key: leaving SHA256SUMS unsigned (a release must ship it signed)"
fi

cat <<EOF

Staged in $OUT. Review, then publish by hand:

  gh release create $RELEASE --repo $GH \\
    --title "$RELEASE" --notes "Mirrored speech weights — see ATTRIBUTION.md" \\
    $OUT/files/* $OUT/files/SHA256SUMS $OUT/files/SHA256SUMS.minisig $OUT/files/ATTRIBUTION.md
EOF
