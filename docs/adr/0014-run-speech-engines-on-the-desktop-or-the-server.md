# 0014. Run speech engines on the desktop or the server, and voice-over on ElevenLabs too

One architecture decision for Diazo. Read by anyone, human or agent, about to change transcription, voice-over, speaker labels or the speech sidecar.

## Status

Accepted, 2026-11-16.

## Context

Motion Studio's phase 3 cuts video by its transcript and adds captions and voice-over. Transcript cuts and word-highlight captions need word timings. Bryan decided on 2026-11-16 that transcription and voice-over install in one click, on the person's Mac or on the Diazo server, their choice, with the model of their choice, that people can add their own models, that cloud transcription and speaker labels are in v1, and that voice-over also runs on ElevenLabs with the person's own key. The owner's VPS has 8 CPU cores, no GPU and 31 GB of memory, shared with the app, Postgres and the renderer. Facts below were read on 2026-11-16.

## Decision

- Transcription defaults to Parakeet TDT 0.6B v3 (int8, CC-BY-4.0, 25 European languages, native word timings) through sherpa-onnx on both targets. whisper.cpp with large-v3-turbo, or large-v3, is the choice for other languages.
- On the Mac, the voice-over menu offers three studio voices with permissive weights: VoxCPM2 (Apache-2.0), Qwen3-TTS (Apache-2.0) and Ming-3.0 (MIT), through mlx-audio. A blind listening test picks which one is preselected. Kyutai Pocket TTS (CC-BY-4.0) is the fast voice and the server's default, beside Kokoro for English previews and a slow Qwen3-TTS 0.6B on CPU.
- Every target also takes a custom model: a Hugging Face repository pinned to a commit, or files picked in the desktop's native file panel, for a runtime from a fixed set (sherpa-onnx, whisper.cpp, mlx-audio, Pocket TTS, pyannote). Each one is size-checked and hash-checked, the person acknowledges its licence, and it stays disabled until a smoke test passes. Pickle files are refused.
- Cloud transcription runs on the person's own key only when they pick it: ElevenLabs Scribe (words and speakers) on `elevenlabs-key`, and OpenAI (`whisper-1` for words until its 2027-02-26 shutdown, `gpt-transcribe` for text) on `openai-key`. The cost is shown before each run.
- Speaker labels come from Scribe in the cloud, and locally from sherpa-onnx's diarization: pyannote segmentation-3.0 (MIT, ungated in sherpa-onnx's release) with a 3D-Speaker embedding. pyannote's gated community-1 pipeline is a custom model on the person's own Hugging Face token.
- ElevenLabs is a `model_accounts` connection kind (`elevenlabs-key`) used for voice and transcription, never as an agent runner.
- The desktop shell downloads only from its compiled catalog, our releases or `huggingface.co`, checks each file's SHA-256, and runs engines as child processes with fixed arguments. The page never sends a URL or a path.
- On the server, engines run in a `diazo-speech` sidecar with CPU and memory limits and its own model volume, reached over the cluster network only. Only instance admins install, uninstall, update or add models there. Everyone else uses those models or their own Mac.
- Engine binaries come from our own signed `speech-engines-v*` release, built from pinned upstream tags. Pocket TTS's weights are mirrored, unchanged and with their attribution, as a signed `speech-models-v*` release asset. No weights are committed.
- Out of scope: live transcription, a llama.cpp-style TTS runtime, and uploading voice samples to a provider.

## Alternatives rejected

- Whisper (any runtime) as the default. Rejected: Parakeet v3 is more accurate in English and French, much faster, and gives native word timings.
- faster-whisper or WhisperX. Rejected: Python on the server for no accuracy gain, and WhisperX's diarization needs a gated model and a token.
- One preselected studio voice with no alternatives. Rejected: no arena ranks VoxCPM2 or Qwen3-TTS, and Bryan wants the choice.
- Fish Audio, Breeze, Higgs Audio, Voxtral TTS, F5-TTS or XTTS for voice-over. Rejected: non-commercial or research weights.
- Chatterbox. Rejected: retired in August 2026, and it watermarks every file.
- Pocket TTS through a Hugging Face token per person, or as a GHCR OCI artifact. Rejected: a token breaks the one click, and an OCI client is too much code for a 100M model.
- Engines inside the app's own process on the server. Rejected: a long transcript could starve or kill the canvas.
- Server installs by any user. Rejected: the cores and the volume are shared by the whole instance.

## Consequences

- Good: speech stays on the person's Mac or their own server unless they pick a cloud provider, and every curated model has weights a fork may sell.
- Good: one catalog and one custom-model contract drive the desktop, the server, the editor and the agent tools.
- Bad: a new sidecar image, two CI release streams (engines, mirrored models) and a 20 Gi volume to maintain.
- Bad: the studio voices need Apple silicon; the CPU-only server gets Pocket TTS or a slow Qwen3-TTS.
- Bad: custom models put licence compliance on the person; Diazo records the acknowledgement and checks nothing.
- Bad: OpenAI loses word timings when `whisper-1` shuts down on 2027-02-26.
- Follow-up: measure CPU speed on the VPS, run the listening test, confirm the 3D-Speaker embedding's licence, read OpenAI's transcription prices.

## Confidence

Medium. The listening test or a VPS benchmark that misses the estimates would change the preselected models, not the shape.

## Links

[.workflow/changes/motion-studio/proposal.md](../../.workflow/changes/motion-studio/proposal.md), section 18. [ADR 0008](0008-run-local-cli-agents-over-acp-through-the-desktop-app.md) and [ADR 0004](0004-expose-the-instance-over-tailscale-only.md).
