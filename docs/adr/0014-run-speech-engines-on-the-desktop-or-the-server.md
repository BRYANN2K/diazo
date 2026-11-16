# 0014. Run speech engines on the desktop or the server, and voice-over on ElevenLabs too

One architecture decision for Diazo. Read by anyone, human or agent, about to change transcription, voice-over or the speech sidecar.

## Status

Proposed, updated 2026-11-16.

## Context

Motion Studio's phase 3 cuts video by its transcript and adds captions and voice-over. Transcript cuts and word-highlight captions need word timings. Bryan decided on 2026-11-16 that transcription and voice-over install in one click, on the person's Mac or on the Diazo server, their choice, with the model of their choice, and that voice-over also runs on ElevenLabs with the person's own key. The owner's VPS has 8 CPU cores, no GPU and 31 GB of memory, shared with the app, Postgres and the renderer. Facts below were read on 2026-11-16.

## Decision

- Transcription defaults to Parakeet TDT 0.6B v3 (int8, CC-BY-4.0, 25 European languages, native word timings) through sherpa-onnx on both targets. whisper.cpp with large-v3-turbo, or large-v3, is the choice for other languages.
- Local voice-over defaults to VoxCPM2 (Apache-2.0) through mlx-audio on the Mac, after a blind listening test against Qwen3-TTS and Ming-3.0. Kyutai Pocket TTS (CC-BY-4.0) is the fallback and the server's default.
- ElevenLabs is a `model_accounts` connection kind (`elevenlabs-key`) used for voice only, never as an agent runner. Its cost is shown before each run.
- The desktop shell downloads engines and models from a catalog compiled into it, checks each file's SHA-256, and runs engines as child processes with fixed arguments. The page sends only a catalog model id.
- On the server, engines run in a `diazo-speech` sidecar with CPU and memory limits and its own model volume, reached over the cluster network only. Only instance admins install there.
- Engine binaries come from our own signed `speech-engines-v*` release, built from pinned upstream tags. No weights are committed.
- Out of scope: speaker labels, live transcription, a cloud transcription route, and uploading voice samples to a provider.

## Alternatives rejected

- Whisper (any runtime) as the default. Rejected: Parakeet v3 is more accurate in English and French, much faster, and gives native word timings.
- faster-whisper or WhisperX. Rejected: Python on the server for no accuracy gain, and WhisperX's diarization needs a gated model and a token.
- Transcription on the person's cloud account by default. Rejected: Bryan wants local first; audio would leave the instance.
- Fish Audio, Breeze, Higgs Audio, Voxtral TTS, F5-TTS or XTTS for voice-over. Rejected: non-commercial or research weights.
- Chatterbox. Rejected: retired in August 2026, and it watermarks every file.
- Engines inside the app's own process on the server. Rejected: a long transcript could starve or kill the canvas.

## Consequences

- Good: speech stays on the person's Mac or their own server, and every default model has weights a fork may sell.
- Good: one catalog drives the desktop, the server, the editor and the agent tools.
- Bad: a new sidecar image, a CI release of engine binaries, and a 20 Gi volume to maintain.
- Bad: the Studio voice needs Apple silicon; the CPU-only server gets the less expressive Pocket TTS.
- Bad: VoxCPM2 has no arena ranking yet, and its card warns of instability on long input, so narration is generated sentence by sentence.
- Follow-up: measure CPU speed on the VPS, read Pocket TTS's gate terms, run the listening test.

## Confidence

Medium. The listening test or a VPS benchmark that misses the estimates would reopen the defaults, not the shape.

## Links

[.workflow/changes/motion-studio/proposal.md](../../.workflow/changes/motion-studio/proposal.md), section 18. [ADR 0008](0008-run-local-cli-agents-over-acp-through-the-desktop-app.md) and [ADR 0004](0004-expose-the-instance-over-tailscale-only.md).
