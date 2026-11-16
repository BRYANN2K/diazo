# Cheaper agent runs: script tools and server-side checks

## Intent

An agent does a multi-step canvas job in a handful of model turns, and the render is at least as good as today's and aims to be better. It sends one program that runs on the server against a typed SDK, the bulky data stays on the server, checks answer with numbers on every iteration, and the turns saved pay for more refinement and a final full-resolution review. Quality is a gate, not a trade-off. Full proposal: [proposal.md](proposal.md). Numbers: [cost-model.md](cost-model.md).

## Acceptance criteria

Measurement and free wins (phase 0):

- AC-1: Every MCP tool call and every Diazo Agent tool call is recorded with its tool name, canvas, actor, input size, result size, image pixels returned and duration; every editor of the canvas can read the records in the Usage tab and through `get_usage`.
- AC-2: `bun run bench:agent-cost` replays the three reference jobs (one landing page frame, ten frames restyled with tokens, a three-frame storyboard animated) against a stub model from recorded transcripts and prints, per job and per mode, the turns, the input, cached and output tokens, and the cost at the prices in `shared/modelPrices.ts`.
- AC-3: On a provider with explicit prompt caching, the second and later turns of a Diazo Agent run send a cache breakpoint on the last message, and a test against a stub Messages API shows the previous turn's messages counted as cache reads.
- AC-4: `set_composition` and the frame edit tools answer without the whole composition or a repeated frame summary; a test bounds each of these results at 600 characters, findings aside.
- AC-5: `get_frame_screenshot` takes `max_edge`, `region` and `frame_ids`; with none given, the image's long edge is at most 1,568 px; `frame_ids` returns one contact sheet.

Script tools (phases 1 and 2):

- AC-6: `query_script` and `run_script` exist on the MCP server and in the Diazo Agent under the same names and run the same runner; the tool-parity test covers them.
- AC-7: A script reaches nothing but the `diazo` object: tests show that `fetch`, `require`, `import()`, `process`, `globalThis.constructor` escapes, timers and the file system are absent or refused, and that no request leaves the server during such a run.
- AC-8: A run that passes its wall-clock, memory, SDK-call, frame-write, script-size or result-size limit ends with an error naming the limit, performs no further write, and leaves the server responsive; one test per limit.
- AC-9: Every SDK function applies the role gate of the tool it mirrors: a caller with a view role gets a refusal from each write function, a script cannot read or write a canvas other than the one its call names, and `AGENT_GUIDELINE_WRITES` and `AGENT_LIBRARY_WRITES` set to false refuse the matching writes.
- AC-10: `query_script` performs no write: its SDK has no write function, and a test shows the store and the database unchanged after a script that tries each one.
- AC-11: The SDK has no function that deletes a frame, page or component, changes sharing or approval, imports or views a web page, generates an image or reads a linked repo; a test lists every MCP tool as mirrored or excluded with its reason.
- AC-12: Each run writes one `script_runs` record with the script source and hash, actor, canvas, the SDK calls with target and duration, the writes, the outcome and the time taken; the canvas activity feed shows one line per run.
- AC-13: `revert_script_run` restores every frame, the tokens and the composition a run changed to their state before it, as one action; a run that throws or hits a limit is reverted without being asked.
- AC-14: A second `run_script` call with the same `idempotency_key` on the same canvas returns the first run's recorded result and writes nothing; `dry_run: true` returns the planned writes and check results and writes nothing.
- AC-15: On the benchmark of AC-22, script mode uses at most half of the model turns and at most a fifth of the input tokens of tool mode, per job kind. This cost criterion never overrides the quality gate of AC-24.
- AC-16: `frames.stream` appends a design in top-level sections through the canvas room: a viewer of the canvas receives at least one frame update per section, in order, before the run ends.
- AC-17: `checks.measure` returns, without an image, the overflow in px, the count of clipped text nodes, overlapping siblings, elements outside the frame, images that failed to load, font families that fell back and console errors; `checks.diff` returns the ratio of changed pixels against a snapshot and 0 for an unchanged frame; `compositions.stateAt` returns element boxes and opacity at the given times with no render.
- AC-18: A script's result is at most 8 KB unless the call raises the cap (32 KB at most); a larger result is cut, flagged `truncated` and carries its full size.
- AC-19: `/mcp?profile=code` lists at most six tools whose definitions total under 12,000 characters; `get_sdk_docs` returns one namespace's typings and examples; `get_guide` serves a core topic under 10,000 characters and the other sections by topic. The default profile still lists every existing tool.
- AC-20: With `DOOP_AGENT_SCRIPTS=false`, neither script tool is listed on the MCP server or offered to the Diazo Agent, and calls to them are refused.
- AC-21: The new tests pass, the existing suite still passes, and `docs/TECHSTACK.md`, `docs/FEATURES.md`, `docs/doop-reference.md` and the agent guide describe the script tools, their limits and when a screenshot is still asked for.

Quality gate and quality mechanisms:

- AC-22: A benchmark of 12 design briefs is versioned in the repository (four landing pages, four app screens, two token restyles of an existing frame set, two storyboards) with a runner that executes each brief three times per mode (tool mode as built today, script mode) on two model tiers and stores every resulting frame, its scores and its usage.
- AC-23: For every benchmark frame the runner records the anti-slop lint score and error count, the responsive and accessibility check score, contrast failures, overflow in px, clipped text count, images that failed to load, font families that fell back and token coverage; for storyboards it also records the `MO-*` findings.
- AC-24: Script mode becomes the default for a job kind only when, on that kind's briefs, its median is equal or better than tool mode's on every measure of AC-23, it has no error-level finding on a brief where tool mode has none, and it is preferred or tied in at least half of the pairs judged under AC-25. One measure below fails the gate for that kind. The dated report is recorded in `evidence.md`.
- AC-25: Pairwise visual judgment is blind: for each brief, pairs of final renders (one per mode) are judged by a vision model against a fixed rubric committed with the benchmark, each pair in both orders, and Bryan judges a blind sample of at least 24 pairs. Where the model and Bryan disagree on more than 30% of that sample, only Bryan's picks count for AC-24.
- AC-26: `checks.review(frame)` returns lint, responsive, layout, contrast, image, font and token-coverage findings in one result with no image, and names markup that redraws an existing component; every `run_script` call that changes a frame's HTML returns this review for that frame without being asked.
- AC-27: `checks.autofix(frame, kinds)` applies only mechanical fixes (a contrast failure moved to the nearest passing token, a tap target grown to 44 px, a literal value replaced by the token of the same value), reports each change, and changes nothing else; a test shows the rest of the frame's markup byte-identical.
- AC-28: In script mode the Diazo Agent runs up to three refinement rounds, each given the full review, and does not finish while an error-level finding remains unless the three rounds are spent, in which case its closing message names what is left; it then takes one full-resolution screenshot of each frame it created or reworked before finishing.
- AC-29: `canvas.summary()` returns the canvas tokens, its components and the library items matching the brief's terms, and the script guide tells agents to use them before writing new markup; on the benchmark, script mode's token coverage and component reuse are not below tool mode's.
- AC-30: A duel slot can run in script mode, the comparison card shows each take's lint score, check score and cost, and the person picks the take to keep.
