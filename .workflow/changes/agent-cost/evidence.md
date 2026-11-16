# Evidence

No verification recorded. Nothing is built.

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
