# Tasks — cheaper agent runs

Phases 0–1 backend built on `feat/agent-scripts` (script mode stays opt-in until the gate passes).
Bryan approved the `quickjs-emscripten` dependency and the `script_runs` migration on 2026-11-16. The spec as strengthened with the quality gate still needs his approval (`stip-validate`).

## Phase 0: measure, then the free wins

- [x] 1. Record every tool call (MCP in `server/toolLoads.ts`'s wrapper, Diazo Agent in `execTool`): name, canvas, actor, sizes, image pixels, duration. Shown to editors in the Usage tab and through `get_usage`. (AC-1)
- [x] 2. Write the 12 benchmark briefs and the judging rubric — `bench/briefs.json` (4 landing, 4 app screens, 2 token restyles, 2 storyboards) and `bench/rubric.ts`, **Bryan's review still due**. Build the runner that scores every frame — `bench/qualityRunner.ts` behind `bun run bench:agent-quality`. (AC-22, AC-23, AC-25)
- [ ] 2b. Run the benchmark in tool mode on two model tiers: the quality and cost baseline. Keep transcripts of the three reference jobs as fixtures (`bench/transcripts/` exist), and replace the assumed turn counts in `cost-model.md` with them.
- [x] 3. `scripts/bench-agent-cost.ts` and the `bench:agent-cost` script: replay the fixtures against a stub model, print turns, tokens and cost. (AC-2)
- [x] 4. Conversation caching in `runAnthropicTurn`: a breakpoint that follows the last message, kept within four breakpoints. Check `cache_read_input_tokens` on a real run. (AC-3)
- [x] 5. Trim results: `set_composition`, the edit tools, the review nudge sent once per frame. (AC-4)
- [x] 6. `get_frame_screenshot`: `max_edge`, `region`, `frame_ids`; the Diazo Agent's `screenshot_frame` follows. (AC-5)

## Phase 1: the MVP

- [x] 7. Spike: `quickjs-emscripten` in a worker thread on Node 22: `server/scriptSandbox.ts` + `server/scriptWorker.ts`, killed runs leave the server usable (tests cover wall clock and a run after a kill).
- [x] 8. `server/scriptSandbox.ts`: fresh context per run, host-resolved promises for SDK calls, memory limit, interrupt handler for the deadline, no host objects. (AC-7, AC-8)
- [x] 9. `shared/scriptSdk.d.ts` and `server/scriptSdk.ts` for `canvas`, `frames`, `tokens`, `checks`, each function calling the existing action behind its role gate. (AC-9, AC-10, AC-11)
- [x] 10. `frames.outline`, `frames.styles`, `frames.edit` (batched, by source offset — `server/scriptDom.ts` splices source so untouched markup stays byte-identical), `frames.replaceValues`, `frames.stream`. (AC-16)
- [x] 11. `checks.measure` on the existing check page in `server/frameChecks.ts`. (AC-17)
- [x] 12. Migration 0084 and `server/scriptRuns.ts`: the run record, the activity line, write tagging, `revert_script_run` (`restoreScriptState` in `server/actions.ts`), automatic revert on failure. (AC-12, AC-13)
- [x] 13. `server/scriptRunner.ts`: limits, idempotency key, dry run (a cloned draft canvas), result cap, `DOOP_AGENT_SCRIPTS`. (AC-8, AC-14, AC-18, AC-20)
- [x] 14. Register `query_script`, `run_script`, `get_sdk_docs`, `revert_script_run` on the MCP server and in the Diazo Agent; parity test covers them dynamically (`scriptTools.test.ts` also lists every MCP tool as mirrored or excluded in `shared/scriptToolCoverage.ts`). (AC-6, AC-11)
- [x] 15. Guide section "Scripts" (`SCRIPT_GUIDE` + `guideTopic` in `server/guide.ts`) and the Diazo Agent's rule for when to look at a render (full-resolution review per delivered frame).
- [x] 15b. `checks.review` returned with every frame write (lint, responsive, measure, contrast, images, fonts, token coverage, redrawn components); `checks.autofix` for the mechanical fixes. (AC-26, AC-27)
- [x] 15c. Diazo Agent in script mode: three refinement rounds on the full review, then one full-resolution screenshot per delivered frame. (AC-28)
- [ ] 16. Run the restyle briefs in script mode; compare cost and every quality measure with the baseline. (AC-15, AC-24)

## Phase 2: the rest of the SDK

- [x] 17. SDK for `components`, `libraries`, `compositions`, `search`. (AC-9, AC-11)
- [x] 18. `checks.snapshot` and `checks.diff` with `sharp`; `compositions.stateAt`. (AC-17)
- [x] 19. Code profile on `/mcp?profile=code`; guide topics. (AC-19)
- [x] 19b. `canvas.summary()` with matching library items; token coverage and redrawn components in the review. (AC-29)
- [ ] 20. Run the landing page, app screen and storyboard briefs in script mode; compare cost and every quality measure. (AC-15, AC-24)
- [x] 21. Docs: `docs/TECHSTACK.md`, `docs/FEATURES.md`, `docs/doop-reference.md`, `CHANGELOG.md`. (AC-21)

## Phase 3: after the numbers

- [ ] 22. Diazo Agent: append frame sections while the script's input streams from the model.
- [x] 23. Script mode as a duel entry (`modes` on `startDuel`, "Script mode." card prefix arms the tools), with each take's lint score, check score and cost on the card. (AC-30)
- [ ] 24. The gate run: blind pairs judged by the vision model and by Bryan's sample; the dated report in `evidence.md`. Script mode becomes the default only for the job kinds that pass. (AC-24, AC-25)
