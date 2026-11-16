# Tasks — cheaper agent runs

Nothing is built. Bryan approved the `quickjs-emscripten` dependency and the `script_runs` migration on 2026-11-16. The spec as strengthened with the quality gate still needs his approval (`stip-validate`).

## Phase 0: measure, then the free wins

- [ ] 1. Record every tool call (MCP in `server/toolLoads.ts`'s wrapper, Diazo Agent in `execTool`): name, canvas, actor, sizes, image pixels, duration. Shown to editors in the Usage tab and through `get_usage`. (AC-1)
- [ ] 2. Write the 12 benchmark briefs and the judging rubric; Bryan reviews both. Build the runner that scores every frame. (AC-22, AC-23, AC-25)
- [ ] 2b. Run the benchmark in tool mode on two model tiers: the quality and cost baseline. Keep transcripts of the three reference jobs as fixtures, and replace the assumed turn counts in `cost-model.md` with them.
- [ ] 3. `scripts/bench-agent-cost.ts` and the `bench:agent-cost` script: replay the fixtures against a stub model, print turns, tokens and cost. (AC-2)
- [ ] 4. Conversation caching in `runAnthropicTurn`: a breakpoint that follows the last message, kept within four breakpoints. Check `cache_read_input_tokens` on a real run. (AC-3)
- [ ] 5. Trim results: `set_composition`, the edit tools, the review nudge sent once per frame. (AC-4)
- [ ] 6. `get_frame_screenshot`: `max_edge`, `region`, `frame_ids`; the Diazo Agent's `screenshot_frame` follows. (AC-5)

## Phase 1: the MVP

- [ ] 7. Spike: `quickjs-emscripten` in a worker thread on Node 22. Measure cold start, memory, and a 200-call script. Stop and report if a run cannot be killed on time.
- [ ] 8. `server/scriptSandbox.ts`: fresh context per run, host-resolved promises for SDK calls, memory limit, interrupt handler for the deadline, no host objects. (AC-7, AC-8)
- [ ] 9. `shared/scriptSdk.d.ts` and `server/scriptSdk.ts` for `canvas`, `frames`, `tokens`, `checks`, each function calling the existing action behind its role gate. (AC-9, AC-10, AC-11)
- [ ] 10. `frames.outline`, `frames.styles`, `frames.edit` (batched, by source offset), `frames.replaceValues`, `frames.stream`. (AC-16)
- [ ] 11. `checks.measure` on the existing check page in `server/frameChecks.ts`. (AC-17)
- [ ] 12. Migration and `server/scriptRuns.ts`: the run record, the activity line, write tagging, `revert_script_run` on the run rollback, automatic revert on failure. (AC-12, AC-13)
- [ ] 13. `server/scriptRunner.ts`: limits, idempotency key, dry run, result cap, `DOOP_AGENT_SCRIPTS`. (AC-8, AC-14, AC-18, AC-20)
- [ ] 14. Register `query_script`, `run_script`, `get_sdk_docs`, `revert_script_run` on the MCP server and in the Diazo Agent; extend the parity test. (AC-6)
- [ ] 15. Guide section "Scripts" and the Diazo Agent's rule for when to look at a render.
- [ ] 15b. `checks.review` returned with every frame write; `checks.autofix` for the mechanical fixes. (AC-26, AC-27)
- [ ] 15c. Diazo Agent in script mode: three refinement rounds on the full review, then one full-resolution screenshot per delivered frame. (AC-28)
- [ ] 16. Run the restyle briefs in script mode; compare cost and every quality measure with the baseline. (AC-15, AC-24)

## Phase 2: the rest of the SDK

- [ ] 17. SDK for `components`, `libraries`, `compositions`, `search`. (AC-9, AC-11)
- [ ] 18. `checks.snapshot` and `checks.diff` with `sharp`; `compositions.stateAt`. (AC-17)
- [ ] 19. Code profile on `/mcp?profile=code`; guide topics. (AC-19)
- [ ] 19b. `canvas.summary()` with matching library items; token coverage and redrawn components in the review. (AC-29)
- [ ] 20. Run the landing page, app screen and storyboard briefs in script mode; compare cost and every quality measure. (AC-15, AC-24)
- [ ] 21. Docs: `docs/TECHSTACK.md`, `docs/FEATURES.md`, `docs/doop-reference.md`, `CHANGELOG.md`. (AC-21)

## Phase 3: after the numbers

- [ ] 22. Diazo Agent: append frame sections while the script's input streams from the model.
- [ ] 23. Script mode as a duel entry, with each take's scores and cost on the card. (AC-30)
- [ ] 24. The gate run: blind pairs judged by the vision model and by Bryan's sample; the dated report in `evidence.md`. Script mode becomes the default only for the job kinds that pass. (AC-24, AC-25)
