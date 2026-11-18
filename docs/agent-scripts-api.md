# Agent scripts API

Status: current, implemented by the `agent-cost` change (phases 0–1 backend).
Audience: agents calling `query_script` / `run_script` over MCP, the Diazo
Agent, and the frontend code that renders the Usage tab and run audit.

One idea: an agent sends one TypeScript program instead of many tool calls.
The program runs on the server in a QuickJS-in-WebAssembly sandbox with a
typed `diazo` SDK; only its `return` value re-enters the model's context.

## Tools

| Tool                | Role needed | What it does                                                        |
| ------------------- | ----------- | ------------------------------------------------------------------- |
| `query_script`      | `view`      | Runs a script with the SDK's read functions only.                   |
| `run_script`        | `edit`      | Runs a script with reads and writes. Annotated destructive.         |
| `get_sdk_docs`      | `view`      | Returns one SDK namespace's typings and two examples (~1,800 tok.). |
| `revert_script_run` | `edit`      | Undoes one `run_script` run as a single action (spec AC-13).        |

All four exist on the MCP server and in the Diazo Agent under the same
names, sharing `server/scriptRunner.ts`. `DOOP_AGENT_SCRIPTS=false` removes
`query_script` and `run_script` from both surfaces and refuses calls.

### `query_script({ canvas_id, script, agent_name? })`

- `script` is TypeScript, stripped with esbuild; top-level `await` and a
  final `return <value>` are allowed.
- The SDK inside has no write function — the `query` build omits them, so a
  read script can never touch the store.

### `run_script({ canvas_id, script, idempotency_key?, dry_run?, result_cap?, agent_name? })`

- `idempotency_key` (string, ≤ 200 chars): a repeated call with the same key
  on the same canvas returns the first run's recorded result verbatim and
  executes nothing (`deduplicated: true`).
- `dry_run: true`: the run executes against the real canvas, its writes are
  recorded and rolled back before answering. The answer carries the planned
  `writes` and the `checks` the writes produced, and nothing persists.
- `result_cap` (bytes): raise the 8 KB result cap, at most 32 KB.
- A second run on the same canvas does not queue: it starts when the
  previous one ends; SDK calls see the store as it is then.

### Result shape (both tools)

```json
{
  "run_id": "…",
  "ok": true,
  "result": { "…": "the script's return value" },
  "error": "only when !ok — message or limit name",
  "code": "permission|not_found|invalid|conflict|unavailable|refused|limit|failed",
  "writes": [{ "fn": "frames.edit", "target": "fr_…", "detail": "3 ops" }],
  "checks": { "fr_…": { "review": "…" } },
  "ms": 812,
  "truncated": false,
  "deduplicated": false,
  "dry_run": false
}
```

`checks` holds one `checks.review` per frame whose HTML a write touched —
returned without being asked (spec AC-26).

## The `diazo` SDK

Typings: `shared/scriptSdk.d.ts` (the contract; `get_sdk_docs` serves it by
namespace). One global `diazo`, every function awaited.

| Namespace            | Reads                                                         | Writes                                                |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| `diazo.canvas`       | `summary({brief?})`                                           | `status(text)`                                        |
| `diazo.frames`       | `list`, `outline`, `html`, `find`, `styles`                   | `create`, `stream`, `edit`, `replaceValues`, `update` |
| `diazo.checks`       | `lint`, `responsive`, `measure`, `snapshot`, `diff`, `review` | `autofix`                                             |
| `diazo.tokens`       | `get`                                                         | `create`, `set`, `themes`                             |
| `diazo.components`   | `list`, `get`                                                 | `create`, `update`, `insert`                          |
| `diazo.libraries`    | `search`, `item`, `check`                                     | `insert`                                              |
| `diazo.compositions` | `get`, `stateAt(times)`, `lint`                               | `storyboard`, `patch`                                 |

Not in the SDK (kept on their own tools, spec AC-11): deleting frames,
pages or components; sharing; approvals; `import_webpage` / `view_website`;
`generate_image`; `search_images` / `search_icons` / `search_logos`;
`render_composition`; repo tools; `set_guidelines`.

Every function calls the same code the corresponding MCP tool calls
(`server/actions.ts`, `pageTools.ts`, `componentTools.ts`,
`libraryTools.ts`, `motionTools.ts`, `frameChecks.ts`, `lint.ts`), behind
the same `canvasRole` gate and the `AGENT_GUIDELINE_WRITES` /
`AGENT_LIBRARY_WRITES` switches. The SDK is bound to the one canvas the
call names — ids of another canvas refuse with `code: "permission"`.

## Limits (spec AC-8, AC-18)

| Limit        | Default | Hard max | `limit` name   |
| ------------ | ------- | -------- | -------------- |
| Wall clock   | 30 s    | 60 s     | `wall`         |
| Memory       | 64 MB   | —        | `memory`       |
| SDK calls    | 200     | —        | `sdk_calls`    |
| Frame writes | 40      | —        | `frame_writes` |
| Script size  | 256 KB  | —        | `script_size`  |
| Result size  | 8 KB    | 32 KB    | `result_size`  |

A limit ends the run with `ok:false`, `code:"limit"`, the limit name in
`error`, and no further write; a failed or limited run reverts itself
(AC-13). The sandbox gives a script no `fetch`, `require`, `import()`,
`process`, timers or filesystem — its only capability is `diazo`.

## Errors

SDK rejections are `DiazoError` (`name`, `code`, a message naming the
function and the fix). Uncaught script errors surface as `ok:false,
code:"failed"`. `checks.*` functions that need the renderer fail with
`code:"unavailable"` when the server has none.

## Audit, undo, the activity feed

Every run writes one `script_runs` row: source and sha256, actor, canvas,
each SDK call with target and duration, the writes, the outcome and the
time taken (spec AC-12). The canvas activity feed shows one line per run,
and every write is tagged with the run id — `revert_script_run({ canvas_id,
run_id })` restores frames, tokens and composition to their pre-run state
in one action, as run rollback does for agent runs.

## The per-call ledger the Usage tab reads

Every tool call — MCP and Diazo Agent alike — is recorded in `tool_calls`
with this shape (`shared/toolCalls.ts`):

```ts
{
  id: string
  canvasId: string | null
  source: 'mcp' | 'resident'
  tool: string
  actorName: string
  actorKind: 'user' | 'agent'
  ownerId: string | null
  runId: string | null // the resident run, when inside one
  inputBytes: number // JSON size of the arguments
  resultBytes: number // JSON size of the result content
  imagePixels: number // w×h summed over images in the result
  ms: number
  failed: boolean
  at: number
}
```

Editors read it through `GET /api/canvases/:id/usage` (`toolCalls` section:
`totals` rollups + recent `calls`, newest first) and `get_usage`. The
`script_runs` table holds the same story per script run for the audit view.

## The `code` MCP profile

`/mcp?profile=code` lists at most six tools — `get_guide`, `get_sdk_docs`,
`query_script`, `run_script`, `get_frame_screenshot` (plus `revert_script_run`)
— under 12,000 chars of definitions total. `get_guide` gains topics:
`core` (< 10,000 chars) plus `components`, `prototypes`, `libraries`,
`motion`, `scripts`; `diazo-instructions` still serves the whole text. The
default profile lists every existing tool plus the new ones.
