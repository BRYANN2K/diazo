# 0010. Adopt the HyperFrames timing contract with a WAAPI and CSS runtime, without GSAP

One architecture decision for Diazo. Read by anyone, human or agent, about to change the motion runtime or motion markup.

## Status

Accepted, 2026-11-15.

## Context

HyperFrames (Apache-2.0) renders HTML to video deterministically and defines timing attributes, half-open visibility windows, determinism rules and safe zones. Its default runtime adapter is GSAP, whose licence is a risk for an animation editor.

## Decision

We adopt the HyperFrames contract where it costs nothing (timing attributes, `[start, end)` windows, determinism rules, one caption track, one kind per track, safe zones), not its code. Our runtime (`shared/motionRuntime.ts`) is small and uses WAAPI and CSS, with time also exposed as `--t`. GSAP is not bundled; `MO-*` lint flags it. A script layer may bring its own library if it listens to the seek event.

## Alternatives rejected

- Embed the HyperFrames runtime. Rejected: GSAP licence risk and a second runtime in every frame.
- A custom contract unrelated to HyperFrames. Rejected: export to and import from HyperFrames would be lost.

## Consequences

- Good: scrubbing, multiplayer and every renderer agree on the same pixels.
- Good: a composition can export as a HyperFrames project.
- Bad: library Motion items that use timers or GSAP need a seek-safe rewrite before they are clips.

## Links

[.workflow/changes/motion-studio/proposal.md](../../.workflow/changes/motion-studio/proposal.md), sections 7.1, 7.2 and 9.
