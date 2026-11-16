# 0015. Run agent scripts as TypeScript in a QuickJS WebAssembly sandbox

One architecture decision for Diazo. Read by anyone, human or agent, about to change how agents call the canvas, or about to run model-written code on the server.

## Status

Accepted, 2026-11-16.

## Context

- An agent job is a loop of tool calls. Each call is a model turn, and each result is read again on every later turn. Restyling 10 frames takes about 52 turns and 5 million input tokens (model in the change's cost-model.md, sizes measured on 2026-11-16).
- Letting the agent send one program that calls the tools on the server cuts the turns and keeps bulky data out of the model's context. Public work shows the pattern: code execution with MCP, Code Mode, programmatic tool calling.
- That program is written by a model that reads canvas content, imported pages and comments. It is untrusted code.
- Diazo runs as one Node 22 process: `bun run dev` with no setup, one Docker container, one container on a Mac, one k3s pod (ADR 0005). Native addons and extra services cost every install.
- Agents reach Diazo over MCP from any client and through the Diazo Agent on several providers. A mechanism tied to one provider or one client covers a fraction of the runs.

## Decision

We add script tools that run one TypeScript program per call against a typed SDK, and we run that program in QuickJS compiled to WebAssembly (`quickjs-emscripten`), in a worker thread of the server.

- One fresh context per run. It holds no host object: no network, file system, process, module loader or timer. Its only capability is the `diazo` SDK object.
- Every SDK function calls the existing action behind the same role gate as the tool it mirrors, bound to the caller and to one canvas.
- Each run has limits (time, memory, SDK calls, writes, result size), an audit record, and one-step undo.
- In scope: read and write of frames, tokens, components, library inserts and compositions, and server-side checks. Out of scope: deletes, sharing, approvals, web imports, image generation, repo access, and any network from a script.
- Existing tools stay. Script tools are added beside them and can be switched off with `DOOP_AGENT_SCRIPTS`.
- Script mode becomes a default only where a measured benchmark shows its renders equal or better than tool mode's on every quality measure. Cost never overrides that gate.

## Alternatives rejected

- A V8 isolate with `isolated-vm`. Rejected: a native addon in maintenance mode whose README advises a separate process, and whose current major needs a newer Node than the server runs.
- Python in Pyodide. Rejected: 14 MB, and not a sandbox inside Node; it would need its own process, which is the sidecar option with more weight.
- A sidecar container running Deno or Python. Rejected: a second service for every install and for the zero-setup dev run. It stays the fallback if the in-process sandbox proves too weak.
- Node's `vm` module or the permission model. Rejected: Node documents neither as a security boundary.
- The model provider's own programmatic tool calling. Rejected: one provider, not available to tools reached over MCP, and each call still returns to the server.
- A persistent session on the user's machine, as unharnessed.dev does. Rejected: it has no sandbox by design and runs with the user's permissions; Diazo is a shared server.
- No scripts, only more batch tools. Rejected: each new job shape needs a new tool, and reads still enter the context.

## Consequences

- Good: a multi-frame job takes about 9 model turns instead of 24 to 52, refinement rounds and a final review included; input tokens fall 9 to 49 times in the model.
- Good: the turns saved pay for numeric checks on every iteration and more refinement, which is how the render is meant to get better.
- Good: one mechanism serves every MCP client and every provider of the Diazo Agent.
- Good: no native build and no new service; the install paths do not change.
- Bad: a new dependency that is not security-audited. The WebAssembly boundary and the empty context are the defence, and SDK gates limit what an escape could do.
- Bad: QuickJS is an interpreter. Heavy computation in a script is slow; the SDK must do the heavy work.
- Bad: a client that approves `run_script` approves many writes at once. Read and write are separate tools, and every run is recorded and reversible.
- Bad: a second surface beside the tools. A test must list every tool as mirrored in the SDK or excluded with a reason.
- Follow-up: a migration for the run records, and guide text that tells agents when a script fits.

## Confirmation

The Stip change `agent-cost`: spec AC-7 to AC-11 (sandbox, limits, gates), AC-15 (measured turns and tokens against tool mode) and AC-22 to AC-25 (the quality gate).

## Confidence

Medium. We revisit if the task 7 spike shows a run cannot be stopped on time or held under its memory limit, or if a sandbox escape is published for the package: then the sidecar container replaces it behind the same SDK.

## Links

- [.workflow/changes/agent-cost/proposal.md](../../.workflow/changes/agent-cost/proposal.md)
- [.workflow/changes/agent-cost/cost-model.md](../../.workflow/changes/agent-cost/cost-model.md)
- [ADR 0005](0005-use-pglite-when-no-database-is-configured.md)
