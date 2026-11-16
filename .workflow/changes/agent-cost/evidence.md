# Evidence

## Baseline measured while exploring

Recorded 2026-11-16 on `docs/agent-cost`, from `origin/dev` at `41cbb822`. These are sizes, not token counts or bills.

| Measure                       | Value                                                                    | How                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| MCP tools listed              | 89                                                                       | `client.listTools()` on `buildMcpServer` over an in-memory transport, run with `tsx`        |
| MCP tool definitions          | 102,238 characters                                                       | same call: `JSON.stringify` of name, description and input schema, summed                   |
| Largest definitions           | `create_component` 3,659, `update_component` 2,963, `upload_asset` 2,324 | same call                                                                                   |
| MCP server instructions       | 7,787 characters                                                         | `client.getInstructions()`                                                                  |
| Agent guide                   | 38,789 characters                                                        | `DOOP_GUIDE.length`                                                                         |
| Diazo Agent system prompt     | 19,510 characters                                                        | `systemFor(role).length`                                                                    |
| Diazo Agent tools             | 67                                                                       | `RESIDENT_TOOL_NAMES.length`                                                                |
| Diazo Agent cache breakpoints | 1                                                                        | read in `server/resident.ts`: `{ text: systemFor(role), cache: true }`, nothing on messages |

Not measured: tokens (no API credential here), and the cost of a real run (no model account; MCP clients' spend is not recorded by the server).

## Phase 0–1 backend verification

Recorded 2026-11-16 on `feat/agent-scripts`. All checks run locally; `bun run typecheck` exits 0, `bunx oxlint --type-aware --deny-warnings` and `bunx eslint . --max-warnings 0` are clean, `bunx prettier --check` passes on the changed files.

- AC-6, AC-11, AC-19, AC-20: `tests/scriptTools.test.ts` — five tools under `/mcp?profile=code` (under 12,000 characters of definitions), the default profile keeps every tool, `DOOP_AGENT_SCRIPTS=false` removes the execution tools, `get_sdk_docs` per namespace, and every MCP tool is mirrored in the SDK or excluded with a reason in `shared/scriptToolCoverage.ts`. `tests/agentToolParity.test.ts` passes with the four tools registered on both surfaces.
- AC-7, AC-8: `tests/scriptSandbox.test.ts` — no fetch / XMLHttpRequest / require / process / timers; `import()`, `eval` of host globals and `globalThis.constructor` escapes refused with zero requests leaving the host (spied `fetch`); prototype pollution does not cross; wall clock, memory, sdk_calls, script_size each end the run with the named limit; the next run works after a kill.
- AC-8, AC-12, AC-13, AC-14, AC-18: `tests/scriptRunner.test.ts` — audit row per run with calls and writes, one activity line, one-step undo (`revert_script_run`), automatic restore after a throw or a limit, serialized idempotent replays (`deduplicated`), dry-run on a cloned draft that leaves the store unchanged, result cap with `truncated` and full byte count, refusal when disabled and after access is revoked.
- AC-9, AC-10: `tests/scriptSdk.test.ts` — role gates per function, `AGENT_LIBRARY_WRITES=false` refuses writes (guideline writes are excluded from the SDK entirely), `query_script`'s SDK exposes no write path and the raw bridge refuses them.
- AC-16, AC-17, AC-26, AC-27: `tests/scriptChecks.test.ts` — `frames.stream` broadcasts section updates in order; `checks.review` aggregates lint, responsive and measure with no image; `checks.autofix` applies only the mechanical fixes and reports them (the rest of the markup is byte-identical modulo the managed token block); `checks.snapshot`/`diff` returns 0 for unchanged pixels.
- Migration: `tests/scriptRunsMigration.test.ts` — 0073 applied on PGlite, per-canvas idempotency unique index enforced.
- AC-22, AC-23, AC-24, AC-25 wiring: `tests/qualityRunner.test.ts` — 12 briefs × 3 repetitions × 2 tiers × 2 modes = 144 scored runs, blind pairs judged in both orders, a 24-pair human ballot written without mode labels; `tests/benchAgentCost.test.ts` — `gateVerdict` passes on equal medians and fails on a worse measure, missing measurements, new error-level findings or a short human sample.
- AC-30: `tests/duel.test.ts` — a `modes: ['script']` slot carries `mode` and the "Script mode." card prefix, and the card's view shows `checkScore` plus cost resolved through the script run's agent run.

Still open per the gate (needs real model runs, not stubbed): tasks 2b, 16, 20 and 24 — the benchmark rows, the dated report and the default flip stay unclaimed until measured. `bench:agent-quality` runs only against a caller-supplied driver.

Frontend follow-up recorded for the Usage-tab contract: `/api/canvases/:id/usage` and `get_usage` now also return `scriptRuns` (the `script_runs` records).
