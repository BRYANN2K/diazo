# Motion Studio backend, phases 2 to 5

## Problem

The phase 0–1 backend (change `motion-studio-backend`) shipped the composition contract, persistence, REST, room messages, render jobs, the MCP and resident tools and the deterministic desktop render. The product proposal [../motion-studio/proposal.md](../motion-studio/proposal.md) and its spec [../motion-studio/spec.md](../motion-studio/spec.md) define phases 2 to 5; this change is their backend.

## Scope

Per phase, contract first (`shared/motion*.ts`, `docs/motion-api.md` additive changes), then persistence, REST, room messages, MCP and resident tools with parity in `tests/agentToolParity.test.ts`, and the desktop shell where a target is local.

- **Phase 2** — transitions and camera presets, text animators, mask and path properties, library Motion items inserted as clips with their stored seek-safe verdict, GIF and PNG-sequence render formats, CSS and WAAPI code export, scene version list and restore, time-range comments.
- **Phase 3** — media clips (trim, split, speed, levels, fades, ducking, beat markers), transcripts and transcript cuts, captions from transcripts, generated image and video layers keeping their recipe (`generate_video` on OpenRouter and Gemini), and the speech stack of proposal section 18: engine catalog, one-click installs on the desktop (Rust) and the server sidecar, custom models, cloud transcription and ElevenLabs voice-over on the person's own key, `transcribe_clip` and `generate_voiceover` tools, the Pocket TTS mirror design and script (not published).
- **Phase 4** — glTF/GLB import to a three.js layer, `3d` layers and drivers (time, scroll, pointer), the real Blender bridge through the desktop shell with per-kind approvals and read/write/render tools, Eevee/Cycles/Octane as engine names.
- **Phase 5** — server-side renders through the renderer gate (60 s, 1080p, 30 fps, one render per account), Lottie import and export of the vector subset, HyperFrames project import and export, the motion duel.

## Where the work is

Branch `feat/motion-backend-next`, worktree `doop-wt/motion-next`. Backend only: `server/`, `shared/`, `desktop/src-tauri`, migrations, MCP and resident tools. The frontend codes against `docs/motion-api.md`.

## Decisions and open questions

- The contract grows additively only; anything else lands in `docs/motion-api.md` "Changes".
- Octane stays an engine name passed to Blender, never an integration (proposal section 15).
- Speech servers: desktop engines are child processes spawned by the shell with fixed arguments from a compiled catalog; the server target is the `diazo-speech` sidecar behind `DOOP_SPEECH_URL`/`DOOP_SPEECH_TOKEN` (ADR 0014).
- The Blender bridge keeps its `DOOP_BLENDER_BRIDGE` gate; write and render tools additionally need a recorded approval grant (ADR 0011).
- `whisper-1` is labelled with its 2027-02-26 shutdown; OpenAI prices are dated in `shared/modelPrices.ts`.
