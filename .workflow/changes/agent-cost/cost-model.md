# Cost model: what an agent job costs today, and with script tools

Back-of-envelope model for the change [proposal.md](proposal.md). Read by anyone who wants to check or redo the numbers.

Status: draft, updated 2026-11-16

## What is measured and what is assumed

| Figure                                           | Value                              | Source                                                                                                              |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MCP tools registered                             | 89                                 | measured: `tools/list` on `buildMcpServer` at `41cbb822`                                                            |
| MCP tool definitions (name, description, schema) | 102,238 characters                 | measured, same call                                                                                                 |
| MCP server instructions                          | 7,787 characters                   | measured, same call                                                                                                 |
| Agent guide (`get_guide`, one topic, whole text) | 38,789 characters                  | measured: `DOOP_GUIDE` in `server/guide.ts`                                                                         |
| Diazo Agent system prompt                        | 19,510 characters                  | measured: `systemFor` in `server/resident.ts`                                                                       |
| Diazo Agent tool list                            | 67 tools, about 35,600 characters  | measured: `RESIDENT_TOOL_NAMES`, and the source of `TOOLS`                                                          |
| Diazo Agent turn cap                             | 24 turns (40 for a redesign)       | read: `MAX_TURNS`, `MAX_REDESIGN_TURNS`                                                                             |
| Diazo Agent prompt caching                       | tools and first system block only  | read: one `cache: true` block in the run loop; the conversation carries no breakpoint                               |
| Tokens per character                             | 1 token per 4 characters           | assumed; no API credential was available to count tokens exactly                                                    |
| Tokens per screenshot                            | `⌈w/28⌉ × ⌈h/28⌉`, capped at 4,784 | provider documentation, read 2026-11-16; a tall landing frame hits the cap, a 1920×1080 frame costs 2,691           |
| Frame HTML size                                  | 22 to 26 KB per screen             | assumed                                                                                                             |
| Turn sequences below                             | see each job                       | assumed from the guide's own workflow: one call per turn, screenshot after every create and every significant edit  |
| Prices                                           | see the next table                 | provider price pages, read 2026-11-16; the Anthropic rows match `shared/modelPrices.ts`                             |
| Measured cost of a real run                      | none                               | `agent_runs` meters only Diazo Agent runs, and no model account was available here. An MCP client's spend is unseen |

So: sizes are measured, token counts are estimates from sizes, turn counts are assumptions. Task 1 of the change replaces the assumptions with a recorded benchmark.

## Prices used

USD per million tokens, 2026-11-16.

| Tier   | Example model       | Input | Cache read | Cache write | Output |
| ------ | ------------------- | ----- | ---------- | ----------- | ------ |
| Large  | `claude-opus-5-5`   | 4.00  | 0.20       | 5.00        | 20.00  |
| Medium | `claude-sonnet-5-5` | 2.00  | 0.10       | 2.50        | 10.00  |
| Small  | `claude-haiku-5-5`  | 0.10  | 0.01       | 0.125       | 0.50   |

- The medium tier's prices are also those listed for `gpt-6.1-sol`, and the small tier's those of `gpt-6-luna` (not re-checked on a second source).
- The Diazo Agent's server tier defaults to `claude-opus-5` (`DOOP_AGENT_MODEL`), at 5 and 25: add 25% to the large column for it.
- On a subscription (a coding agent's plan, a local CLI) there is no bill per job. The same tokens count against the plan's rate limit instead.

## How a loop is billed

A job is a loop of model turns. Turn `i` sends the fixed prefix `P` (tool definitions, instructions, system prompt) plus the whole history `H(i)` (every earlier tool call, tool result and image).

- Input tokens processed over a job: `Σ (P + H(i))`. It grows with the **square** of the turn count, because each result is read again on every later turn.
- **With full prompt caching** (most coding agents): each token is written to the cache once at 1.25×, then read at 0.05× to 0.1× on every later turn.
- **Without caching**, or after the 5-minute cache lifetime lapses between turns: every token is billed at the input price on every turn.
- **The Diazo Agent today**: the prefix is cached, the history is billed in full on every turn.

## The three jobs today

Fixed prefix for an MCP client that loads every tool: 27,500 tokens (definitions plus instructions). A client that defers tool definitions until used pays about 6,000.

### Job A: design one landing page frame

24 turns: guide, canvas, status, three searches (inspiration, images, logos), `create_frame`, eight `append_frame_html` chunks, a screenshot, three edits, a screenshot, `check_frame`, an edit, a screenshot, the closing message.

- History at the end: 42,000 tokens. Largest parts: the guide (9,700), three screenshots (14,400), the HTML the model wrote (6,800), search thumbnails (3,600).
- Input processed: 1.2 million tokens. Output: 13,000.

### Job B: restyle 10 frames with tokens

52 turns: guide, canvas, tokens, status, `set_tokens`, then per frame `get_frame`, two batches of `edit_frame_html` and a screenshot, then three fix-and-look rounds.

- History at the end: 131,000 tokens. Largest parts: ten frames of HTML read back (55,000), thirteen screenshots (35,000), edit results (16,000), the guide.
- Input processed: 5.1 million tokens. Output: 17,000.

### Job C: animate a 3-frame storyboard

27 turns: guide, canvas, three `get_frame`, `animate_storyboard`, six `set_composition` op batches (each returns the whole composition), six frame edits for motion markup, two `lint_motion`, a fix, three screenshots, `render_composition`.

- History at the end: 73,000 tokens. Largest parts: composition echoes (26,000), three frames of HTML (16,500), the guide, screenshots (8,100).
- Input processed: 2.0 million tokens. Output: 12,000.

### Cost per job today

| Job                     | Turns | Input processed | Large, cached | Medium, cached | Small, cached | Large, no cache | Medium, no cache |
| ----------------------- | ----- | --------------- | ------------- | -------------- | ------------- | --------------- | ---------------- |
| A, MCP                  | 24    | 1.20 M          | $0.83         | $0.41          | $0.03         | $5.04           | $2.52            |
| B, MCP                  | 52    | 5.11 M          | $2.12         | $1.06          | $0.08         | $20.77          | $10.39           |
| C, MCP                  | 27    | 1.96 M          | $1.11         | $0.56          | $0.04         | $8.08           | $4.04            |
| A, Diazo Agent as built | 13    | 0.37 M          | $1.10         | $0.55          | $0.03         | –               | –                |

- With deferred tool definitions the cached MCP figures drop by 15 to 25% (A: $0.31 on the medium tier).
- The Diazo Agent row uses its real caching: prefix cached, history not. It needs fewer turns because it sends a new frame in one `create_frame` call.
- Latency follows the turn count: at 6 to 10 seconds per turn, job B is 5 to 9 minutes of waiting before any render time.

## Main cost drivers, in order

1. **Turn count times growing history.** Every result is re-read on each later turn. In job B each frame of HTML is re-read on every turn that follows its `get_frame`, dozens of times.
2. **Bulky results the model does not need whole**: full frame HTML, the whole composition after each op batch, a `frameSummary` and a review nudge after every edit.
3. **Screenshots**: up to 4,784 tokens each, required after every create and significant edit, then re-read on every later turn.
4. **The mandatory guide**: 9,700 tokens in one piece, though a job uses two or three of its sections.
5. **The fixed prefix**: 27,500 tokens for a client that loads all 89 tools. Cheap per turn once cached, expensive for a client that does not cache.
6. **For the Diazo Agent only: no cache breakpoint on the conversation.** History is billed at the full input price on every turn.

## The same jobs with script tools

Fixed prefix in the code profile: about 3,000 tokens (five tools and short instructions). The guide's core is 2,500 tokens; SDK typings load by namespace, about 1,800 tokens each.

Seven turns each: guide core, SDK docs, one read script, one write script, one downscaled image (1,568 px long edge, about 1,500 tokens), one fix script, the closing message.

| Job    | Turns  | Input processed | Large, cached | Medium, cached | Small, cached | Large, no cache | Medium, no cache |
| ------ | ------ | --------------- | ------------- | -------------- | ------------- | --------------- | ---------------- |
| A, MCP | 24 → 7 | 1.20 M → 80 k   | $0.34         | $0.17          | $0.01         | $0.55           | $0.27            |
| B, MCP | 52 → 7 | 5.11 M → 65 k   | $0.18         | $0.09          | $0.005        | $0.36           | $0.18            |
| C, MCP | 27 → 7 | 1.96 M → 75 k   | $0.26         | $0.13          | $0.007        | $0.46           | $0.23            |

| Job | Input tokens | Cost, cached client | Cost, client without cache | Model turns |
| --- | ------------ | ------------------- | -------------------------- | ----------- |
| A   | 15× less     | 2.5× less           | 9× less                    | 3.4× less   |
| B   | 79× less     | 12× less            | 57× less                   | 7.4× less   |
| C   | 26× less     | 4.3× less           | 17× less                   | 3.9× less   |

### With the quality budget

The change spends part of the saving on a better render: two more fix rounds fed by the full check results, and a final full-resolution screenshot (4,784 tokens) in place of the downscaled one. Nine turns per job.

| Job    | Turns  | Input processed | Medium, cached | Against today | Medium, no cache |
| ------ | ------ | --------------- | -------------- | ------------- | ---------------- |
| A, MCP | 24 → 9 | 1.20 M → 131 k  | $0.21          | 2.0× less     | $0.40            |
| B, MCP | 52 → 9 | 5.11 M → 104 k  | $0.13          | 8.5× less     | $0.27            |
| C, MCP | 27 → 9 | 1.96 M → 117 k  | $0.17          | 3.4× less     | $0.34            |

- **These are the figures to plan with.** The seven-turn figures above are the floor, not the target.
- A duel of two takes of job A in script mode costs $0.42, about one run today ($0.41).

Diazo Agent, job A, medium tier:

| Step                                      | Cost  | Change |
| ----------------------------------------- | ----- | ------ |
| As built                                  | $0.55 | –      |
| Conversation cached, nothing else changed | $0.26 | −53%   |
| Conversation cached and script tools      | $0.19 | −65%   |
| The same with the quality budget          | $0.24 | −57%   |

## What the model says

- **Input tokens and turns fall by an order of magnitude on every job.** Dollars fall by an order of magnitude only where the work is edits across many frames (job B), or where the client does not cache.
- **Creating a frame has a floor: the HTML itself.** Job A's 6,800 output tokens are the design. At the medium tier they cost $0.07, 40% of the new total. No tool design removes them.
- **The cheapest change is not a new tool.** Caching the Diazo Agent's conversation halves its cost with a few lines.
- **Quality is not in this model.** It is measured by the benchmark and gated: script mode is a default only where it is equal or better on every quality measure (spec AC-22 to AC-25).

## Redo the numbers

The model is a list of turns per job, each with the tokens the model writes and the tokens the result returns. For turn `i`, input is `P + kickoff + Σ earlier (written + returned)`. Costs apply the prices above to fresh, cache-write and cache-read tokens. Thinking tokens are counted once as output (3,000 to 6,000 per job) and not carried forward.
