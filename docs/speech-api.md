# Speech jobs

Backend contract for transcription and voice-over. Read by clients, canvas tool maintainers and desktop implementers.
Status: partial, updated 2026-11-16

The wire types and request validator live in `shared/speech.ts`. This is an additive phase 3 contract beside [motion-api.md](motion-api.md). The decisions remain [ADR 0014](adr/0014-run-speech-engines-on-the-desktop-or-the-server.md).

## Available backend

Jobs, preferences and server install records persist in Postgres or PGlite. A person has at most one queued or running job, enforced by a partial unique index. A restart fails queued and running jobs rather than retrying a potentially paid request. Terminal jobs cannot be claimed or completed again.

`auto` uses this person's online desktop with the selected model, then a ready server installation, otherwise returns an install error. It never selects cloud. Desktop and server defaults differ for voice-over. An explicit cloud preference still requires a cost acknowledgement on every request.

Cloud adapters use the person's enabled `openai-key` or `elevenlabs-key`, never instance credentials. Voice connections appear in account settings but cannot run canvas tasks, become the default runner, or enter runner menus. No credentials are included in a job or catalog response.

## Requests and estimates

```ts
interface SpeechRequest {
  kind: 'transcribe' | 'speak'
  target?: 'auto' | 'desktop' | 'server' | 'cloud'
  model?: string
  media_id?: string // transcription: scene_media row on this canvas
  page_id?: string // voice-over: page with a composition
  provider?: 'elevenlabs' | 'openai'
  language?: string
  speakers?: boolean
  text?: string // voice-over script, at most 40,000 characters
  voice?: string // voice id; no paths or URLs
  at?: number // voice-over start on the composition clock, default 0
  seconds?: number // declared source duration for a cloud transcription estimate
  max_cost?: number // USD estimate acknowledged before a cloud run
}
```

Unknown properties and invalid numbers are rejected. A transcription must reference an audio or video asset belonging to the job's canvas, at most 25 MiB. Voice-over requires text, voice, page_id and an existing composition. Its timed output must fit within that composition; it is never silently truncated.

`POST /api/speech/estimate` accepts this request and returns `{ usd, estimated: true, basis }`. For cloud transcription, `seconds` is required. For voice-over, cost derives from the script length and selected model's menu rate. A subsequent cloud job must supply `max_cost >= usd`. This acknowledges an estimate, not a provider-enforced billing limit. Rates are menu estimates and account billing may differ. Show the basis to the person.

The current cloud transcription adapters are Scribe with word timings and optional speaker labels, and OpenAI `whisper-1` with word timings. Asking the latter for speaker labels is rejected. Text-only transcription and alignment are still pending.

## REST

All routes require the existing authenticated API session. `DOOP_SPEECH=false` hides `/api/speech`; the same flag disables speech tools.

| Route                                         | Body or result                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/speech/catalog`                     | Curated catalog, this person's desktop availability, server installations, custom model metadata, and menu estimates. Descriptive catalog entries are not installation manifests. |
| `GET /api/speech/preferences`                 | This person's preferences; defaults to auto for both job kinds.                                                                                                                   |
| `PUT /api/speech/preferences`                 | Full validated preferences: transcribeTarget, voiceTarget, speakers, optional modelId, cloudProvider, voiceProvider, voice, language.                                             |
| `POST /api/speech/estimate`                   | Request above; returns the estimate without invoking an engine.                                                                                                                   |
| `POST /api/speech/jobs`                       | Request above plus `canvas_id`; edit access required. Returns `201 { job }`.                                                                                                      |
| `GET /api/speech/jobs/:id`                    | `{ job }`, only its requester with current canvas view access. Foreign jobs return 404.                                                                                           |
| `DELETE /api/speech/jobs/:id`                 | Cancels this person's active job. A late engine result cannot complete a canceled job.                                                                                            |
| `POST /api/speech/server/installs/:modelId`   | Admin only. Refuses unpinned manifests and missing per-file sizes or hashes.                                                                                                      |
| `DELETE /api/speech/server/installs/:modelId` | Admin only. Relays uninstall to the configured sidecar before removing its record.                                                                                                |
| `POST /api/speech/custom-models`              | Register a model (18.9). Server target is admin only; local files and mlx-audio are desktop only. The model stays `enabled: false` until its smoke test.                          |
| `POST /api/speech/custom-models/:id/test`     | Re-run the smoke test on a server-target model. Desktop models are tested by their shell and report on the next poll.                                                             |
| `DELETE /api/speech/custom-models/:id`        | Remove it — the owner, or an admin for an instance row. A server row also uninstalls on the sidecar.                                                                              |
| `GET /api/speech/custom-models/:id/token`     | `{ token }` — the owner's sealed HF token back once, for the desktop shell's download of a gated repo. Instance tokens never return.                                              |
| `PUT /api/speech/media/:mediaId/speakers`     | `{ canvas_id, names: { S1: 'Ana' } }` — rename the speakers a transcript produced (18.8); an `S<n>` the media does not carry is refused.                                          |
| `PUT /api/speech/voices/sample`               | Raw consent-sample audio (WAV or MP3, ≤ 25 MiB). Stored as a private asset owned by the person, never canvas-scoped. Returns `{ asset }`.                                         |
| `GET /api/speech/voices`                      | `{ voices }` — this person's cloned voices.                                                                                                                                       |
| `POST /api/speech/voices`                     | `{ name, sampleAssetId, sampleTranscript?, engines?, consent: true }`. The sample must be one of their uploaded audio files.                                                      |
| `DELETE /api/speech/voices/:id`               | Remove the voice and its private sample together.                                                                                                                                 |
| `GET /api/speech/elevenlabs/voices?search=…`  | Provider voices on this person's key, with a short cache.                                                                                                                         |

The ElevenLabs key connects through `POST /api/model-account/elevenlabs-key` with `{ apiKey }`, using the existing sealed account storage and disconnect/toggle routes. `DOOP_ELEVENLABS=false` disables its speech adapters.

Invalid input, unavailable models and active-job conflicts return 400 with an error. Foreign jobs return 404; denied canvas access and non-admin install requests return 403. Provider failures become a failed job with a generic error, never a raw provider body or secret.

## Desktop shell commands

`desktop/src-tauri/src/speech.rs` implements the install and engine half of the desktop target. Five Tauri commands, all re-validated natively:

- `speech_models` returns `{ models: [{ id, engine, state }] }` — the list a poll heartbeat reports.
- `speech_engine_status` resolves the `diazo-speech` sidecar binary (the app's engines dir, then PATH) and returns its path.
- `speech_install` takes a `CatalogEntry` JSON plus an optional HF token. `mirror` sources download `SHA256SUMS` and `SHA256SUMS.minisig` from the release, verify the signature against the updater's release key (Ed25519 over the Blake2b-512 prehash), then verify each file's SHA-256. `hf` sources require a 40-hex commit and take each file's `sha256` from the catalog, or from HF's `lfs.oid` metadata at that commit when the catalog leaves it empty. Downloads land under `<appData>/speech/models/<id>/`, resume a `.part` with a Range request, and only rename into place after the hash passes. One install per model at a time; a token never reaches a mirror URL.
- `speech_uninstall` removes the manifest row and the model directory.
- `speech_run` runs one claimed job: `diazo-speech --kind <asr|tts|speakers> --engine <runtime> --model <model_dir> --in <in> --out <out>` inside `<appData>/speech/work/<jobId>/`, killed past 10 minutes, output path returned. The input file is the media the poll downloaded; the engine log stays in the work dir.

The sidecar binary itself ships in a `speech-engines-v*` release (not built yet); `speech_run` fails cleanly until then.

## Desktop relay

The backend relay is implemented. The shell's install and run commands are wired above, but no `diazo-speech` sidecar binary exists yet, so jobs cannot execute on a Mac end to end.

1. `POST /api/speech/desktop/poll` with `{ deviceId, models: string[], smoke? }` reports this user's ready models and atomically claims matching jobs. Only this person's jobs with current canvas edit access are returned. The response is `{ jobs }`, each claimed job running with deviceId set. Availability expires after 30 seconds. `smoke` carries the shell's custom-model smoke reports `[{ modelId, ok, log, tookMs }]`; only the reporting user's own desktop rows take them, and a pass flips `enabled` to true.
2. A transcription worker reads the job's canvas asset using the authenticated session and runs its local engine. It posts `POST /api/speech/desktop/finish/:id` with `{ deviceId, state: 'done', transcript }`. The server validates the words and stores them on the original media row in the same transaction as the terminal job update.
3. A voice worker uploads WAV or MP3 bytes to `PUT /api/speech/desktop/audio/:id`, `Content-Type: application/octet-stream`, `X-Speech-Device: <deviceId>`, at most 25 MiB. The server checks requester, claiming device, active state and canvas edit access, sniffs the file, and returns `{ asset }`.
4. It finishes with `{ deviceId, state: 'done', transcript, outputAssetId }`. The audio must belong to this requester and canvas. The result creates an audio media row with the script/voice/model recipe, then inserts an audio clip on the timeline at `at`.
5. Progress uses the finish route with `{ deviceId, state: 'running', progress: 0..1 }`; it cannot move backwards. Failure uses `{ deviceId, state: 'failed' }`; engine diagnostics are not accepted into public jobs.

A disconnect does not release a running claim to another device. Cancel the job and submit a new one; do not replay a paid call automatically. Cancellation discards a late result; it cannot refund or interrupt a provider's work. A timeline change during completion can prevent clip insertion. In that case the job becomes failed and retains its generated audio asset for manual insertion. Timeline persistence uses the existing composition write path; job and media writes are transactional, composition writes are separate.

The room broadcasts `speech:progress { job }` and `media:transcribed { mediaId, transcript }`. Job progress is visible to canvas collaborators. Do not put private engine logs into requests or results.

## Canvas tools

MCP takes `canvas_id` and `agent_name`; resident tools use the run's canvas and payer. Both share `server/speechTools.ts`, with the same validator and access checks.

- `list_speech_engines {}` lists available targets and catalog metadata.
- `estimate_speech { request: SpeechRequest }` returns the estimate.
- `transcribe_clip` takes the request fields except kind, text and voice; kind is fixed to transcribe.
- `generate_voiceover` takes the request fields except kind and media_id; kind is fixed to speak.
- `get_transcript { job_id? , media_id? }` returns this person's job on this canvas, or a canvas media transcript. Poll this after a queued job; tool submission does not block on an engine.
- `list_voices {}` lists this person's persisted local voices. Voice creation goes through the REST routes above (sample upload, then the voice with recorded consent).

## Sidecar adapter and outstanding work

`DOOP_SPEECH_URL` and `DOOP_SPEECH_TOKEN` configure the internal bearer-authenticated sidecar adapter. Both are required. No default endpoint is contacted. Installs use `POST /v1/installs` and `DELETE /v1/installs/:modelId`; jobs use `POST /v1/transcribe` or `/v1/speak` with `{ model_id, request, audio? }`, where audio is base64 source bytes. The adapter expects `{ transcript, audio_base64? }`. This protocol has not been exercised against real engines.

Every current curated catalog row remains unavailable to the installer because its exact release manifest has not been pinned and verified. The catalog's approximate sizes and mutable refs are descriptive placeholders, never download authorization. No weights are downloaded by these routes in this state.

Still required for the phase 3 acceptance criteria:

- Desktop engine installer, signed release verification, resumed downloads, native file selection, Metal execution, cancellation and smoke tests.
- The actual speech sidecar, its 6 CPU / 10 Gi limits and 20 Gi volume, benchmark and operational checks.
- Local diarization; cloud text-only transcription and local alignment.
- Pocket TTS mirror design and preparation script, attribution and signature verification. Nothing has been published.
- Listening tests, real ten-minute French transcripts on both local targets and live provider verification on an explicitly selected account.

Provider request shapes checked against the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text), [Scribe endpoint](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) and [timed voice-over endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps). Automated adapter tests use simulated responses; they do not establish account access, quality or actual charges.
