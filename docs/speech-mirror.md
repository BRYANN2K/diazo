# Mirrored speech weights: Pocket TTS

Design for the one-click install that needs no Hugging Face account. Decided
2026-11-16 (proposal 18.15, [ADR 0014](adr/0014-run-speech-engines-on-the-desktop-or-the-server.md)).
Status: design and preparation script only — nothing is published.

## Why a mirror

Pocket TTS's weights sit behind a Hugging Face gate. The gate asks people to
share their account, comply with the law, never clone or impersonate a voice
without explicit and lawful consent, and never present generated audio as a
genuine recording. The licence itself (CC-BY-4.0) allows redistribution with
attribution, so we mirror the files at one pinned upstream commit, unchanged,
and pass the gate's conditions on in the install dialog. The consent rule and
the synthetic mark (proposal 18.14) already meet them.

Rejected: a GHCR OCI artifact. Anonymous pulls work for a public package, but
it adds an OCI client to the shell and the sidecar for a ~100 MB model.

## The release

A GitHub release `speech-models-v<n>` on `BRYANN2K/diazo`, beside the engine
releases (`speech-engines-v*`). Each release carries:

- the weight files at the pinned upstream commit, **unchanged**, under their
  repository-relative paths;
- `SHA256SUMS` over those files, plus `SHA256SUMS.minisig` — a minisign
  signature made with the updater's key (public key `B1375F7E88B8FC72`,
  embedded in `desktop/src-tauri/tauri.conf.json`);
- `ATTRIBUTION.md` (below).

The catalog entry points at the release:

```ts
source: { type: 'mirror', release: 'speech-models-v1' }
```

Anonymous download, no token, the same path the engine downloads take, far
under the 2 GB asset limit.

## Verification path

1. Installer fetches `SHA256SUMS` and `SHA256SUMS.minisig` from the release
   and verifies the signature against the pinned minisign public key. A bad
   or missing signature stops the install.
2. Each file downloads; its SHA-256 must match the signed manifest before it
   is moved into place. A partial download resumes (HTTP Range).
3. `ATTRIBUTION.md` lands beside the weights on every target; it also ships
   in `THIRD-PARTY-LICENSES` and in Settings → About.

## Attribution (`ATTRIBUTION.md` in the release)

- "Pocket TTS" by Manu Orsini, Simon Rouard, Gabriel De Marmiesse,
  Václav Volhejn, Neil Zeghidour and Alexandre Défossez (Kyutai).
- The paper: arXiv:2509.06926.
- The source: `https://huggingface.co/kyutai/pocket-tts` at the pinned
  commit, "not modified".
- The licence: CC-BY-4.0, linked.
- The gate's conditions of use, restated.

## Preparing a release

`scripts/prepare-speech-mirror.sh` stages a release directory:

```sh
scripts/prepare-speech-mirror.sh \
  --commit <40-hex upstream commit> --release speech-models-v1 \
  --out /tmp/speech-models-v1 --sign-key ~/.minisign/diazo.key
```

It resolves the file list at the pinned commit through the Hugging Face API,
downloads each file (the repo is gated: pass the maintainer's own read token
as `HF_TOKEN`, and `--files` to carry only the weight files rather than the
whole tree), writes `SHA256SUMS`, `SHA256SUMS.minisig` and `ATTRIBUTION.md`,
then prints the `gh release create` command. It never publishes: the release
step is a human's. Without `--sign-key` the manifest is left unsigned and the
script prints the minisign command instead.

## Updates

A new upstream commit is read, mirrored as a new `speech-models-v<n+1>`
release by hand, and the catalog entry's `release` and `files` (new sizes and
hashes) are bumped in the same pull request. An old release is never edited:
a signed manifest someone already downloaded must keep verifying.
