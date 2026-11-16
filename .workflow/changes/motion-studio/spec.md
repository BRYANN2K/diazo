# Motion Studio (Rostrum)

## Intent

A page with a clock: an ordinary page gains a seekable timeline whose every pixel is a function of time, so a film is made from the canvas's own frames, played in the canvas, exported as video or shipped as code. Full proposal: [proposal.md](proposal.md). Each phase is built as its own change; this spec holds the outcome of each phase.

## Acceptance criteria

- AC-1: Phase 0. An agent-written frame scrubs and snapshots at any time, and the `MO-*` lint names what is not seek-safe.
- AC-2: Phase 1. A 15 s film made from three frames on one page exports as MP4 or WebM from the browser or the desktop app, with no tool outside Diazo.
- AC-3: Phase 2. Layer keyframes, transitions and the text animator export as CSS and WAAPI code a developer can paste, with token names kept.
- AC-4: Phase 3. A narrated walkthrough with video, audio, transcript cuts and captions is cut inside Diazo.
- AC-5: Phase 4. A 3D hero from Blender is also a shot in the film, through the desktop app only.
- AC-6: Phase 5. Server renders respect the caps (60 s, 1080p, 30 fps, one render per account at a time); HyperFrames projects import and export.
- AC-7: Phase 3. A person installs a transcription model in one click on their Mac (desktop app) or, as an instance admin, on the Diazo server; the files are checked against their SHA-256, and a 10-minute French clip comes back as timed words on either target (proposal 18.3, 18.7, 18.8).
- AC-8: Phase 3. A voice-over is generated from a script by ElevenLabs on the person's own key (cost shown before the run) or by an installed local engine, lands as an audio layer with its words, and a local job sends nothing to a third party (proposal 18.5, 18.6, 18.11).
- AC-9: Phase 3. The server's speech sidecar runs under its CPU and memory limits, and the canvas stays responsive while it transcribes (proposal 18.8).
