# Cheaper agent runs: script tools and server-side checks

Status: **proposal**, not built. Bryan decided its open questions on 2026-11-16 (see Decisions). Numbers are in [cost-model.md](cost-model.md); the sandbox decision is [ADR 0015](../../../docs/adr/0015-run-agent-scripts-in-a-quickjs-wasm-sandbox.md) (Accepted).

**Quality comes first.** Bryan's rule for this change: "La qualité doit être au rendez-vous. Le but c'est même d'avoir un meilleur rendu." Cheaper runs must not lower design quality, and the aim is a better render than today. Quality is a gate, not a trade-off: script mode becomes a default only when it is equal or better on every measure (spec AC-22 to AC-25).

## Problem

Designing a frame, restyling a set of frames or animating a storyboard costs too much and takes too long.

- An agent works one tool call at a time, and every call is a model turn.
- Every result goes back into the conversation and is read again on each later turn: frame HTML, canvas JSON, the whole composition, screenshots as images.
- So input tokens grow with the square of the turn count. Restyling 10 frames processes about 5 million input tokens over 52 turns for about 17,000 tokens of actual output.

Today, by the model in [cost-model.md](cost-model.md) (sizes measured, turn counts assumed):

| Job                              | Turns | Input processed | Medium tier, cached client | Medium tier, no cache |
| -------------------------------- | ----- | --------------- | -------------------------- | --------------------- |
| A. Design one landing page frame | 24    | 1.2 M           | $0.41                      | $2.52                 |
| B. Restyle 10 frames with tokens | 52    | 5.1 M           | $1.06                      | $10.39                |
| C. Animate a 3-frame storyboard  | 27    | 2.0 M           | $0.56                      | $4.04                 |
| A, on the Diazo Agent as it runs | 13    | 0.4 M           | $0.55                      | –                     |

The large tier costs twice that. The Diazo Agent's default server model costs 2.5 times that.

## The idea, and what the prior art really shows

Bryan's idea: take the approach of unharnessed.dev. The agent makes one call that runs a script instead of many tool calls.

What was read (2026-11-16):

- **unharnessed.dev** is a coding-agent harness (VS Code extension and CLI, MIT). Its one tool is a persistent Python session on the user's own machine. It has no sandbox and no approval step, and says so: "run it in a container". Tool schemas are found by search, results stay in variables, and one script replaces several round trips.
- Its own published run, same model as the comparison: 91 turns and $12.19 per task against 98 turns and $14.30. That is about 15% cheaper on coding tasks. Its headline chart is labelled placeholder data. The "200 calls → 1" figures are illustrations.
- **Code execution with MCP** (Anthropic, 2025-11): tools presented as code modules read on demand, intermediate results kept in the sandbox. Its 150,000 → 2,000 token figure is an illustration, and it names the cost: a secure sandbox to run.
- **Code Mode** (Cloudflare, 2025-09 and 2026-02): an MCP server that exposes two tools, `search` and `execute`, over a typed API, with code run in a V8 isolate that has no network. It reports 2,500 endpoints in about 1,000 tokens. It needs nothing from the client.
- **Programmatic tool calling** (Claude API): the model's code runs in the provider's container and calls client tools; only the final output enters context. It reports 20 to 40% fewer input tokens. It does not work for tools reached over MCP, and it is one provider's feature.
- **Client-side changes already in the field**: some coding agents now defer MCP tool definitions until used and cap a tool result at 25,000 tokens. The fixed prefix matters less there; the loop still compounds.

Conclusions:

- **The idea transfers, the Python session does not.** A server cannot run model-written code with a user's permissions. The right shape for a server is Code Mode: a small typed API, a real sandbox, compact results.
- **The saving comes from fewer turns and from data that never enters the context**, not from the script language.
- **Expect an order of magnitude on input tokens and turns, less on the bill.** With a caching client, dollars fall 2.5× on job A, 12× on job B, 4× on job C. The HTML of a new design must still be written by the model; that is the floor.
- **Part of the saving is spent on quality.** With two more refinement rounds and a full-resolution review, the same jobs take 9 turns and the bill falls 2×, 8.5× and 3.4×.

## Scope

In:

1. Measurement: a per-call ledger for MCP and Diazo Agent tool calls, and a replayable benchmark of the three jobs.
2. Free wins that need no new tool: conversation caching in the Diazo Agent, smaller results, smaller default screenshots, a slim guide.
3. Two script tools, `query_script` (read-only) and `run_script` (writes), on the MCP server and in the Diazo Agent, running one TypeScript program against a typed SDK in a sandbox.
4. Server-side checks that return numbers, so a script can verify its own work without an image.
5. A code profile of the MCP server: five tools instead of 89, with SDK typings loaded by namespace.
6. A quality benchmark and gate, and the mechanisms that spend the saved budget on a better render.

Out:

- Removing or renaming any existing tool. The 89 tools stay; script tools are added beside them.
- Python scripts (see Options).
- Network access from a script, in any form.
- Server-side video renders (Motion Studio phase 5).
- Token-level streaming of a frame while an external MCP client is still writing its script. The protocol sends a call whole.

## Design

### Two tools, one runner

- `query_script({ canvas_id, script, agent_name })`: the SDK's read functions only. Annotated read-only, so a client can let it run without asking.
- `run_script({ canvas_id, script, idempotency_key?, dry_run?, agent_name })`: reads and writes. Annotated destructive.
- Both run `server/scriptRunner.ts` and answer with the script's `return` value as JSON plus a short run record: `{ run_id, ok, result, writes, checks, ms, truncated }`.
- The Diazo Agent gets the same two tools under the same names, through the same runner, as the tool-parity test requires.

### The SDK

One global, `diazo`. Every function is awaited. Typings live in `shared/scriptSdk.d.ts` and are the documentation.

| Namespace      | Reads                                                                     | Writes                                                              |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `canvas`       | `summary()`: pages, frames (id, name, box), tokens, components, fonts     | `status(text)`                                                      |
| `frames`       | `list`, `outline`, `html`, `find`, `styles` (inventory of literal values) | `create`, `stream`, `edit` (batched ops), `replaceValues`, `update` |
| `checks`       | `lint`, `responsive`, `measure`, `snapshot`, `diff`                       | –                                                                   |
| `tokens`       | `get`                                                                     | `create`, `set`, `themes`                                           |
| `components`   | `list`, `get`                                                             | `create`, `update`, `insert`                                        |
| `libraries`    | `search`, `item`, `check`                                                 | `insert`                                                            |
| `compositions` | `get`, `stateAt(times)`, `lint`                                           | `storyboard`, `patch(ops)`, `render`                                |
| `search`       | `images`, `icons`, `logos` as text facts (URL, size, alt, main colour)    | –                                                                   |

- Every function calls the same code the tools call today (`server/actions.ts`, `server/pageTools.ts`, `server/componentTools.ts`, `server/libraryTools.ts`, `server/motionTools.ts`, `server/frameChecks.ts`, `server/lint.ts`). The SDK adds no second path to the store.
- `frames.outline(id)` returns the element tree with ids, names, boxes and short text, about 400 tokens for a screen, in place of 5,500 tokens of HTML.
- `frames.edit(id, ops)` takes a batch: exact replace, set a style or attribute by `data-doop-id`, set text, insert or remove an element. The server applies it by source offset, as element ids are stamped today, so nothing else is re-serialized. One batch is one frame write and one version.
- Results stay in script variables. Only what the script returns reaches the model, capped at 8 KB by default.

A job B script, as an agent would write it:

```ts
const tokens = await diazo.tokens.get()
const report = []
for (const frame of await diazo.frames.list({ page: 'Checkout' })) {
  const before = await diazo.checks.snapshot(frame.id)
  const mapped = await diazo.frames.replaceValues(frame.id, {
    kinds: ['color', 'radius'],
    to: tokens,
    match: 'nearest',
  })
  const diff = await diazo.checks.diff(frame.id, before)
  const checks = await diazo.checks.measure(frame.id)
  report.push({
    frame: frame.name,
    replaced: mapped.count,
    unmapped: mapped.unmapped,
    changed: diff.ratio,
    issues: checks.issues,
  })
}
return report
```

### Checks instead of screenshots

Two checks exist and return numbers: `lint_frame` (anti-slop score and `AS-*` findings) and `check_frame` (overflow, clipped text, tap targets, contrast, focus, at three widths). The change adds:

- `checks.measure(frame)`: per-section boxes, overflow in px, clipped text count, overlapping siblings, elements outside the frame, images that failed to load, font families that fell back, console errors, document height against frame height.
- `checks.diff(frame, snapshot)`: ratio of changed pixels and the changed regions, computed with `sharp`, which is already a dependency. A token swap that should change nothing reports 0.
- `compositions.stateAt(times)`: element boxes and opacity at given times from `shared/motionRuntime.ts`, with title-safe and overlap findings. No render.

When an image is still worth its tokens:

- **Once per originated or reworked frame, at the end and at full resolution**, to judge hierarchy, balance and imagery. Numbers do not measure taste.
- **When a check reports something the numbers do not explain.**
- **One contact sheet for a film**, six times on one image.
- **Never to confirm a mechanical edit.**

`get_frame_screenshot` gains `max_edge` (default 1,568 px, about 1,500 tokens for a tall page instead of 4,784; the final review asks for full resolution), `region`, and `frame_ids` for a contact sheet. The Diazo Agent's rule "screenshot every changed frame" becomes "checks pass, then one full-resolution review of each frame it delivers".

### Quality: the gate and the budget

The gate is measured on a fixed benchmark, in both modes, before any default changes.

- **Benchmark**: 12 design briefs kept in the repository: four landing pages, four app screens, two token restyles of an existing frame set, two storyboards. Each brief runs three times per mode on two model tiers.
- **Automatic measures, per frame**: anti-slop lint score and error count, responsive and accessibility check score, contrast failures, overflow in px and clipped text, images that failed to load, fonts that fell back, token coverage, and for storyboards the `MO-*` findings.
- **Pairwise visual judgment**: each brief gives blind pairs, one render per mode. A vision model judges every pair against a fixed rubric, in both orders. Bryan judges a blind sample of at least 24 pairs. Where the two disagree on more than 30% of the sample, only Bryan's picks count.
- **The gate**: script mode is equal or better than tool mode on every automatic measure, and preferred or tied in at least half of the judged pairs. One measure below is a no.
- **The aim**: preferred in 60% of pairs. The gate is the floor; the aim is why the change exists.

What makes the render better, paid for by the turns saved:

- **Complete numeric feedback on every iteration.** Every script that changes a frame gets back `checks.review(frame)`: lint, responsive, layout, contrast, images, fonts and token coverage in one result of about 400 tokens. Today an agent gets a lint result and an image to read by eye.
- **More refinement rounds.** A run has a budget of three fix rounds, each fed the full findings, until no error is left. Today the Diazo Agent sends one nudge per kind and stops.
- **Fixes inside the run.** `checks.autofix(frame, kinds)` applies the mechanical ones on the server: the nearest token that passes contrast, a tap target grown to 44 px, a literal swapped for its token. It reports what it changed. Design decisions stay with the model, which cannot see a check result until the script returns.
- **A final review at full resolution.** Each originated or reworked frame ends with one full-resolution screenshot, and region crops where a finding points. The look is kept and moved to the end, where it judges the finished design.
- **Library, components and tokens by default.** `canvas.summary()` lists the tokens, the components and the library items that match the brief. The review reports token coverage and markup that redraws an existing component, so reuse is measured, not hoped for.
- **Duels in script mode.** A duel slot can run in script mode. Two takes then cost about what one run costs today, so comparing takes and keeping the best becomes affordable. The person picks, with each take's scores beside it.

### Keeping the canvas live

- `frames.stream(id, html)` splits the HTML into top-level sections and appends them through `actions.appendFrameHtml` with a short pace, so viewers still watch the design build.
- A running script shows as the agent's status, and each write lands in the activity feed as it does today.
- **For an external MCP client** the canvas stays still while the model writes its script, then the build plays section by section. Today the build is spread over eight turns. Bryan accepted this.
- **For the Diazo Agent the build gets more live**, in a later step: the run loop reads the tool input as it streams from the model and appends sections as they arrive.

### Safety

A script is untrusted. Canvas content, an imported page or a comment can carry an injected instruction.

- **Sandbox**: QuickJS compiled to WebAssembly, in a worker thread, one fresh context per run ([ADR 0015](../../../docs/adr/0015-run-agent-scripts-in-a-quickjs-wasm-sandbox.md)). The context has no `fetch`, no file system, no `process`, no `require`, no timers. Its only capability is the `diazo` object.
- **Permissions**: the SDK is bound to the caller and to the one canvas the call names. Each function goes through the same `canvasRole` gate as its tool. `AGENT_GUIDELINE_WRITES` and `AGENT_LIBRARY_WRITES` apply unchanged.
- **Not in the SDK**: deleting frames, pages or components, sharing, approvals, `import_webpage`, `view_website`, `generate_image` (it spends money), repo tools. They keep their own tools and their own confirmations.
- **Limits**: 30 s wall clock (60 s maximum), 64 MB, 200 SDK calls, 40 frame writes, 256 KB of script, 8 KB of result. A limit ends the run with a named error. Renders go through the existing render gate at background priority.
- **Audit**: a `script_runs` row per run: source, hash, actor, canvas, each SDK call with its target and duration, writes, outcome. It shows in the activity feed and the Usage tab, like an agent run.
- **Undo as one step**: every write is tagged with the run id, as Diazo Agent runs tag theirs. `revert_script_run` restores each touched frame, the tokens and the composition through the existing run rollback. A run that fails or hits a limit reverts itself.
- **Idempotency**: a repeated `idempotency_key` returns the recorded result and runs nothing. MCP clients retry after a timeout.
- **Dry run**: `dry_run: true` runs against a copy and returns the planned writes and check results.
- **Switch**: `DOOP_AGENT_SCRIPTS=false` removes both tools.

### Progressive disclosure

- **Code profile**: `/mcp?profile=code` lists five tools: `get_guide`, `get_sdk_docs`, `query_script`, `run_script`, `get_frame_screenshot`. About 3,000 tokens of fixed prefix instead of 27,500.
- `get_sdk_docs({ namespace })` returns that namespace's typings and two examples, about 1,800 tokens.
- `get_guide` gains topics: a 2,500-token core, then `components`, `prototypes`, `libraries`, `motion`, `scripts` on demand. The single 9,700-token text stays available under its current topic.
- The default profile keeps all tools and adds the script tools and `get_sdk_docs`.

### Free wins, before any new tool

- **Cache the Diazo Agent's conversation.** Add a cache breakpoint that follows the last message. Estimated effect on job A: −53%.
- **Stop echoing.** `set_composition` returns the revision and a summary, not the whole composition. An edit returns `{ ok, htmlBytes }`, not a frame summary and a review nudge each time.
- **Smaller default screenshots**, as above.
- **Order tool lists deterministically**, so a client's cache survives between sessions.

## Options compared

| Option                                                 | For                                                                                                        | Against                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript in QuickJS (WebAssembly), in the server** | No native build, no new service, works on every install; real memory and time limits; no ambient authority | An interpreter, slow for heavy loops (the work is in SDK calls); the package is not audited; a new dependency                 |
| TypeScript in a V8 isolate (`isolated-vm`)             | Fast, same engine as Node                                                                                  | Native addon, in maintenance mode, its own README advises a separate process; Node 22 needs an older major                    |
| Python in Pyodide                                      | The language the idea came from                                                                            | 14 MB, not a sandbox inside Node (advisories in 2025 and 2026 against products that assumed so), needs its own process anyway |
| A sidecar container (Deno or Python)                   | Strongest isolation                                                                                        | A second service for Docker, k3s and the one-container Mac install; breaks the zero-setup dev run                             |
| The provider's programmatic tool calling               | No sandbox to run                                                                                          | One provider only, not available to MCP clients, each call still a round trip to the server                                   |
| No scripts: only batch tools and the free wins         | Smallest change                                                                                            | Each new job shape needs a new batch tool; reads still enter the context                                                      |

**Picked: TypeScript in QuickJS.** Frames are HTML, CSS and JavaScript, the SDK types already exist in `shared/`, and models write TypeScript as well as Python. Types are stripped with `esbuild`, already a dependency.

## Phases

| Phase   | Scope                                                                                                                  | Done when                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0       | Ledger and benchmark; conversation caching; smaller results and screenshots                                            | The three jobs have recorded baselines, and job A on the Diazo Agent costs at least 40% less |
| 1 (MVP) | `query_script`, `run_script`, the sandbox, SDK for `canvas`, `frames`, `tokens`, `checks`; audit, undo, limits; parity | Job B runs in at most 10 turns, reverts in one action, and passes the quality gate           |
| 2       | SDK for `components`, `libraries`, `compositions`, `search`; `diff` and contact sheets; code profile; guide topics     | Jobs A and C meet the cost threshold of spec AC-15                                           |
| 3       | Live streaming of script input in the Diazo Agent; script mode as a duel entry; the gate run and the default           | The gate report is recorded, and script mode is the default where it passed                  |

## Risks

- **Design quality may drop** when the agent looks less. This is the risk the gate exists for: script mode is not a default until the benchmark shows it equal or better on every measure, and the final full-resolution review stays.
- **The judge may be wrong.** A vision model's preference is noisy. Mitigation: both orders per pair, a fixed rubric, and Bryan's blind sample overrides it when they disagree.
- **A sandbox escape.** QuickJS has had memory-safety bugs. Mitigation: the WebAssembly boundary, a context with no host objects, role gates on every SDK call, no destructive functions. A script that escapes reaches a worker thread, not the SDK's authority.
- **One approval covers many writes.** A client that approved `run_script` once no longer sees each edit. Mitigation: read and write are separate tools, the audit row, one-step undo, dry run.
- **Client timeouts.** Many MCP clients stop waiting after 60 s. Mitigation: the 30 s default, progress notifications, the idempotency key.
- **Models write wrong scripts.** A failed script costs a turn. Mitigation: typed SDK, errors that name the function and the fix, automatic revert.
- **Two surfaces to keep in step.** Mitigation: the SDK calls the tools' own functions, and a test lists every tool as covered or deliberately excluded.

## Decisions

Decided by Bryan on 2026-11-16:

1. Scripts are TypeScript, not Python.
2. The `quickjs-emscripten` dependency and the `script_runs` migration are approved.
3. Script mode becomes the Diazo Agent's default after measurement, job kind by job kind, once the quality gate passes.
4. For an external MCP client, the canvas may stay still while the script is written; the build is then replayed section by section.
5. Deletes stay out of scripts.
6. The per-call ledger is visible to every editor of the canvas, in the Usage tab.
7. Quality is a hard gate, and the aim is a better render than today.

## Open questions

- The 12 briefs and the judging rubric: Bryan reviews them before the first benchmark run.
- Which two model tiers the benchmark runs on.
- Whether a run that spends its three refinement rounds with an error left is marked failed or delivered with a warning.
