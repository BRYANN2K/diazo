# Motion Studio backend, phases 0 and 1

## Intent

A page can carry a seekable, deterministic timeline that people, agents and renderers read and write through one contract.

## Acceptance criteria

- AC-1: A page has at most one composition (duration, fps, output size, poster time, tracks of kind camera, element, clip, audio and caption), validated by `shared/motion.ts`; invalid bodies are refused with the reason.
- AC-2: `GET` and `PUT /api/canvases/:id/pages/:pageId/composition` read and write it behind the canvas view and edit gates; a write with a stale `revision` gets 409.
- AC-3: `shared/motionRuntime.ts` returns the same frame state for the same composition and time, with no wall clock; clip windows are half-open `[start, end)` and element tracks override frame-authored motion.
- AC-4: `shared/motionLint.ts` reports `MO-*` findings for wall clocks, free-running loops, unseeded random, CSS animations without a scene length, GSAP, network at seek time and autoplaying media.
- AC-5: Compositions persist (migration 0071) with at most 20 versions, are copied when their page or canvas is duplicated, and are deleted with their page.
- AC-6: The canvas room broadcasts `composition`, `composition:playhead` and `render:progress` to the people on that canvas.
- AC-7: A render job is a claimable record; an uploaded result is accepted only when it sniffs as MP4 or WebM and lands as an `/a/` asset.
- AC-8: MCP and the resident agent both offer `get_composition`, `set_composition` (whole body or ops), `animate_storyboard`, `lint_motion` and `render_composition`, and the agent guide documents them.
- AC-9: The desktop shell renders a composition deterministically behind `__DOOP_MOTION_RENDER__`: a hidden webview seeks frame by frame and an allowlisted local `ffmpeg` encodes.
- AC-10: The Blender bridge is off unless `DOOP_BLENDER_BRIDGE` is set, spawns only an allowlisted `blender-mcp`, and relays a read-only tool set.
- AC-11: `tests/motion.test.ts`, `tests/motionHttp.test.ts` and the Rust `motion::tests` and `blender::tests` pass, and the existing suite still passes.
