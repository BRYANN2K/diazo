# TECHSTACK - Diazo

Status: current, updated 2026-11-17

## 1. Language and Runtime

- TypeScript 5.9 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
  `bun run typecheck` uses `tsgo` (`@typescript/native-preview`, the TypeScript 7 Go compiler) for
  speed; the JS `typescript` package serves editors and the ESLint parser.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step, both in dev
  (`tsx watch`) and prod (`NODE_ENV=production tsx server/index.ts`).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell.

## 2. Core Frameworks and Libraries

- Express 4.19.2 - HTTP server framework in `server/`.
- React 18.3.1 - UI framework in `src/`.
- Zustand 4.5.4 - client-side state management.
- Element ids (`shared/elementId.ts`): anything outside a frame that points at an element
  inside it uses the element's `data-doop-id` attribute, stamped into the frame HTML the first
  time something needs it (a comment, an element link, a layer rename, whose undo and redo find the element by it) and kept by agents like every other
  `data-doop-*` attribute. The server stamps (`server/elementIds.ts`, parse5 by source offset,
  so nothing else is re-serialized; `actions.ensureElementId`, exposed as
  `POST /api/frames/:id/element-id` to the comment role) as an annotation: `store.updateFrame`'s
  `annotation` option keeps `ready_for_dev` sign-off, and no version or activity line is written.
  A positional path that does not resolve in the saved HTML (a script-made element, a frame
  mid-stream) is refused, and a comment falls back to the frame at its point. The frame runtime's
  probe reports an existing id as `elementId`; its positional `cssPath` is now only the editor's
  internal selection language.
- Element links use `/c/<canvasId>?frame=<frameId>&element=<data-doop-id>` (no selector form,
  and no backwards compatibility for the old one). `src/lib/elementLink.ts` owns copying from the
  element toolbar and Layers menu, stamping first when the element has no id; `Stage.tsx`
  focuses its page and frame; `FrameView.tsx` resolves the id in the ready iframe, including
  script-created elements, re-picks the positional path so the Layers panel follows, and falls
  back to frame details if nothing carries the id. Browser regressions in
  `tests/pageCanvasBrowser.test.ts` cover initial loading, cross-page links, stamping on copy,
  clipboard round trips, history and script-created or script-removed elements.
- Radix UI primitives (`@radix-ui/react-*`, ^1.x-2.x) + shadcn 4.19.0 - accessible UI primitives
  generated into `src/components/ui`.
- `@anthropic-ai/sdk` 0.115.0 and `@modelcontextprotocol/sdk` 1.12.0 - power the built-in Diazo
  Agent and the MCP server that lets external agents (e.g. Claude Code) design on a canvas.
- Design inspiration (`server/inspiration.ts`, `search_inspiration` in MCP and the resident agent):
  One Page Love's API (`ONEPAGELOVE_API_KEY`; unset, the tool tells agents to brief without an
  exemplar). `/v1/search` resolves the query to taxonomy filters, `/v1/inspirations?status=live`
  returns the sites with style, colour, fonts and sections, dropping the broadest filter until
  something matches; six-hour in-memory cache for the free plan's 1,000 requests a day. Every
  result credits One Page Love and the authors with the entry's link (their terms). Tests:
  `inspiration.test.ts`.
- Where frame CSS goes (`FRAME_STYLES` in `server/guide.ts`): agents are asked to style an element
  in its own `style` attribute, which is what the editor reads and writes, and to keep a `<style>`
  block for what an attribute cannot say (keyframes, font faces, `:root` custom properties, states,
  pseudo-elements, media and container queries, a component's variant rules, the reset). A property
  a state, variant or query changes sits in the stylesheet with its resting value too, since an
  inline value outranks every rule. Guidance
  only: nothing rejects or rewrites a stylesheet, and a frame already styled by classes keeps them.
  The MCP guide, `create_frame`'s description and the resident agent's system prompt carry the same
  text. Tests: `frameStyleGuidance.test.ts`.
- Agent feedback (`server/agentFeedback.ts`, `shared/agentFeedback.ts`): agents talk to the Doop
  team through two MCP tools, which the resident agent has under the same names. `report_issue`
  (kind `issue`: `bug`, `tool_error`, `confusing`, `missing_capability`, `other`) is for where Doop
  got in their way; `share_feedback` (kind `feedback`: `idea`, `improvement`, `praise`, `other`) is
  for what would help or what worked. Each takes a message and optionally the tool and canvas
  involved. Both land in `agent_feedback` with the account and the MCP client's name. `/mcp` is
  stateless (a fresh server per request), so `handleMcpRequest` remembers the `initialize`
  clientInfo name per credential (a hash of the bearer) and falls back to the OAuth application's
  name. Reports go to PostHog as `agent_feedback_reported` with `kind` and share a cap of 20 an hour
  per account. Instance admins read them at `GET /api/admin/agent-feedback` (Admin → Agent
  feedback), 50 at a time with `kind`, `q` (searched on the server, account email included) and a
  `before=<at>:<id>` cursor for older pages. They never reach the humans on a canvas. Tests:
  `agentFeedback.test.ts`, `agentFeedbackHttp.test.ts` (separate HTTP requests).
- Canvas skills (`shared/skills.ts`, upstream issue #380): named know-how per canvas (name, a
  one-line "when to use it" description, markdown), in `canvas_skills` (migration 0060), mirrored
  in memory and copied with the canvas. Unlike guidelines, which every run carries in full, agents
  see only the list and load a skill with `get_skill` when the task matches. An ask naming one as
  `/name` gets its text in the resident's `# Canvas skills` block (`actions.skillsBrief`). REST
  `GET`/`PUT`/`DELETE /api/canvases/:id/skills/:name`, MCP `list_skills` / `get_skill` /
  `set_skill`, the resident's `get_skill` (chat too) and `set_skill`; writes by agents follow
  `AGENT_GUIDELINE_WRITES`. Memory panel section and `SkillModal.tsx`; the chat composer's `/`
  menu writes `/name` into the ask. Tests: `canvasSkills.test.ts`, `residentSkills.test.ts`,
  `skillsUi.test.tsx`.
- Claude Code on the desktop (`shared/localAgent.ts`, `server/localAgent.ts`,
  `desktop/src-tauri/src/claude.rs`): the model menu (`CLAUDE_PLAN_MODELS`) is the CLI's aliases
  (`CLAUDE_MODEL_ALIASES`, named "Latest Opus" and so on), which `claude --model` resolves to the
  newest model the installed CLI knows, then every pinned id Anthropic still serves
  (`CLAUDE_PINNED_MODELS`: Fable 5.2 to Haiku 4.5, by name and version; a release adds a line),
  served by `/api/agent-runners` and listed in Settings' dropdown, plus any other
  `claude-*` id accepted by shape (`isClaudeModel`, mirrored by `valid_model` in the shell before the
  value becomes an argument); `effort` (`CLAUDE_EFFORTS`, `local_agent_preferences.effort`) rides the
  job and becomes `--effort`. A pre-alias shell's "Invalid model" is reworded by
  `localAgentRuns` into an update prompt. Which `claude` runs: the one picked in Settings
  (`claude_choose_cli`, a native file panel, never a page-supplied path; `cli.json` in the app's
  data dir), else what the login shell's `command -v claude` names (aliases included) when it is
  2.1+, else the newest known install. The shell is asked once per launch (`$SHELL -l -i -c`, 5s
  bound; Refresh asks again) and its `PATH` is given to every CLI process, since a GUI app's
  `/usr/bin:/bin` PATH lacks the `node` an npm install needs. Shells advertise this with
  `__DOOP_CLAUDE_CHOOSE__`.
- Local ACP agents (`shared/acpAgent.ts`, `server/acpAgentPreferences.ts`,
  `desktop/src-tauri/src/acp.rs`, `src/lib/acpAgent.ts`, `src/components/LocalAcpAgent.tsx`): the
  Devin CLI (`devin acp`) and the Grok CLI (`grok agent stdio`) run on the person's desktop as the
  connections `devin-local` and `grok-local`, next to the Claude Plan (`isLocalRunner`). The
  shell is a minimal ACP client (JSON-RPC 2.0 over stdio, no ACP crate: the official one is async
  and `!Send`, the shell's runners are blocking threads): `initialize` (the agent must report
  `mcpCapabilities.http`), `session/new` in an empty private directory with the run's
  `/local-agent/mcp/:id` server and Bearer token, one `session/prompt` (the system brief leads the
  text, ACP having no system prompt), `agent_message_chunk` updates streamed to the page as
  `acp-progress`, `session/cancel` on a stop with 10s to wind down, then the process group is
  killed. `session/request_permission` is granted once for one of the job's Doop tool names
  (`mcp__doop__x`, `doop/x` or bare, never an edit, delete, move or execute call), rejected
  otherwise; `fs/*` and `terminal/*` are refused (the client advertises neither). The binary is
  the allowlisted agent's name found in its installer's dirs, the login shell's PATH
  (`claude::login_shell_path`), the app's PATH and Homebrew; the page passes a model id
  (`valid_model`, the shape of `ACP_MODEL_ID`) and a Grok effort, nothing else. `acp_status` runs
  `--version`, `devin auth status` + `devin models` or `grok models` (cached 10 min, Refresh asks
  again) and the page sends the model list along with a poll every minute; the server keeps it in
  memory per desktop (`localAgentRuns.catalog`) to widen the curated menus (`acpMenu`). Devin's
  menu is model families, its effort the variant suffix (`devinModelId`: nearest step, the
  higher on a tie); Grok's effort is `--reasoning-effort` (low / medium / high / xhigh). The relay
  is `localAgentRuns`, keyed by agent: jobs carry `agent` and `tools` (absent for the Plan, so old
  shells read Claude jobs unchanged), devices and the online check are per agent,
  `/api/local-agent/acp/:agent` (GET, PUT, `/poll`, `/stop`) beside the Plan's routes, results
  through the shared `/finish/:id`. Preferences in `acp_agent_preferences` (migration 0070, one
  row per person and agent). Usage comes from the prompt response's `usage` and a USD
  `usage_update` cost (`fromAcpUsage`); without them the run record keeps its time only. Known
  limits: Devin also loads the person's own MCP config, and its sessions open in its
  `accept-edits` mode (edits land in the empty run directory). Tests: the Rust tests in `acp.rs`
  (a fake agent in sh), `acpAgents.test.ts`, `acpAgentRow.test.tsx`, `acpAgentRunners.test.tsx`.
- Model menus (`server/modelCatalog.ts`, `catalogForAccount` in `server/agentRunners.ts`,
  `GET /api/model-account/models`): a connected account's menus list what the account can
  actually run — the provider's catalog asked with the user's own key, the curated entries of
  `shared/modelMenu.ts` / `shared/localAgent.ts` merged on top as `recommended`; a provider
  without a loader, or one that cannot be reached, gets the curated menu with `live: false`.
  `GET /api/agent-runners` serves the same merged list per enabled account (`listRunners`), so
  the composer's `ModelPicker`, the model duel's choices and Settings' dropdowns agree; the
  picker and Settings still fetch `?kind=` per account on open/mount for a fresh list and its
  error caption. Anthropic and OpenAI (`/v1/models`), Gemini (`/v1beta/models`) and ChatGPT
  subscriptions (the Codex backend's catalog, `CHATGPT_MODELS_URL`, asked with the account's
  token as Codex CLI `CHATGPT_CODEX_CLIENT_VERSION`; the call refreshes the token first) have
  loaders, each with a family filter for reasoning chat models with tools, images and a 16k
  output window; a picked id only has to be shaped like the provider's, and the run is the
  final check. OpenRouter, DeepSeek, Kimi and Kimi Code stay on their curated rosters (the
  run-time vision check knows only the roster's flags).
- DeepSeek and Kimi keys (`deepseek-key`, `kimi-key`) and the Kimi Code plan (`kimi-code`, a
  Kimi membership's key, sent with a `Diazo/<version>` User-Agent as Kimi Code's terms require)
  run on the Chat Completions transport (`server/chatCompletionsAgent.ts`) against fixed URLs
  (`DEEPSEEK_CHAT_URL`, `KIMI_CHAT_URL`, `KIMI_CODE_CHAT_URL`, an operator's override only). Both refuse a tool-calling conversation that drops an earlier turn's
  `reasoning_content`, so the transport keeps it as a `thinking` block in the run's history and
  sends it back where the config sets `echoReasoning`. Tests: the `reasoning_content` cases in
  `chatCompletionsAgent.test.ts`, `rosterRouting.test.ts`, `providerKeyAccounts.test.ts`.
- Custom providers (`shared/customProvider.ts`, `server/customProviders.ts`,
  `server/customProviderFetch.ts`, `src/components/CustomProviderForm.tsx`): any OpenAI Chat
  Completions or Anthropic Messages endpoint, added in Settings → Diazo Agent by name, API type, base
  URL, an optional key and the models it offers (each with "Sees images" and an optional max output
  tokens, which caps the turn's budget). One is a `model_accounts` row of kind `custom:<id>` (id
  minted by the server, at most 10 per person) with its description in `custom` (jsonb) and extra
  headers in `custom_headers` (sealed; migration 0051), so on/off, the default, the composer pick and
  disconnect are the ordinary account routes. `POST /api/custom-providers` adds, `PUT
/api/custom-providers/:kind` edits (a key or headers left out are kept, empty clears them);
  `/models` lists the endpoint's ids and `/test` runs one turn that must call a tool, both rationed per
  person and able to use an edited provider's stored secrets. Every request goes through
  `customProviderFetch`: https to public addresses only, DNS pinned per request, no redirects, 32 MB
  response cap; `DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS` admits private hosts and http for a self-hosted
  instance, `DOOP_CUSTOM_PROVIDERS=false` turns the feature off (existing ones read as disconnected).
  Advanced: extra headers (routing and framing headers refused), `max_tokens` vs
  `max_completion_tokens`, and echoing `reasoning_content`. Tests: `customProvider.test.ts`,
  `customProvidersHttp.test.ts`, `customProviderForm.test.tsx`.
- Reasoning effort on a user's OpenAI account (ChatGPT subscription or OpenAI key): the pick lives
  in `model_accounts.reasoning_effort` (`REASONING_EFFORTS` in `shared/modelMenu.ts`: low / medium /
  high / xhigh), set through `PATCH /api/model-account/:kind { effort }`, read by `effortFor` in
  `server/openaiAgent.ts` for every turn, with `DOOP_AGENT_OPENAI_EFFORT` as the default until a
  user picks. The status reports the resolved `effort` for the OpenAI kinds only, which is what
  shows the `Segmented` switch in Settings and the effort pill's radio list in the composer's
  `ModelPicker`. A `RunnerPick` may carry its own `effort` for one run — the composer's picker
  and each duel slot set it in the shared `EffortMenu` popover (a "Default" row, where the
  connection has none configured, sends no effort) — and `pickModel` honours it (`accountWithPick` for the OpenAI
  kinds, `isClaudeEffort` → `claude --effort` on the Plan); the localized names and blurbs for
  the dials live in `src/lib/effortLabels.ts`.
- Image descriptions (`.workflow/specs/image-descriptions.md`, `server/imageDescriptions.ts`,
  `shared/imageDescriptions.ts`): raster uploads emit `asset.stored` and get an asynchronous
  description. Billing resolves uploader → eligible canvas owner → server; Off on either
  person stops analysis, and a server-only uploader bypasses both accounts. The stable uploader
  ID is `assets.owner_id`; migration 0050 persists `describe_payer_id` and `describe_provider`
  before work so retries never change payer. Runtime errors do not trigger billing fallback.
  The in-memory queue defaults to two concurrent jobs, three attempts 30s apart, and 200
  attempts per canvas per UTC day (counter resets on restart). A 20s deadline bounds storage,
  resizing and model work. Deleted canvases are skipped. Startup recovers unfinished assets;
  migration 0050 excludes pre-feature history. Settings uses `image_description_prefs` and
  `GET`/`PUT /api/image-descriptions`. Agents read `images` on frame summaries and in resident
  kickoff; only standalone image layers are marked pasted references. Success broadcasts
  `asset:described` without changing frame HTML. Tests: `imageDescriptions.test.ts`,
  `describerModels.test.ts`, `imageDescriptionsMcp.test.ts`, `imageDescriptionsHttp.test.ts`,
  `imageDescriptionsCard.test.tsx`.
- Connections and the default (`server/agentDefaults.ts`, `server/modelAccounts.ts`): a person can
  connect every provider at once, one `model_accounts` row per user and kind (composite key and an
  `enabled` flag, migration 0046), plus the Claude Plan on their desktop (`local_agent_preferences`,
  whose `enabled` is the Plan's on/off). Settings → Diazo Agent (`ConnectionTable.tsx`) is grouped
  lists: "Connected" (provider tile, name with a Default or Off badge, a short line, then the model
  dropdown with the effort as a `StepSlider`, the on/off switch and a "…" menu: Make default,
  Replace key (a modal) or Claude Code settings (a modal: which CLI, a pinned model), Disconnect),
  "Add an agent" (every provider not connected, each with Connect; the one being connected shows
  its key field or sign-in under it) and "Image model" (`ImageModelCard.tsx`, a pickable list);
  `agent_defaults`
  stores the marked provider (`PUT /api/agent-runners/default`, connected and on only).
  `resolveDefault` passes over a mark on a connection that is gone or off, then falls back to the
  Plan while on, then the account
  connected first that is on. Account routes are per kind (`/api/model-account/:kind` takes
  `PATCH` and `DELETE`; `GET /api/model-account/models?kind=`) and every one answers with
  the whole view (`accountsView`: every account on or off, the default, the menus). The meter
  counts any connection that is on and names the default; image generation uses the enabled
  account matching the image provider (ChatGPT before an OpenAI key), server keys only for
  someone who connected none (switching every account off does not count). Tests: `anthropicAccount.test.ts` (end to end), `defaultRouting.test.ts`,
  `agentRunners.test.ts`, `chatgptProviderSwitch.test.tsx`, `localClaudeConnection.test.tsx`.
- Which connection runs a task (`shared/agentRunner.ts`, `server/agentRunners.ts`):
  `GET /api/agent-runners` lists every connection that is on, each with its merged model
  catalog (above), plus `default`. The composer's `ModelPicker` offers each one and its models;
  the pick is this browser's (`src/lib/runnerPick.ts`, `doop:agent-runner`), rides on the card
  as `runner` (a `RunnerPick`: provider, model, effort; `tasks.runner` JSON, migration 0045)
  and the send button's meter names it. The model duel (`server/duels.ts`,
  `DuelDialog.tsx`/`DuelCards.tsx`, `shared/duel.ts`) builds one `RunnerPick` per filled slot
  into one scoped card each. The dialog is the brief alone with three slot cards in its foot
  ("Model 1", "Model 2", "Model 3 (optional)"), each a model button with an effort pill under
  it (the pill only where the slot's connection has a dial). Both pills open the composer's
  menus from `src/components/ModelMenu.tsx`: `ModelMenu` leads with a search field that
  filters as it types (↑/↓/↩ work), then the connections under their names ("· Desktop app
  not running" when `online` is false), each listing its `recommended` entries — the "Latest …"
  aliases and live-confirmed curated rows, or all of them when none is flagged — with the
  rest folded under "Older (N)", the pick checked and Model settings at the foot; `EffortMenu`
  is the radio list of the connection's levels with their `effortLabels` blurbs, a "Default"
  row where none is configured, a Faster/Smarter caption and a quarter→full dial on the pill.
  The search keeps the keyboard: a character or Backspace typed with focus anywhere in the menu
  goes to the field rather than Radix's typeahead, ↑ on the first row returns to it, Enter with
  an empty query changes nothing, and the field is not focused on a coarse pointer. A query
  matches a model's name or id, or a connection's name (all its rows). In a narrow composer
  foot (`@container/foot` in `PromptBar` and `ChatPanel`) the model pill shrinks and truncates
  while the effort pill drops to its dial below 330px.
  A slot adds Clear (or Delete/Backspace on its model button). A slot's effort starts at its
  connection's own (`runner.effort`, else Default) and stays with the slot across that
  connection's models.
  The same model may fill two slots (at different efforts it is a fair duel), but two slots
  with the same model and effort (`duelRepeats`, by `runnerKey`) get a warning and hold Start
  back, since the server refuses equal picks. Start needs two filled slots ("Start duel · 2
  models"). `duelGroups` groups the choices by connection, drops a `default` meta-entry (not a
  model to compare) and keeps a configured model the menu does not list. Entry labels use
  `knownModelName` ("Claude Plan · Opus 5.5", "ChatGPT · GPT-6.1 Sol"), and the comparison card
  names each entry's effort. OpenAI names are written one way by `openaiModelName`
  (`shared/modelMenu.ts`) in every catalog. Tests: `duelDialog.test.tsx`, `duel.test.ts`,
  `claudeModels.test.ts`, `modelNames.test.ts`. `pickModel(payerId, pick)` honours it for that run when the named connection is on, a
  model the provider does not know runs on the connection's configured one, and anything else
  runs on the default. One resident run claims work that agrees on the pick (`actions.nextWork`,
  the `runner` filter on the take functions): comments and automations carry none and run on
  the default, feedback runs on what its task ran on (kept on the feedback, `feedback.runner`,
  migration 0047, so a trimmed task history cannot move it). Tests: `agentRunner.test.ts`,
  `runnerQueue.test.ts`, `modelPickerRunners.test.tsx`, the pick cases in
  `localAgentRouting.test.ts`.
- Orca dev tasks (`shared/devTasks.ts`, `server/devTasks.ts`,
  `desktop/src-tauri/src/orca.rs`, docs/orca.md): a `ready_for_dev` frame can be sent to an
  Orca worktree. `POST /api/frames/:id/dev-tasks` builds the brief (the frame's PNG export,
  the canvas's design tokens and code links), writes a
  `frame_dev_tasks` row (migration 0072; `frameIds`, the brief, the Orca `wt2:` identity —
  never a path) and hands a `dev_task` `RepoRequest` to the requester's desktop over the
  `/api/local-repo/poll` bridge, which only a device holding the canvas's repo grant may
  claim. The shell's typed commands (`orca_status`, `orca_resolve_repo`,
  `orca_launch_task` behind a native confirmation, `orca_poll`, `orca_activate` —
  `__DIAZO_ORCA__`) build one argv each, never a shell string and never `--surface` (the
  person's Chat | CLI setting decides); it reports through `/api/dev-tasks/:id/report`,
  polls `worktree ps` trimmed to the identities it launched (`orca-tasks.json`), and the
  coding agent pushes `update_dev_task` over MCP after reading its brief with
  `get_handoff`. Every change broadcasts `dev-task` to the room. Tests:
  `devTasks.test.ts`, `devTaskRoutes.test.ts`, the `orca::tests` unit tests.
- Pages over MCP (`server/mcp.ts`): `get_canvas` lists `pages` (id, name, `startFrameId`) and
  every frame's `pageId`, and narrows to one page with `page_id`; `create_canvas_page` adds an
  empty page at the end (`actions.createCanvasPage`, a server-minted id, `MAX_PAGES` enforced)
  and returns it for `create_frame`'s `pageId` (a canvas holds 100 pages, a design library 1,000:
  `maxPages` in `server/store.ts`; past 100 the Pages panel gets a filter and a windowed list); `set_canvas_pages` stays the whole-list call for
  rename, reorder and delete; `update_frame` moves a frame between pages (it keeps its x/y; an
  unknown `pageId` is refused with the canvas's page list). The guide's "Frames and HTML" section says when a page beats a
  frame. The resident agent has the same three tools under the same names; both surfaces run
  `server/pageTools.ts`, its kickoff lists the pages and each frame's page and position, and a
  run whose only work was arranging counts as delivered (`arrangeWrites`). Tests: the page cases
  in `mcp-tools.test.ts`, `residentPageTools.test.ts`.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.
- Big canvases (`shared/frameHtml.ts`, `server/index.ts`, `src/lib/ws.ts`): a canvas opens on one
  page. The web client's `join` carries `deferHtml: true` plus the page it is on (a reconnect) or
  the `?page=` / `?frame=` its link names, and `init` answers with `pageId` and the HTML of that
  page's frames only; every other frame arrives with `html: ''` and `htmlDeferred: true` (a
  client that does not ask, such as the iOS app, still gets every frame whole). The client asks
  for the rest with `frames:load` (`pageId` and/or `frameIds`, at most `MAX_LOAD_FRAME_IDS`),
  answered by `frames:html` batches of about 1M characters, and `store.mergeFrameHtml` fills in
  the frames still deferred. `ws.ts` loads the open page's deferred frames whenever the canvas or
  the page changes, so everything off the stage may assume the open page is complete; what reads
  another page's HTML (the prototype player) calls `requestFrameHtml`. Live `frame:created` /
  `frame:updated` always carry their HTML, for any page. `GET /api/canvases/:id` stays whole
  unless `?pageId=` opens it on one page, and `GET /api/frames/:id` returns one frame with its
  HTML. The room socket negotiates `permessage-deflate` (1 KB threshold, no context takeover),
  and `/api` responses go through `compression` (gzip/brotli; the SSE stream asks for
  `no-transform`). Tests: `deferredHtml.test.ts`, `deferredHtmlRoom.test.ts`,
  `wsDeferredHtml.test.ts`.
- Custom fonts (`shared/fonts.ts`, `server/fonts.ts`, `server/fontFile.ts`): font libraries, one
  per workspace (used on its canvases) and one per person (used on their personal canvases),
  managed in Settings → Fonts and Workspace → Fonts (`FontLibrary.tsx`, strings in the `fonts`
  catalog) over `/api/fonts`
  (`?workspace=` for a workspace's, members only); `GET /api/canvases/:id/fonts` is a canvas's.
  Uploads are TTF/OTF/WOFF/WOFF2 up to 10 MB, one face per file; `fontFile.ts` reads format,
  family (name id 16, else 1), weight (a variable font's `wght` range) and style from the bytes,
  with no font library dependency (zlib for WOFF, brotli for WOFF2), every decompression bounded
  before it starts (1 MB per metadata table, 48 MB for a WOFF2 stream). Bytes are an ordinary `/a/`
  asset, so removing a font never breaks a frame that loads it; re-uploading a face replaces it
  (writes queue per library, so racing uploads of one face leave one row).
  A frame stays self-contained: `withFontFaces` adds the `@font-face` rules for the library
  families its CSS names to one `<style data-doop-fonts>` block in its own HTML (only adds, never
  removes). `actions.createFrame` / `updateFrame` / the final append chunk run it on every write,
  and `FrameView`'s save path runs it too, so a family picked from the Design panel's "Custom
  fonts" group renders at once. Every renderer that reads frame HTML (screenshots, PDF
  export, iOS) gets the font that way. Agents see the library as `fonts` plus a note in
  `get_canvas` and as a system block in the resident agent (`libraryBrief`): name the family,
  never load it from Google Fonts. MCP `upload_font` (`server/fontUpload.ts`, MCP only: a resident run has no
  file to send) adds a face through `addFont`: the library is `canvas_id`'s (its workspace's for members,
  else its owner's for the owner alone, the rule of `GET /api/canvases/:id/fonts`) or `workspace_id`'s
  (members); bytes by `source_url` (`fetchRemote`, the SSRF-pinned fetch, capped at 10 MB), base64, or
  `local_file` (an upload ticket carrying `font`, so `PUT /u/<token>` takes 10 MB and calls `addFont`,
  which checks the library again); the answer names family, weight, style and the CSS to write.
  Tests: `uploadFontHttp.test.ts`, `fonts.test.ts` (a real WOFF2 in `tests/fixtures/fonts`), `fontLibrary.test.ts`,
  `fontLibraryRace.test.ts`, `fontFrameWrites.test.ts` (faces on create, stream end and idle; an idle close sends viewers the
  healed document, so a cut-off script never runs).
- Design tokens (`shared/designTokens.ts`, spec `.workflow/specs/design-tokens.md`): a canvas's
  typed design values (Paper's eleven types: colour, opacity, radius, spacing, container,
  breakpoint, font family / weight / size, line height, letter spacing), each a CSS custom
  property frames use as `var(--name)`, with a value per theme (`canvas.tokenThemes`; a frame
  switches with `data-doop-theme="dark"` on its `<html>`). `withTokenBlock` writes the values a
  frame names into its own `<style data-doop-tokens>` block wherever `withFontFaces` runs, and a
  token change rewrites that block in every frame naming it as an annotation (sign-off stands, no
  version). Stored in `design_tokens` + `canvases.token_themes` (migration 0050); REST under
  `/api/canvases/:id/tokens`, `/token-themes` and `/styleguide.md` (tokens + guidelines as one
  markdown); MCP `get_tokens` (json / css / tailwind / markdown), `create_tokens`, `set_tokens`,
  `set_token_themes`, mirrored on the resident agent; the Layers panel's Tokens tab
  (`TokensPanel.tsx`) and token menus on the Design panel's colour, radius and font-size fields.
  Tests: `designTokens.test.ts`, `designTokenWrites.test.ts`, `designTokensHttp.test.ts`.
- Hosted fonts (`shared/webFonts.ts`): the Design panel's font menu offers the "Fonts" group, a
  curated roster of open families on Google Fonts (`WEB_FONTS`, each with its css2 axes), plus
  two "Device fonts" (system UI, system monospace) labelled as varying by viewer; the OS stacks
  (Georgia, Verdana, Trebuchet, Helvetica, Arial, Times, Courier) were dropped from the menu since
  the server's renderer has none of them and exports disagreed with the editor. Naming a roster
  family in CSS is all it takes: `withWebFontLinks` adds one `<link rel="stylesheet"
data-doop-webfonts>` for the roster families the frame names and does not load itself (a
  library family of the same name wins, and leaves the link when uploaded later), run wherever
  `withFontFaces` runs (`actions` on every write, `FrameView`'s save path). The screenshot and
  PDF renderers already admit the two Google Fonts origins. Agents get the roster as `webFonts`
  plus a note in `get_canvas` and in the resident agent's `# Fonts` block (`webFontsBrief`).
  Self-hosted instances without outbound internet render roster fonts as their generic in
  exports. Tests: `webFonts.test.ts`, the hosted case in `fontFrameWrites.test.ts`, the font pick in
  `elementPanelBrowser.test.ts`.
- Fonts from this computer (`src/lib/localFonts.ts`, `desktop/src-tauri/src/fonts.rs`): in the
  desktop shell the font library card has "Add from this computer" (shells advertise it with
  `__DOOP_LOCAL_FONTS__`). `fonts_choose_local` opens the native file panel in the platform's
  fonts folder (the person's own first) and remembers the picks; `fonts_read_local` hands the
  page one picked file's bytes once, by that path and no other, and the page uploads it through
  the ordinary `POST /api/fonts`, so a local font becomes a library font rather than a
  device-only reference. Collections (`.ttc`, `.dfont`) and files over 10 MB are left out by
  name. A confirm dialog before the upload says the fonts are shared with the library and that
  OS fonts are often licensed for one person; Doop checks no licences (Figma's posture for shared
  fonts). Tests: the Rust unit tests in `fonts.rs`, `localFonts.test.ts`.
- Profile photos (`shared/avatar.ts`, `server/avatars.ts`): Settings → Your account → Photo uploads a
  PNG/JPG/WebP/GIF under 2 MB as raw bytes to `POST /api/me/avatar`, which stores it as an ordinary
  immutable `/a/` asset and points better-auth's `user.image` at it; `DELETE /api/me/avatar` puts the
  initials back. `avatarUrl` is the one rule for what a face may load: only such `/a/` uploads, never
  a social provider's picture or a URL set through the raw update-user call, so no account can make
  every viewer fetch an address it chose. The `Avatar` primitive takes `image` (a photo that fails to
  load falls back to the initials); it rides `Presence` (set at `join`, re-announced to the person's
  rooms on a change), `/api/me`, the session, canvas `people`, the share list and workspace members.
  Tests: `avatar.test.ts`, `avatarFace.test.tsx`.
- Outside a canvas room, `GET /api/me/events` (`server/userEvents.ts`, Server-Sent Events, one
  stream per tab) pings a user's open pages with `{ type: 'canvases' }` when a canvas or workspace
  membership adds or removes them (the workspace pings come from `addMember`, `removeMember`,
  `acceptInvite` and `deleteWorkspace` themselves). Home (`src/hooks/use-user-events.ts`) refetches
  on each ping and every time the stream opens, dropping a response older than one already shown.
  Inviting someone to a canvas also emails them once (`server/canvasShares.ts`, SMTP only). Tests:
  `canvasShares.test.ts`, `userEventsHttp.test.ts`.
- Frame image export (`src/lib/frameRaster.ts`, `src/lib/frameExport.ts`): the PNG / JPG download
  and Copy as PNG are drawn by the browser showing the frame, not by the server's Chromium. The
  runtime answers `doop:snapshot` with its live document (`exportSnapshot`: what an HTML copy
  loses is captured first, every `<canvas>` as its pixels, each `<img>` at the source the
  browser picked, a `blob:` image as its bytes, every stylesheet as the CSSOM holds it, adopted
  sheets included; `html: null` when a canvas is tainted, and the export goes to the server; `snapshotFrame` in
  `frameBridge.ts`, the store's HTML only when the frame is not mounted: a mounted frame that
  does not answer within its 15s is unreadable, and the server renders), `inlineDocument` turns it
  into one SVG sized to the frame, every image, stylesheet (both `@import` forms, cycles cut)
  and font fetched and inlined as a data: URL (an SVG drawn as an image loads nothing itself;
  scripts and `srcset` are dropped, a link's `media` kept; a nested document (iframe, object, embed) sends
  the frame to the server, since it would be a hole in the picture),
  and the SVG is drawn onto a canvas at 2x from a data: URL (a blob: URL taints the canvas in
  Chromium) and encoded. A resource the browser cannot fetch (an image host without CORS)
  rejects the whole render and the export falls back to `/i/<id>.<ext>` as before, so what the
  person sees on the canvas is never the export's blocker. An element inside a frame exports
  too (the element menu's Export… dialog and Copy as PNG, `downloadElementExport` /
  `copyElementPng`): the frame is rendered whole and cut to the element's live box
  (`doop:inspect` rect, `clipToFrame`, the raster's `clip` option), so every style it inherits
  and whatever paints behind it stay in the picture; a server render is cropped here the same
  way (`cropRaster`), and a frame off screen says so. Tests: `frameRaster.test.ts`,
  `frameRasterBrowser.test.ts` (pixels in Chromium, the live runtime included),
  `frameExport.test.ts`. Scale and format (`shared/exportScale.ts`, `src/lib/exportSettings.ts`,
  `ExportOptions.tsx`): the Inspector's Export group and the Export… dialog (frames, and elements
  from their menu) pick 0.5x / 1x / 2x / 3x / 4x or a typed multiplier (0.1-4, two decimals) and
  PNG / JPG / SVG, remembered per browser under `doop:export-settings` (2x PNG by default) and
  named `Name@2x.png` as Figma does. Up to 2x a scale is honoured as before; above it,
  `fitExportScale` brings a huge frame down to 16,384 px a side and 64 MP, the same limit
  for the browser render, `/i/<id>.png?scale=` (any parsed scale, 1x when unreadable) and MCP
  `export_frame`'s `scale`, and the toast says so. SVG is `frameSvg`: the inlined document
  `inlineDocument` already builds, cropped by `viewBox` for an element, on white, settled for
  a file opened as a page, where the viewer's window would be the viewport (`standalone`,
  `FrameViewport`): viewport units become the frame's px, `@media` rules and `<style media>` are
  kept or dropped by a hidden iframe of the frame's size, imported sheets included, and inline
  handlers and `javascript:` URLs are stripped; HTML in a
  `foreignObject`, so it opens in browsers but is not editable vector art, and it has no server
  fallback. Tests: `exportScale.test.ts`, the scale and SVG cases in `frameExport.test.ts`,
  `frameRasterBrowser.test.ts` (the SVG opened as a page in a wide window), `exportOptions.test.tsx`
  and `mcpPdfExport.test.ts`.
- Server-side renderer (`server/renderBrowser.ts`, used by `server/screenshot.ts`): every headless
  Chromium page (frame images, MCP screenshots, the resident's checks, PDF
  exports, website imports) goes through one gate of `RENDER_CONCURRENCY` pages (default 4;
  background work gets at most `RENDER_BACKGROUND_CONCURRENCY`, default 2 and always one below
  the total, a waiting agent goes before a waiting thumbnail), a bounded
  queue that refuses with `RendererBusyError` (HTTP 503 + Retry-After) and a lease that closes a
  page held past 120s. A browser that cannot open a page within 15s is killed with its process
  group and the open retried once on a fresh launch; a render that fails like a browser failure
  runs a health probe outside the gate and is retried once if the probe kills the browser; a
  browser is recycled after 500 pages or an hour. DevTools commands time out at 60s, not 180s.
  Screenshots are capped at 50M device px (`server/renderLimits.ts`; MCP says when it cropped).
  `GET /healthz/renderer` reports the counters (`kills`, `lastOpenedAt`, `failedOpensInARow`,
  queue depth) for an uptime check. Context: the 2026-11-05 wedge, where one browser stopped
  making pages for two hours. Tests: `renderBrowser.test.ts`.
  `REMOTE_BROWSER_URL` (+ `REMOTE_BROWSER_TOKEN`, sent as a Bearer header) swaps the local launch
  for `puppeteer.connect` to a remote Chrome over CDP: Cloudflare Browser Run
  (`wss://api.cloudflare.com/client/v4/accounts/<id>/browser-run/devtools/browser`), browserless
  or a renderer service; everything past the connect is unchanged, so switching provider is an env
  change. A remote browser is closed 30s after its last page (`idleCloseMs`; providers bill open
  sessions), and one whose close stalls is disconnected, having no process to kill. Assets load
  from `BETTER_AUTH_URL`, which the remote browser must reach. `REMOTE_BROWSER_ISOLATED` declares the
  browser cannot reach our private network (a hosted provider): it then fetches public URLs itself
  instead of through `guardPublicPageRequests`' DNS-pinned proxy; never set it for a self-hosted
  renderer.
- `pdf-lib` 1.17.1 - joins the vector PDF export (`server/pdfExport.ts`): headless Chrome prints
  each frame onto a page of its own size (inside an iframe of the frame's size, as the canvas shows
  it, so content taller than the frame is clipped rather than paginated: bare, Chrome moved a block
  straddling the edge whole onto a dropped second sheet), pages in the order the frames are listed (a whole page
  in canvas reading order, `shared/frameOrder.ts`; the Export checklist sends its displayed
  order); render limits in `shared/pdfLimits.ts`, which also sizes the browser's download
  timeout; served by `GET /api/canvases/:id/export.pdf` and MCP `export_frame`.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - primary database.
- drizzle-orm 0.45.2 + drizzle-kit - schema in `server/db/schema.ts` and
  `server/db/auth-schema.ts`; migrations generated via `npx drizzle-kit generate` into
  `server/db/migrations`, applied at boot by `server/db/index.ts` (never by drizzle-kit itself).
- `@electric-sql/pglite` 0.5.4 - embedded Postgres so `bun run dev` works with zero external
  services.
- `pg` 8.22.0 - Postgres driver for the real-database path.
- Frame HTML in memory (`server/store.ts`, `server/frameHtml.ts`): the store keeps every canvas
  and frame, but frame HTML (most of the data) loads per canvas. Boot reads `frames` without `html`;
  `store.load(canvasId)` reads one canvas's (concurrent calls share the read) and `evictIdle` drops
  it after `CANVAS_IDLE_MS` (10 min) unused, never while a room, an MCP agent's presence, a stream,
  a `store.hold` or an unsaved frame is on it (`persist.frameWritePending`: dirty from a save until
  a write at that state succeeds, so a debounce, a write in flight and a failed write all count; the
  sweep retries a failed one). Entry points load and hold for their length, and the rest stays
  synchronous: the REST middleware for `/api/canvases/:id`, `/api/frames/:id` and
  `/api/comments/:id` (behind the session gate, held until the response closes), the room `join`,
  every MCP tool naming `canvas_id`, `frame_id` or `frame_ids` (`server/toolLoads.ts` wraps
  `registerTool`), resident sweeps and automation pulls, ingest, the local and Gemini agent
  endpoints. `/i/` renders
  read the one frame's HTML (`store.renderableFrame`) instead of loading its canvas. Reading an
  unloaded frame's `html` throws `FrameHtmlNotLoadedError` and starts loading that canvas, so a
  missed entry point fails loudly rather than seeing an empty design; assigning it always works. The
  boot asset-ref reconcile pages through Postgres. Context: by 2026-11-09 frame HTML was 6.4 GB on
  disk and ~11.7 GB of V8 heap (60% of frames hold a non-Latin-1 character, which makes V8 store
  the whole string at two bytes a character), against a 12 GB heap cap. Tests:
  `lazyFrameHtml.test.ts`, `lazyFrameHtmlHttp.test.ts` (a restart, then REST, the room, MCP and an
  idle drop).
- Automations (`shared/automations.ts`, `server/automations.ts`) support schedules and
  approval triggers scoped to one canvas. The five-second worker groups up to ten signed-off
  frames per run. `automation_approvals` retains dispatch receipts independently of the
  pruned run log. Run state stores the approved source identities, frozen steps, current
  step, task ID, summaries and result links; database leases serialize execution. Agent tasks
  and their wait points commit together. The next step waits for completion, checks source
  approvals and access again, and stops on failure or after one hour. Interrupted external
  calls require a destination check rather than automatic replay. Integration-owned action
  hooks create Linear issues or send Slack messages using the workflow owner's connection.
  Approval presets create draft sizes, translations and companion assets on the watched canvas.
  The worker queues independent workflows with concurrency four and keeps discovering work
  while integrations await I/O. Receipt lookup is batched. Later agent briefs include earlier
  draft-result links and completion summaries, so localization can build on generated sizes.

## 4. Canvas Drawing

- Canvas zoom: the camera runs from 8% to 1600% (`MAX_ZOOM`, mirrored by `FOLLOW_MAX_ZOOM`).
  `Stage.tsx` lays the `.world` out at CSS zoom k, the settled camera zoom clamped
  to 1-16, and its transform carries only the camera's movement since (`scale(zoom / k)`).
  Chromium passes k into each frame iframe (and the drag preview) as pixel density, so frame
  documents keep design-px viewports and rasterize at k×, out of process too (a transform on
  the iframe only stretched a 1× raster there); k is the whole number at or above the zoom,
  since the iframe box snaps to whole pixels and only a whole k keeps every design size exact.
  Elsewhere (`FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY` false) each `FrameView` iframe undoes k (`zoom: 1/k`, `scale(k)`); `src/lib/layoutZoom.ts` snaps k to a
  float32 whose inverse multiplies back to exactly 1, since engines multiply zoom in float32.
  WebKit (the desktop app) rasterizes a composited layer at its CSS size, so a transform-only
  scale went soft past 100%. Both engines tile what is on screen, so backing memory follows the
  viewport, not k. From 300% a 1px pixel grid fades in over the frames (full at 500%): the
  Stage draws it over the bare paper, under the world, and each frame draws its own over its
  document and under its chrome (`PixelGrid.tsx`, faded by `--pixel-grid`), so pins, threads,
  grips, cursors and guides stay above it. Tests: `pixelGridBrowser.test.ts`. Frame
  names sit inside their frame, counter-scaled by `--zoom`, so they keep size and gap at every
  zoom and stack with their own frame (a later frame covers an earlier frame's name, never the
  reverse). The selected frame's size badge lives in a screen-space layer (`FrameLabelLayer`),
  placed from `--vx`/`--vy`/`--zoom`. ⇧1 / ⇧2 (fit all / fit selection), frame deep links and
  fly-tos fit into the stage area the top bar and floating panels leave open: `CanvasPage` passes
  `Stage` the `insets` its chrome covers and `fitBox` (`src/lib/viewFit.ts`) centres there.
  Tests: `viewFit.test.ts`, `fitSelectionBrowser.test.ts`.
- View options (`src/lib/viewOptions.ts`, per browser under `doop:view-options`): the zoom pill's
  menu opens on a field for a typed level (`150`, `150%`; `parseZoomPercent`) and switches the
  pixel grid (⇧'), other people's cursors (⌘⌥\ / Ctrl+Alt+\) and the comment pins (⇧C), each read
  by `code` (registry actions `pixel-grid`, `comments`, `cursors`). Hidden pins still show under
  the Comment tool and for a thread that is open. Tests: `viewOptions.test.ts`, `zoomMenu.test.tsx`.
- Live frames (`src/lib/frameLod.ts`, `src/hooks/use-frame-lods.ts`): every frame is an iframe, so
  once the camera settles `Stage` gives a document only to the frames worth one: on screen (a
  quarter screen of margin), at least 96px on their shorter side, the largest first, within a
  per-device budget (12, or 3 on touch). Selected, streamed-into, peer-edited and context-menu
  frames, the frame of a picked element and every frame in prototype mode stay live. The other
  frames on screen are drawn as pictures (`'image'`), frames off screen as `'none'`; zooming out
  never mounts a document. A picture (`FrameImage.tsx`, `src/lib/framePreviews.ts`) is the
  server's render at about the width the frame takes on screen: `/i/<id>.<jpg|png>?lod=<w>&v=<updatedAt>`,
  `w` one of 128 / 256 / 512 / 1024 (`shared/framePreview.ts`, picked from zoom × device pixel
  ratio once the camera settles), png only for standalone shapes. The client keeps one decoded
  picture per frame (object URL and retained decoded image). Its LRU targets 400 entries or
  64 MiB of compressed blobs. On-screen request holders are protected; releasing them enforces
  eviction, even while off-screen components remain subscribed. A wider picture is reused only
  for the same version and format. The old picture stays visible while an edit's replacement
  loads. Cache notifications flush once per animation frame; initial arrivals have no individual
  fade. Requests use `thumbLoader` (six at a time). Network failures, 429 and 503 retry with
  exponential backoff and Retry-After, at most five tries; failed requests can retry after a
  cooldown or when the frame returns. Failure and stale-retry markers are bounded. Until a
  picture arrives a page shows a neutral `bg-paper-deep` well. A frame going live keeps its
  picture over the iframe until the runtime shows the document, then fades it once. The cover
  expires after three seconds if no runtime reply arrives. Deferred client HTML stays deferred;
  the server chooses PNG for standalone elements, including a deferred client's JPEG request,
  and preserves their transparent background.
  Server side (`server/previews.ts`, `server/thumbs.ts`), each width renders at background
  priority and is stored as `thumb/<id>-w<w>-v<renderedAt>.<ext>`. The shared freshness ledger
  (`thumb/_freshness.json`) records versions and HTML/dimension fingerprints. Unchanged images
  survive restarts and position-only moves without rendering. The fingerprint detects an edit
  even if the process stopped before recording its write notification. Legacy unversioned
  objects are served stale and replaced on demand. A missing or unreadable ledger requires
  regeneration on demand; storage writes are best-effort and failed writes may cost another
  render after restart. Old version objects are removed after replacement; deletion runs four
  objects at a time. A crash between an object write and its ledger update can leave an orphan.
  Stored older designs are marked `X-Doop-Preview: stale` and `no-store`; they never enter the
  current-version cache or become immutable under a newer URL. Recently requested variants
  refresh after 15 seconds of quiet following a design write; variants unused for a day expire.
  Frames never requested as images are not pre-rendered. Stage captures are capped at about
  four million pixels. Moving still changes the client's version URL and can re-download the
  same picture, but it does not re-render it. Only a fresh picture under its own `v` is immutable.
  Tests: `frameLod.test.ts`, `framePreviews.test.ts`, `frameImage.test.tsx`, `thumbLoader.test.ts`,
  `thumbs.test.ts`, `previews.test.ts`, `framePreviewHttp.test.ts`, `framePreviewsBrowser.test.ts`,
  `frameLodBrowser.test.ts`, `framePreviewPerformance.test.ts`.
- Canvas panel layout (Settings → Appearance → Canvas panels, `src/lib/panelLayout.ts`, per
  browser under `doop:panel-layout`): `floating` (the default) keeps the islands over a
  full-window stage; `docked` makes Layers, the tool rail, the icon islands, the Inspector /
  element panel and Agents flush columns (`Panel surface="docked"`), the bar a solid strip
  (`TopBar variant="docked"`), and the stage itself the gap between them (`Stage bounds`), so its
  rulers sit on its own edges and fits need no insets. Phones and ⌘. ignore it. `chromeLayout` in
  `CanvasPage.tsx` holds both geometries; docked panels keep the stage at least 320px wide as far as their minimums allow, and ⌘V / image drops centre on the stage (`stageViewportSize`), not the window. Tests: `panelLayout.test.ts`, the docked case in
  `fitSelectionBrowser.test.ts`.
- Stacking (`shared/frameStack.ts`): frames and standalone elements stack per page by `frames.z`
  (nullable double, migration `0043_frame_stack`; unset stacks by `createdAt`), and `canvas.frames` is kept in that order, back
  to front, on the server and in the client store, so "topmost under a point" walks it backwards.
  A new frame lands in front of its page (a frame moved to another page too; undoing a delete
  passes its old `z`). The Layers panel lists the page front first, as Figma does: dragging a
  frame or standalone row between top-level rows (or onto the list's tail, the back) and ⌥↑/⌥↓
  restack it through `restackFrame` (`PATCH /api/frames/:id { z }`, one undo step), with a `z`
  halfway between the new neighbours, renumbering the page when doubles run out of room. An
  element dropped between root rows is lifted out through `stackRoom` + `detachLayer`: a
  renumbering the drop needed is saved first and rides in the detach's own undo step (a
  `stack` entry leading the `transfer`), or stands as its own step when the lift is called off.
  `Stage.tsx` mounts frames in creation order and paints them by `z-index` inside an isolated
  layer, since moving an iframe in the DOM reloads it. Tests: `frameStack.test.ts`,
  `frameStackStore.test.ts`, `layersStack.test.tsx`.
- Page background (`shared/pageBackground.ts`): a page may carry `background` (`#rrggbb`),
  kept across page-list saves the way `startFrameId` is and copied with the page and the
  canvas; `PUT /api/canvases/:id/pages/:pageId/background { color | null }` (edit role) and MCP
  `set_page_background` set it, peers get the page list. `PagePanel.tsx` is the page's own
  settings in the properties slot: with nothing selected, the rail's sliders icon opens it
  (`pagePanelOpen`, kept until closed) in place of the frame Inspector, as Figma's Design panel
  shows "Page" then; its Background `ColorField` edits the active page, one undo step
  (`page-background` history entry).
  `src/lib/paper.ts` resolves the paper a page shows (its colour, else the theme) and its tone;
  `Stage` paints it with contrast dots and a standalone drawing takes its ink from that tone.
  Tests: `pageBackground.test.ts`, the background cases in `storePages.test.ts`, `pages.test.ts`
  and `guideEdits.test.ts`.
- Selection keys (`src/lib/selectionKeys.ts`, chords in `src/lib/keys.ts`), as Figma binds them: ↩
  goes into the selected frame or element (its first layer), ⇧↩ back out to the parent (a root
  layer's parent is the frame; a standalone shape has none), Tab / ⇧Tab to the next or previous
  sibling (frames walk the page's stack the way the Layers panel lists it, wrapping), ⌘A takes
  every unlocked frame on the page or every unlocked sibling of the picked element
  (`store.pickElements`), and ⌘] / ⌘[ step the picked elements, together, or the selected frame
  forward or backward, ⌘⌥] / ⌘⌥[ to the front or back (`reorderElements` / `reorderLayers`,
  `restackFrame`), one undo step each. A picked standalone shape is its page's row: Tab, ⌘A and
  the brackets treat it as a frame, and ⌘A skips stack-locked shapes (`isStackLocked`). ↩ and Tab act only when no control has the keyboard (`isControlTarget`) and
  something is selected, so buttons, menus and the Layers tree keep theirs. The bracket chords are
  read by `code` too, since ⌥ changes the typed character on macOS. Tests: `selectionKeys.test.ts`.
- Cut (`cutSelection` in `src/lib/elementClipboard.ts`): ⌘X and the frame and element menus' Cut
  copy the selection, then remove it the way ⌫ does (one undo step, locked frames and layers stay),
  editors only and only once the copy landed. Tests: `cutSelection.test.ts`, the cut cases in
  `elementContextMenuBrowser.test.ts`.
- Canvas commands (`src/lib/actions/`): every editor command is one entry in `registry.ts` (id,
  label key in the `actions` catalog, menu and section, chords, `edit`, `enabled`, `checked`,
  `run`), and the keyboard (`dispatchActionKey`, called first by `CanvasPage`'s keydown), the ⌘K
  palette (`CommandPalette.tsx`, cmdk through `ui/command.tsx`; text that names no command goes to
  the agent's composer as a prompt), the main menu off the bar's Doop mark (`MainMenu.tsx`: Go to files, then File,
  Edit, View, Object, Text, Arrange, Help) and the ⌃⇧? sheet (`ShortcutsSheet.tsx`) all read it.
  `CanvasPage` lends the registry its modals and panels as the `ActionHost`. Chords (`chords.ts`)
  are `mod` (⌘ on a Mac, Ctrl elsewhere), ⌥ chords by `code`, `macOnly` / `notMac` per platform (⌘Y
  is outlines on a Mac, redo elsewhere), `global` for the two that act from fields (⌘K palette, ⌘/
  agent; a bare `/` opens the agent outside fields). A chord whose command is disabled or finds
  nothing falls through to the browser. ⌫, Esc, ↩/Tab and the arrows stay in `CanvasPage`'s own
  handler (their rules are shown, `hintOnly`). What the commands do lives in `edits.ts`: align /
  distribute / tidy / pack (`arrange.ts`, pure geometry) move frames as one undo step
  (`patchFrames`) and layers through the runtime's `move` geometry edit; ⌘G / ⌥⌘G wrap sibling
  layers in a `div` (carrying a flex parent's flow; grid children are refused; a frame edited while
  its layout is read is left alone) and ⇧⌘G / ⌘⌫ unwrap (`groupElements` / `ungroupElements` in
  `layers.ts`); ⇧A makes a box a flex container, or wraps the pick in one, turning the space between
  the layers into `gap` and dropping their flow margins so nothing moves; ⌥⌘C / ⌥⌘V copy and paste
  computed looks (`doop:computed`), text styles only between text layers; ⇧⌘V / ⇧⌘R paste over or
  replace the selection from the canvas clip (a frame goes only once all its replacements land; one
  undo step, a single `transfer` (`replaceFramesTracked`), so undo never removes a replacement
  before its original is back; tests in `replaceFrames.test.ts`); ⇧⌘U links (`setElementLink`: an
  image or SVG is wrapped in the link, other layers' content is); ⌃C is the EyeDropper. ⌘F / ⌥⌘F is
  the find bar (`FindBar.tsx`, `findText.ts`: text nodes only, locked layers found but never
  replaced, replace-all is one undo step across frames). It is laid out as a palette: one
  `Segmented` for This canvas / Library / All (This page or All pages under This canvas; the
  replace line moves it to the page), results in sections (`bySection` in `findRows.ts`: the
  canvases' matches, then library items, one row per item with its `ItemThumb`, kind, category and
  variant count, `find/FindResultList.tsx`; the page's matches under their frame's name with a
  lock mark, `find/FindTextList.tsx`), and a side pane (`find/FindPreviewPane.tsx`, above the list
  on a phone) with the pointed result large and live, variant chips and Insert / Go to. Keys:
  ↑/↓ walk, ↩ inserts or goes, ⇧↩ goes, ⌥↩ opens the variants, ⌘C copies the id; start, loading
  (skeleton rows) and empty states. The preview (`FindPreview.tsx`, `shared/findPreviewRuntime.ts`)
  plays the item as the canvas does: scripts, CSS animations, transitions and Web Animations run,
  the pane's preview takes the pointer so hover demos react, a clicked link inside is not
  followed, and the runtime pauses what runs while the preview is off screen or the tab hidden
  (`{ play }` message). A library frame the person cannot open is read through
  `/api/libraries/:id/items/:itemId/html`; an insert from a preview the pointer touched snapshots a
  fresh render. Tests: `findBarUi.test.tsx`, `findPreview.test.tsx`, `findPreviewRuntime.test.ts`,
  the motion cases in `findPreviewRuntimeBrowser.test.ts`. View toggles: ⇧' / ⇧C / ⌥⌘\ switch the view
  options (pixel grid, comment pins, cursors), ⌘Y outline mode (an adopted sheet in each frame's
  runtime, never saved or exported), ⌥L collapses the Layers tree. N / ⇧N zoom to the next frame in
  reading order, Home / End bring it into view, PgUp / PgDn change page. Tests:
  `actionRegistry.test.ts` (no chord bound twice per platform, nor over a tool key),
  `actionChords.test.ts`, `arrange.test.ts`, `groupLayers.test.ts`, `findText.test.ts`.
- `src/lib/tools.ts` defines bottom-toolbar tools and shortcuts. `Stage.tsx` delegates drawing
  gestures and world-space previews to `CanvasDrawing.tsx`; Space/middle-button panning takes
  precedence over drawing.
- Zoom tool (Z, keyboard only; math in `src/lib/zoomTool.ts`): a click doubles the
  zoom about the pointer, ⌥-click halves it (the cursor turns to zoom-out while ⌥ is down), and a
  drag zooms onto the box it draws, filling the stage's open area. Z is the tool only while held:
  letting go returns to the previous tool, and the tool rail has no button for it.
  Tests: `zoomTool.test.ts`, the Zoom cases in `tools.test.ts`.
- `src/lib/drawing.ts` creates rectangles, circles, straight and cubic Bézier SVG paths, text and empty
  frames through the existing frame API. Drawing inside a frame appends a positioned HTML/SVG
  layer. Standalone elements use frame persistence with a `data-doop-canvas-element` body marker
  for transparent canvas chrome; no separate shape schema or protocol is required. Pasted and
  dropped images (`src/lib/frameClipboard.ts`) are standalone elements too: one
  `<img data-doop-drawing="image">` named after its file. Agents place one with MCP
  `upload_asset`'s `place` (`{ x, y, page_id, name, width }`, all optional; `{}` auto-places):
  `shared/canvasImage.ts` builds the element for the browser and the server alike,
  `server/imageSize.ts` reads the picture's size from its header (PNG, JPEG with its EXIF turn,
  GIF, WebP, SVG; no image library) and `server/placeImage.ts` creates the frame without a
  reveal or a board task. A local file's placement rides its upload ticket and lands when
  `PUT /u/<token>` receives the bytes. An agent's SVG stays an `<img>`: the vector import needs
  the browser. Tests: `imageSize.test.ts`, `uploadAssetPlaceHttp.test.ts`. A standalone text or path takes its ink
  from the theme the person drew under (`drawingInk`: the dark theme's `--ink`, else `DRAWING_INK`),
  since it sits on the canvas paper; inside a frame the dark ink stays. The Layers
  panel shows one as a single layer at the root (no frame row, no name label on the canvas) and
  its rows drag between frames and the root: a drop on another frame's row moves the element
  there (`transferLayer` in `src/lib/layerEdits.ts`, removing a standalone's shell), a drop on
  the band above a root row or the list's tail lifts it onto the canvas at its rendered spot
  (`detachLayer`, measured through the frame bridge). On the canvas a standalone element moves
  through the frame drag (live, snapping, one undo step) and, let go over a frame, goes into it
  through `moveDrawing`. A layer leaving its frame takes the CSS it
  relies on along (`src/lib/styleCarry.ts`: the matching rules, their keyframes, font faces and
  custom properties, as one `<style data-doop-carried>`, every rule scoped through a
  `data-doop-carried-scope` mark on the moved root so the destination's own layers keep their
  look); copy/paste across frames carries it the same way. Tests: `layerTransfer.test.ts`, `layersDragAcross.test.tsx`, `styleCarry.test.ts`.
- The pen snaps to the nearest anchor on its unfinished path within eight screen pixels,
  highlights the target, and previews a closed curve when approaching the first anchor.
  Alt bypasses snapping. Double-clicking a native path opens `PathEditor.tsx`: anchors and
  Bézier handles can be dragged, and points can switch between corners and curves or be deleted.
  Drawing and editing use 0.75px guide strokes, 5px anchor markers and 4px handle markers at every
  zoom. Invisible 18px editing targets keep the smaller markers easy to grab.
  Each completed edit is one undo step. Alt moves a handle independently; Shift constrains
  its angle. `pathEditing.ts` reads existing line/cubic SVGs, preserves their affine transforms,
  resizes standalone bounds, and refuses to overwrite a concurrently changed path. The editor
  overlays the world canvas while the iframe hides the original through a transient marker.
  It refreshes geometry from the latest store state after saves, undo/redo, and remote changes,
  so an undo issued while a save finishes cannot leave stale anchors in the editor.
  Selecting an anchor or handle does not edit it until the pointer moves two screen pixels.
  Path saves send `expectedUpdatedAt` to the frame PATCH route. The server checks it synchronously
  before writing and returns HTTP 409 with the current frame on a conflict; the editor reloads
  that version without recording an undo step. Frame timestamps advance monotonically, even
  for multiple writes in the same millisecond, so concurrent saves cannot share a version.
  Delayed HTTP save responses cannot replace a newer frame received through the room.
- Saves are serialized, tracked by undo/redo, and scoped to the originating canvas/page. Each
  completed gesture has its own undo entry. The Layers panel shows the drawing's `data-name`.
  Completed saves survive navigation; unfinished drafts are cancelled. Drawing shortcuts leave
  native fields and rich-text editors alone, except for the drawing textarea's keys: ⌘/Ctrl+Enter,
  Esc and a blur all commit the typed text (an empty draft is dropped).
- `ElementMove.tsx` moves a drawing as an unclipped copy under the pointer and highlights the
  destination frame; the original is hidden in its frame (`doop:drawing-moving`) once the copy
  paints, and the copy stays until the frames show the save, so the shape itself follows the drag.
  While anything moves (a drawing, a layer, a standalone shape) its outline, grips and size badge
  stay hidden. Drawings and layers snap to their frame's edges and centre, their parent box and
  their siblings (`snapRects` on the runtime's hit replies) as well as the ruler guides.
  Ordinary HTML/SVG layers move in place through the runtime's geometry/style gesture bridge,
  preserving layout and transforms and committing one undo step per drag. A drag on one of
  several picked layers (or inside one) moves them all: the rest ride the gesture as `followers`
  (`styleGesture` `begin`), each translated by the pressed layer's delta, put back on Escape and
  saved with it as one step; a multi-pick never takes a layout drop, and the pressed layer
  becomes the pick's primary.
  The iframe runtime hit-tests the pointer in browser paint order and measures CSS layout
  size separately from transformed bounds. Pending pointer events are buffered until its
  reply, so fast drags and cancellation remain reliable. `src/lib/drawingMove.ts` preserves markup and translates coordinates when
  moving drawings into, between, and out of frames. Transfers save the destination before
  removing the source and use one undo entry; a failed prerequisite leaves the original intact.
  Rollback keeps a detached copy if its content, name, geometry, page, or flags changed after creation.
- A selected element inside a frame is dressed the way Paper draws a selection: a one-pixel
  outline, a square grip in each corner, grabbable unmarked edges, and a `W × H` badge underneath
  (`ElementResizeHandles.tsx`; geometry in `src/lib/elementResize.ts`). A drag opens the runtime's
  style gesture (`styleGesture` begin / commit / cancel in `frameBridge.ts`), previews inline
  `width` / `height` in the live document on every move and commits once on release as a discrete
  undo step, the same properties the Design panel's Size fields write. Pulling a west or north
  side outward still grows the box (flow layout places the element; the drag changes its size,
  never its place). Deltas are measured from the computed size, so a content-box element keeps
  its padding, divided by the element's render scale, and re-anchored while a pinch owns the
  finger. Shift keeps the aspect ratio (letting go puts the other axis back); Esc, or the grips
  leaving mid-drag, cancels. The runtime's hit info carries `sizable` and `locked`, so inline
  text runs, rotated or skewed elements, locked layers, locked frames and the Comment tool get no
  grips. `tests/elementResize.test.ts` covers the geometry and `tests/elementResizeBrowser.test.ts`
  drags the grips in Chromium.
- A selected frame wears the same furniture as a selected element (`FrameResizeHandles.tsx`,
  geometry in `src/lib/frameResize.ts`): a grip in each corner, grabbable edges, a two-pixel
  ring, all in screen px at every zoom, and a `W × H` badge under the frame in the label layer.
  A west or north pull moves that edge and keeps the far one still; Shift keeps the ratio; the
  dragged edges snap to neighbours and guides (`snapFrame` takes the handle). Frames go down to
  1×1 (`MIN_FRAME_SIZE`, also the Inspector's floor). `tests/frameResize.test.ts` covers the
  geometry, `tests/frameResizeBrowser.test.ts` drags the grips in Chromium.
  The frame Inspector's X / Y / W / H are the same `NumberField` the element panel uses
  (`src/components/ui/property-field.tsx`): the `px` unit is the drag handle (`useValueScrub`,
  Shift ×10, Alt ×0.1, Esc cancels) and ↑/↓ nudge. A drag previews every step through
  `patchFrameLocal` and, through `PropertyScrubContext`, commits once on release as one discrete
  undo step and one PATCH; Esc puts the frame's box back and saves nothing. Tests:
  `inspectorScrub.test.tsx`.
- Frame rotation (`shared/frameRotation.ts`, `src/lib/frameRotate.ts`): a selected frame wears a
  zone just outside each corner (`data-frame-rotate-handle`, 18 screen px, clear of the corner
  grip) that shows Figma's curved double-arrow cursor, turned to curve around its corner and with
  the frame's own rotation (`rotateCursor`, tagged `data-cursor="rotate"`). A drag there turns the
  frame about its centre with the pointer (`startRotate` in `FrameView.tsx`; Shift snaps to 15°,
  Esc puts it back), broadcast live as `frame:drag`'s `rotation` and saved once on release as one
  discrete undo step. `Frame.rotation` is degrees clockwise about the centre, stored in
  `frames.rotation` (migration `0048_frame_rotation`) normalised to (-180, 180] with 0 unset;
  `x`/`y`/`width`/`height` stay the unrotated box and the wrapper carries `rotate()`, so the
  frame's name, grips and pins turn with it. The Inspector's Layout group has the `∠` field, the
  size badge sits under the turned bounds, and a press inside a turned frame
  is turned back into design px (`unrotatePoint`, `frameDesignPoint` for the element move hook and the
  path editor's `frameTurnMatrix`) before the runtime is probed; the frame's own grips pull along
  its axes with the far corner held still (`keepAnchorTurned`) and do not snap while turned. MCP `update_frame`
  takes `rotation` through `server/pageTools.ts` (normalisation and page validation), and
  `get_canvas` lists it when set; copy, paste and duplicate
  (`frameClipboard.ts`) carry it. A drawing dragged in, out of or between turned frames lands
  through `turnedDropRect` (its centre carried through each frame's turn), and a turn whose frame,
  page or canvas goes mid-drag ends unsaved. Not yet turned: marquee selection,
  snapping and exports read the unrotated box. Tests: `frameRotation.test.ts`,
  `frameRotationHttp.test.ts`, `frameRotateBrowser.test.ts`.
- Element rotation (`src/lib/elementRotate.ts`): an element inside a frame wears the same rotate
  zones (`data-rotate-handle` in `ElementResizeHandles.tsx`); a drag there turns it about its centre
  through the runtime's `rotate` geometry edit inside a style gesture (preview per move, one
  discrete save on release, Shift snaps to 15°, Esc cancels), the same way the Design panel's
  Rotation field sets it. The runtime reports an element's own turn (`ownRotation`: its `rotate`
  plus a plain 2D `transform` angle; skew, flip and 3D stay out) and its box before that turn
  (`box`, via a uniform render scale read off the turned bounds) in hit info, `inspect` and
  `doop:locate`; `selectionBox` draws the outline, grips and zones on that box, centred on the
  bounds and turned with it, so a turned layer keeps its grips and resizes along its own axes
  (`derotateDelta`; no guide snapping while turned). `sizable` now admits the element's own turn
  and still refuses a turned, skewed, 3D or nonuniformly scaled ancestor; unsupported transforms
  use the axis-aligned rendered bounds for the selection outline. The element toolbar lifts to 30px above a
  selection wearing furniture, clear of the top zones. Tests: `elementRotate.test.ts`,
  `elementRotateBrowser.test.ts`, the turned cases in `elementResizeBrowser.test.ts`.
- Rulers and guides (`src/components/Rulers.tsx`, math in `src/lib/rulers.ts`): ⇧R or the zoom menu
  toggles `<canvas>` rulers docked on the stage's top and left edges (the top bar and the floating
  chrome step in by `RULER_PX`) (remembered under
  `doop:rulers`, hidden on phones and under ⌘.). Ticks step 1/2/5×10ⁿ by zoom; labels count from the
  selected frames' top-left, whose extent is highlighted. Dragging out of a ruler adds a guide;
  guides drag, drop back on their ruler or Delete to remove, and undo/redo (`history.ts` `guide`
  entries). Guides live in `canvases.guides` (jsonb, per page, client-generated ids), written one
  at a time through `PUT`/`DELETE /api/canvases/:id/guides/:guideId` behind `requireCanvas` and
  broadcast as `guide` room messages; page copies and canvas copies take them along (within
  `MAX_GUIDES`), a deleted page drops its guides and page undo/redo puts them back. Writes to
  one guide run in order, and a failed one rolls back only when no newer edit follows. Visible
  guides join `snapFrame` (frame move/resize, element moves), element resize and drawing points
  at the same 8-screen-px tolerance; Alt bypasses. Tests: `rulers.test.ts`, `snapGuides.test.ts`,
  `guides.test.ts`, `guideEdits.test.ts`, `rulersBrowser.test.ts`.
- SVG import (`src/lib/svgPath.ts`, `src/lib/svgImport.ts`): an SVG pasted, dropped or pasted as
  markup lands as editable vector layers, not an `<img>`, the way Figma imports one. Every
  `path`/`rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon` is baked (transforms, nested
  `viewBox`es, `<use>` and `<symbol>` expanded, the whole `d` grammar including arcs and
  quadratics turned into absolute cubics) into one `svg[data-doop-drawing="path"]` with a single
  `path` child; `<g>` nesting becomes `div[data-doop-drawing="group"]` rows; text and images stay
  as `svg[data-doop-drawing="svg"]` layers; gradients, clips, masks and filters ride in a
  `[data-doop-defs]` host with the import's id prefix, user-space gradients and clips copied with
  the shape's transform folded in. Paint comes from the browser's computed styles
  (`importSvgInBrowser` mounts the file in a closed shadow root, so `<style>` rules, classes and
  `currentColor` resolve and leak nowhere); `importSvgMarkup` reads attributes alone for tests.
  Scripts, handlers and `foreignObject` are dropped. The element's shell is the ink's box; layers
  sit in it by percentage so the shell's grips scale them. A one-shape file is a bare pen-style
  path. Entry points: `splitIncoming` / `pasteFilesCentered` / `dropFiles` in
  `src/lib/frameClipboard.ts`, wired in `CanvasPage`'s paste and drop: bitmaps and vectors brought
  together land in one row (a vector keeps its proportions, a bitmap gets at least a 40px box) and
  whatever lands is one undo step even when a sibling request fails. Shape lengths resolve their
  units and percentages (`parseLength`, against the nearest `viewBox`); transforms come from the
  style reader (a stylesheet's `transform` wins) about `transform-origin`; the root's own
  opacity, clip, mask and filter stay on the root group, a group's mask and filter on its row, and
  copied definitions (gradient stops, clip shapes) keep the styles they resolved. A clip or mask
  drawn in user units gets a copy carrying the transform baked into the shape it clips (`bakedClip`
  / `bakedMask`; a mask's content rides in a `<g>`, since `<mask>` takes no transform); one in
  bounding-box units is used as it is. A text or image layer keeps the `clip-path`, `mask` and
  `filter` its stylesheet gave it, and its own opacity goes on the layer's svg alone. Tests:
  `svgPath.test.ts`, `svgImport.test.ts`, `svgImportBrowser.test.ts`.
- PDF import (`src/lib/pdfImport.ts`, `src/lib/sfnt.ts`, proof of concept): a PDF dropped or pasted
  on the canvas lands as one frame per page at the page's printed size (points × 96/72). MuPDF's
  WebAssembly build (`mupdf`, AGPL, a lazy 10 MB chunk excluded from Vite's pre-bundling so it finds
  its `.wasm` by `import.meta.url`) reads the file in the browser. Each page is rendered to SVG in
  CSS px with its text stripped and run through `importSvgInBrowser` with `box: 'root'` (the page is
  the box, since clipped backgrounds reach past it) and a raised layer budget, so paths, gradients,
  clips and images become the same editable layers an SVG gives; a CMYK JPEG is decoded through the
  page and re-encoded as RGB, and in the browser every picture becomes an `/a/` asset. The text comes
  from MuPDF's structured text (ligatures kept), one `<p data-doop-drawing="text">` per run of one
  font, size and colour, placed by the glyph box, rotated runs turned about their first glyph.
  Fonts are keyed by font object, not name: a producer embeds several subsets under one name
  (InDesign, per page), so a page's font resources (Form XObjects included) are paired with each
  object by name and, where several programs share it, by comparing FreeType's advances for the
  glyphs shown. The program is then completed into a loadable OpenType file: `sfnt.ts` adds the
  `OS/2`, `name`, `post` and Unicode `cmap` tables a PDF subset drops (the cmap from the glyphs the
  page drew, ligature glyphs voted out of the plain letters), wraps a bare CFF program (`Type1C`,
  CID-keyed charsets inverted) with synthesised `head`/`hhea`/`hmtx`/`maxp`, and the browser's own
  `FontFace` check drops anything it still refuses. Faces ride in the frame as `@font-face` data
  URIs named `pdf-<BaseFont>`; Type1 programs and unembedded fonts fall back to the spaced family
  name over a generic from the descriptor flags, with weight and style synthesised. Not yet:
  paragraphs (every run is its own line), fonts as library assets instead of data URIs, an
  Import-picker card, a static-image fallback for scans and a progress indicator. Tests:
  `pdfImport.test.ts` (fixture `tests/fixtures/pdf/report.pdf`, a Chrome-printed page with five
  embedded subsets), the page count in `imagePaste.test.ts`.
- The path editor (`PathEditor.tsx`, `src/lib/pathEditing.ts`) edits any `d` the parser reads,
  compound paths included (`EditablePath.subpaths`; anchors are numbered flat across strokes);
  clicking the outline splits the segment there (`splitSegment`, a line stays linear in `t`);
  deleting the last-but-one anchor of a stroke removes the stroke when others remain. The runtime's
  `doop:path` probe finds a shape inside an imported group (no standalone-root collapse) and
  reports `parentBox`; `updatePathFrame` keeps a grouped shape in percentages of its group and
  grows the group (the standalone's frame, or the root's px box inside a frame) around a point
  dragged past its edge, re-placing the sibling shapes. Cursors follow Figma's (`cursor-pen*`,
  `cursor-node`, `cursor-handle` utilities in `src/styles.css`, each SVG tagged `data-cursor`): the
  Path tool wears the nib, with a ring over the first anchor (close) and a square over one it
  already placed (`penCursor` from `useCanvasDrawing`, forced over frames by `Stage`); the editor
  shows a node badge on anchors, a dot badge on handles and the pen with + on the outline.
- `tests/drawing.test.ts` covers geometry, serialization and persistence. Four browser files
  exercise the toolbar and gestures in Chromium on one shared page setup (`tests/drawingPage.ts`):
  `drawingShapesBrowser.test.ts` (the tools, Bézier paths, text, mobile input),
  `drawingMoveBrowser.test.ts` (dragging and copying layers, cancellation),
  `drawingReorderBrowser.test.ts` (groups, reparenting, reordering, delayed hit-test replies) and
  `drawingGeometryBrowser.test.ts` (transformed shapes, stacking, canvas comment pins and reply
  fields). They are separate files so CI's shards can share them out: vitest assigns a file to a
  shard by the hash of its path, and these four names land in four different shards.
  `tests/drawingMove.test.ts` covers transfer persistence, locks, failed saves and rollbacks,
  creation queued with transfers, and undo/redo. Browser regressions cover transformed shapes,
  stacking contexts, covered shapes, and delayed hit-test replies.

- Comment anchors (`shared/comments.ts`): an element comment is `frameId` + `elementId` (the
  element's `data-doop-id`) + `snippet`; a frame comment is `frameId` + design-px `x`/`y` and no
  `elementId` (the Comment tool makes one on the frame's background, or from its name, which
  outlines the whole frame on hover and pins the comment just inside its top-left corner); a canvas comment is `pageId` + world `x`/`y`. One whose element is gone keeps the
  frame and snippet only and is listed without a pin. The browser still sends the runtime's
  positional selector (plus `elementId` when the element already wears one, and always the
  point); the server stamps and stores the id. `FrameView` places pins by
  `doop:locate` on `[data-doop-id="…"]`. Comments stored before element ids carry their old
  selector in the `selector` column, which `actions.backfillElementIds` resolves once after the
  server starts listening, frame by frame with awaited, ordered writes (the stamped frame, then
  the comments naming its ids); unresolvable paths become lost anchors, a row that throws or a
  frame write that fails is logged and left for the next boot. Tests: `elementIdBackfill.test.ts`.
- Agents answer in the thread (`server/resident.ts`): a resident run about `@mentioned` comments
  posts its closing summary as the agent's reply in each thread (one message per thread) before
  resolving it, and a failed run posts the reason and marks the comment failed for a retry
  (`settleComments`). The kickoff lists each comment's id, and the resident has
  `reply_to_comment` and `resolve_comment` as tools (`replyInThread`: this canvas only, never
  metered, a resident `@mention` in the agent's words becomes a plain name through
  `withoutMentions` so it cannot queue itself); a thread the agent answered itself gets no
  second reply from the summary. A question the agent needs answered first is
  `reply_to_comment` with `awaiting_answer`: when the run ends the request is handed back
  (`actions.handBackComment`: unclaimed, no longer an agent item in memory and in its row, the thread open), so the
  person's `@mention` answer queues fresh work carrying the whole conversation. MCP agents have
  had the same two tools all along. Tests: `residentComments.test.ts`, `agentToolParity.test.ts`.
- Comment pins move by drag (`src/lib/commentMove.ts`, gesture in `CommentPin`): anyone who may
  comment drags a thread's root pin; a ghost rides the pointer in the world layer
  (`CanvasComments`), above every frame, since the pin itself sits inside a clipped frame surface.
  On release the drop point is resolved in order: the topmost visible frame under it is probed
  (`doop:probe`) for an element, else the frame as a whole at that design point, else the canvas
  at that world point, so a thread changes kind either way (element → canvas comment and back).
  `PATCH /api/comments/:id/anchor` (comment role; `CommentAnchorInput` in `shared/comments.ts`)
  re-anchors the root and its replies together and broadcasts each; a drop on the same anchor
  sends nothing, Esc mid-drag puts the pin back. Tests: `commentMove.test.ts`,
  `canvasCommentsRoute.test.ts`, `elementIds.test.ts`, the drag case in `drawingGeometryBrowser.test.ts`.
- Components (`.workflow/specs/components.md`): a main is an element marked `data-doop-component`; an
  instance is full markup marked `data-doop-instance`, so frame consumers need no changes. Every
  frame write passes `prepareFrameHtml` (`server/components.ts`): `<doop-use>` expands, a changed main
  becomes a revision, instances reconcile against the revision they were rendered from
  (`server/componentEngine.ts`) and upgrade. `actions.propagateComponents` carries a change across the
  canvas. The components pass runs first on every write, then `withLibraryFaces`, so an expanded
  `<doop-use>` naming a library family gets its face. Agents read and write the short form
  (`get_frame`, `edit_frame_html`); tools live once in `server/componentTools.ts` for MCP and the
  resident agent. `src/lib/components.ts` and `ComponentsPanel.tsx` (the Layers panel's Components
  tab, beside Tokens) / `ComponentSection.tsx` are the editor's side. A component is renamed from its card's menu
  or a double-click on its name in that tab, or from its main's Layers row (`renameComponent`; instances are
  linked by id, so they follow); an instance's row is not renamed on its own. Stored in `components`
  (migration `0052_components`). Tests: `components.test.ts`, `componentsEdgeCases.test.ts`,
  `componentTools.test.ts`, `componentsRoutes.test.ts`, `componentsBrowser.test.ts`.
- AI library curation (`shared/libraryCuration.ts`, `server/libraryCuration.ts`,
  `server/libraryCurationApply.ts`, `server/libraryCurationRoutes.ts`, spec section "AI curation"):
  several source canvases become ONE proposed library. Gathering reads frames one at a time
  (`renderableFrame`), drops section/title/index frames by the source's rules, folds duplicates
  (`htmlSignature`, or label + text across sources) and groups a family's cards. The person's own
  account (`accountTurnModels` in `server/agentModel.ts`: default connection, else the first one on;
  never the server tier) proposes the tree (`parseTree`: three levels, cleaned names, capped
  leaves; one retry, else `heuristicPlan` from the tidied page names) and its small tier files 60
  items a call, three at once (`parseAssignments`; retry, split, second pass, then unclassified;
  400 calls at most). Jobs live in `library_curations` (migration 0068, one JSON document), resumed
  at boot. Review edits are pure (`editPlan`), the view is `planView`. Apply makes a new canvas,
  pages named by category path (the page rule reads them back), shelf-packed copies, then
  `createLibrary`; recorded per copy, idempotent. REST `/api/library-curations`; tools
  `start_library_curation` / `get_library_curation`. "Start empty": `POST /api/libraries/new`,
  `POST /api/libraries/suggest-categories` (`suggestCategories`). Tests: `libraryCuration.test.ts`,
  `libraryCurationApply.test.ts`, `libraryCurationHttp.test.ts` (real server, the owner's Claude key on a
  stub Messages API via `ANTHROPIC_BASE_URL`), `libraryCurationTools.test.ts`,
  `libraryStartEmpty.test.ts`, `curateLibraryUi.test.tsx`, `newLibraryUi.test.tsx`.
- Library duplicates (`shared/libraryProvenance.ts`, `server/libraryDuplicates.ts`): items carry
  `source_key` (normalised page URL from `doop-import-source` / `data-doop-source-url`) and `origin`
  (`data-doop-origin`, written on every import and curation copy) in `library_items` (migration
  0069). `findDuplicates` checks candidates against every library the person can use: same-url,
  same-content (origin, or the family hash under that library's rules), similar (word Jaccard ≥
  0.8). `runImport` leaves matches out (`report.duplicates`) unless `force` / `asVariantOf`; `POST
/api/libraries/check` and the read-only tool `check_library` answer "do we have it?". Tests:
  `libraryDuplicates.test.ts`, `addToLibraryUi.test.tsx`.
- Design libraries (`.workflow/specs/design-libraries.md`, plan in `.workflow/archive/design-libraries/tasks.md`):
  a canvas is a library when it has a `libraries` row (migration 0066: `libraries`, the rebuildable
  projection `library_items`, the curation `library_item_meta`), mirrored on `canvas.library`
  (`LibraryInfo`) and broadcast as a `library` room message. `shared/library.ts` (types,
  `effectiveItem`), `shared/libraryIds.ts` (the id grammar, `splitFrameName`, `parentIdOf`),
  `shared/libraryRules.ts` (`LibraryRules`, presets `blank` and `sheets`, strict parser),
  `shared/librarySearch.ts` (the in-memory index: BM25 over weighted fields, prefix and one-edit
  matching, filters, facets, families). `server/libraries.ts` keeps the rows and is the one gate
  (`libraryRole`: read / curate / manage, on top of `canvasRole`, which is not changed);
  `server/libraryExtract.ts` reads one frame's items over parse5 (`server/libraryDom.ts`, a small
  selector engine for rule selectors); `server/libraryIndex.ts` keeps the projection in step
  (full runs 50 frames at a time through `store.renderableFrame`, resumed at boot; one frame 1.5 s
  after `store.onFrameWrite`; the search index built on first use, dropped after 10 idle minutes).
  Two passes: the static one reads the HTML (no browser); the rendered one (`renderedPass`, at most
  2 background pages, 1.7 s for late scripts) runs `shared/libraryCollect.ts` in the headless page
  to read a scripted sheet's variants and every item's box. Variants only the page shows carry an
  `r:` hash and are kept across static reindexes until the next rendered pass.
  Item images: `GET /api/libraries/:id/items/:itemId/thumb.jpg?v=<tag>` (`server/libraryThumbs.ts`),
  the tag a digest of `THUMB_VERSION`, the item's hash and its box, stored under
  `lt/<canvasId>/<safe id>-<id digest>-<tag>.jpg` (storage's key check admits that one folder) and
  served immutable for its tag. What it shows (`server/libraryThumbClip.ts`,
  `server/libraryThumbRender.ts`): a page probe (source string) finds the item's element (box,
  `data-doop-id` or anchor; no box pictures the frame) and walks down past text-only rows naming
  the item and short caption rows to the demo; the viewport widens when the demo lies past it (a
  card cut from a wider sheet); fonts, a settle (1.8 s background, 1.2 s interactive), a pointer
  brought to the demo's centre, CSS and Web Animations moved past their first frame; then sharp
  trims the demo's own background (corner colour, edge band ignored) and frames the rest at 4:3
  on it, 640x480 JPEG. A key being rendered is one shared promise; the items of a frame render on
  one page. The prewarm (`server/libraryThumbQueue.ts`) renders what storage lacks
  (`hasObject`) after an index run settles (`onLibraryIndexed`: full run and its rendered passes)
  and at boot: one job per library, gallery order first, at background priority across every
  library (`RENDER_BACKGROUND_CONCURRENCY`, default 2, always below `RENDER_CONCURRENCY`), a busy
  renderer waited out; progress rides on `LibraryInfo.thumbs` (`{ ready, total, running }`).
  The route's `requestThumb` awaits a render in flight or renders at interactive priority, a few
  at once, else 503 with Retry-After 2 (10 when the renderer itself is busy); 404 when the frame
  is gone. `ItemThumb` fetches only while on screen, six at a time (`src/lib/thumbLoader.ts`),
  shows a skeleton, retries a 503 after Retry-After with backoff (five tries) and crops the frame
  preview only on a real failure; the gallery polls "Preparing previews · N / M".
  `scripts/library-thumb.ts` renders one item from an HTML file, before and after. Tests:
  `libraryThumbs.test.ts`, `libraryThumbQueue.test.ts`, `libraryThumbClip.test.ts`,
  `itemThumb.test.tsx`.
  Two insert paths, one block (`shared/libraryBlock.ts`, `data-doop-ref` / `-ref-lib` / `-ref-rev`):
  ⌘F snapshots in the browser's preview iframe; the gallery and agents call
  `POST /api/libraries/:id/items/:itemId/insert` (`server/librarySnapshot.ts`), which runs the same
  preview runtime and snapshot (`shared/findPreviewRuntime.ts`, `shared/librarySnapshot.ts`) in the
  headless browser, or, without one, reads the element by parse5 and keeps the frame's `<style>`
  blocks whole under the scope (`fidelity: 'static'`). Either is one ordinary design write.
  The gallery (`/libraries`, `/l/<id>`, `/l/<id>/i/<item>`: `src/pages/Libraries.tsx`,
  `src/pages/LibraryPage.tsx`, `src/components/library/*`, view in the URL via `src/lib/libraryQuery.ts`,
  a windowed grid through `src/hooks/use-windowed-grid.ts`) and the Layers panel's Library tab
  (`LibraryPanel.tsx`, shown once the person has a library; its pick is kept per browser under
  `doop:library-panel`).
  Rules live on the library row (`libraries.rules`, versioned, read through `parseLibraryRules`); only
  a manager (`canManageCanvas`) changes them, from the gallery's Settings sheet
  (`LibrarySettings.tsx`, `LibraryRulesForm.tsx`: one card per rule group, a dry run of the edited
  rules 400 ms after the last edit), and a change bumps `rules_version` and reindexes.
  Agents write to a library through `import_to_library` and `set_library_item` only while
  `AGENT_LIBRARY_WRITES` is true (the default; false answers with the same "curated by people"
  refusal as `AGENT_GUIDELINE_WRITES`), with the curate role, and a resident run only on the library
  it works on; no tool changes rules, visibility or whether a canvas is a library.
  REST under `/api/libraries` (`server/libraryRoutes.ts`, 30 searches per 10 s per account; never
  `store.load`); agent tools in `server/libraryTools.ts`, registered for MCP and the resident agent
  under the same names. ⌘F's Library scope (`src/lib/findLibrary.ts`, `src/lib/findRows.ts`,
  `src/components/find/FindResultList.tsx`) and File → Turn into a library
  (`src/components/library/ConvertToLibraryModal.tsx`). ⌘F everywhere (`GET /api/find`) and MCP
  `find_in_canvas` without `canvas_id` answer a library from its index (`findInLibrary` in
  `server/libraryQueries.ts`: its items as `name` hits carrying `item`), so a search across canvases
  never loads a library's frame HTML; other canvases are searched as before (`canvasFindEverywhere.test.ts`).
  `scripts/pull-library.ts` copies a library canvas between two instances over their `/mcp` (agent
  keys from `DOOP_FROM_KEY` / `DOOP_TO_KEY`, the source only read, `/a/` assets re-uploaded,
  resumable; `scripts/README.md`, `pullLibrary.test.ts`).
  AI descriptions (`server/libraryDescribe.ts`, migration 0067): off per library until a manager
  turns on Settings → "Describe thin items with AI" (`libraries.describe_items`; while off no model
  is called). Then each item whose description or tags a person left empty gets one vision call on
  its thumbnail, paid by the library canvas's owner as an image description is (`describerFor`:
  their connected model, else the server's; their image-description Off stops it too), at most 200
  a library per UTC day (in memory). Results sit in `library_item_meta.suggested`: searchable at
  once, shown in the inbox with Accept / Dismiss, written as the item's own only when accepted.
  Tests: `libraryDescribe.test.ts`.
  Tests: `library*.test.ts`,
  `librariesHttp.test.ts`, `findLibrary*.test.ts*`, `findRows.test.ts`, `convertLibraryUi.test.tsx`.
- Prototypes (`.workflow/specs/prototyping.md`): interactions are `data-doop-on` /
  `data-doop-action` (or the JSON `data-doop-interactions`) attributes in frame HTML, parsed by
  `shared/prototype.ts`, whose parser the frame runtime inlines by source. `PrototypePlayer.tsx`
  (Play, and the full-page `/c/<id>/proto`) runs them with Web Animations transitions, under the
  desktop tab strip (`--app-inset`), scaled by the viewer's pick (actual size, responsive, fit width,
  fit, fill; `screenLayout`, remembered under `doop:proto-scaling`); the
  Prototype tab and `PrototypeOverlay.tsx` edit and draw them; MCP has `get_prototype` and
  `set_prototype_start`. `tests/prototypeBrowser.test.ts` drives the player in Chromium.
- Motion Studio ("Rostrum", `.workflow/changes/motion-studio-backend`, backend MVP): a page carries a
  composition — duration, fps, output size and tracks (camera keyframes over the world, per-element
  properties, clips, audio, captions; `shared/motion.ts` is the wire contract, `docs/motion-api.md`
  its documentation). `shared/motionRuntime.ts` maps time → frame state as a pure function
  (frame-authored motion blocks first, element tracks override, semi-open clip windows), and
  `shared/motionLint.ts` rejects non-seek-safe markup (MO-* rules: wall clocks, free-running loops,
  unseeded random, CSS animations, GSAP, seek-time network, autoplaying media). Server side:
  `compositions`/`composition_versions`(≤20)/`render_jobs` tables (migration 0071), write-through
  in `server/db/persist.ts`, copy-with-remap on page/canvas duplication in `server/store.ts`,
  actions + broadcasts (`composition`, `composition:playhead`, `render:progress`) in
  `server/actions.ts`, REST under `/api/canvases/:id/pages/:pageId/composition` and
  `/api/renders/:id` (upload sniffs mp4/webm into `/a/` assets) behind the canvas view/edit gates.
  Render jobs are claimable records (`server/motionJobs.ts`): the browser renders via
  MediaRecorder/WebCodecs, or the desktop shell renders deterministically —
  `desktop/src-tauri/src/motion.rs` drives a hidden webview through the page's seek/capture hooks
  and encodes with an allowlisted local `ffmpeg` (`__DOOP_MOTION_RENDER__`, capability
  `motion-render.json`); `src/blender.rs` spawns the disabled-by-default (`DOOP_BLENDER_BRIDGE`)
  allowlisted blender-mcp process and relays server-queued ops behind read/write/render grants.
  MCP tools (`server/motionTools.ts`, parity in
  `server/resident.ts`): `get_composition`, `set_composition`, `animate_storyboard`, `lint_motion`,
  `render_composition`. Phases 2 to 5 (`feat/motion-backend-next`): transitions, camera presets,
  text animators, `3d` clip sources with a scroll/pointer driver, `scene_media` (speed, cuts,
  beats, transcript, recipe, ducking, captions), `generate_video`, the speech engine
  (`server/speech*.ts`, `desktop/src-tauri/src/speech.rs` — the `diazo-speech` sidecar and the
  Pocket TTS weight mirror are designed, not yet shipped; `docs/speech-mirror.md`), the Blender
  op relay (`server/blender*.ts`, approvals in `desktop/src-tauri/src/blender.rs`), `blender` and
  `server` render targets — the server target renders on the instance's own headless Chromium at
  background priority under 60 s / 1080p / 30 fps / one-per-account caps, off with
  `SERVER_RENDER_DISABLED` (`server/motionRender.ts`) — Lottie and HyperFrames interchange
  (`shared/motionInterchange.ts`, `GET …/composition/export?format=`, `POST …/composition/import`),
  and the motion duel (`POST …/motion-duels`: one storyboard page copied per pick,
  `model_duels.kind = 'motion'`). Tests: `motion.test.ts`, `motionPhase2.test.ts`,
  `motionMedia.test.ts`, `motionHttp.test.ts`, `motionPhase5.test.ts`, `blender.test.ts`,
  `motion::tests`, `blender::tests`, `speech::tests`.
  `render_composition`. Element layers (motion-elements P0, backend): an element track with an
  effect stack, a non-normal `blend`, a `matte`, `masks` or `layer.mode: 'on'` promotes to a
  layer — `shared/motionLayers.ts` `planLayers` decides promotion, static vs dynamic raster
  content, compositor vs CSS transforms, effect-driven padding (`layerPad`), texture scale,
  composite order and the layer budgets (lint MO-15..19), with the measured half of the plan
  (`LayerGeometry`) left to the browser engine; `shared/motionBlend.ts` holds the 26 colour blend
  modes' CPU reference (`blendPixel`, `compositePixel` on premultiplied pixels) and `BLEND_GLSL`
  indexed by `BLEND_MODES` position; `shared/motionElementPresets.ts` compiles 56 seeded element
  presets plus `staggerOffsets` to ordinary keyframes; the effect tools take
  `frame_id`+`element_id` and auto-create the track, and `set_layer`, `get_layer_plan` (the static
  plan only — geometry reports `unavailable`), `list_element_presets` and
  `apply_element_preset` run through `execMotionPro` on MCP and the resident agent;
  `lintComposition` adds MO-15/19/20/21 and `check_scene` reports `layers` and `motion_variety`;
  `createRenderJob` refuses an MO-15 film at creation and the headless renderer picks SwiftShader,
  real GPU or no-3D Chromium flags from `RENDER_GL` (`server/env.ts`, `server/screenshot.ts`,
  default `swiftshader`). Tests: `motionLayers.test.ts`, `motionBlend.test.ts`,
  `motionElementPresets.test.ts`, `motionProTools.test.ts`. The browser layer engine and editor
  UI are P0-FE, not this change. `server/storyboard.ts` is the storyboard read `animate_storyboard` adds to
  each shot — the frame's notes (elements labelled mouvement / transition / son / voix off / notes,
  or the English words, by text or by markup) and its animatable elements with `data-doop-id`s
  stamped in one pass through `server/elementIds.ts` `stampElements` and committed like a comment
  stamp (`server/actions.ts` `commitElementStamps`); `set_composition` writes back the `storyboard`
  notes check — noted shots still without an element track, over two fix passes. Tests:
  `motion.test.ts`, `motionHttp.test.ts`, `storyboard.test.ts`, `storyboardAgent.test.ts`,
  `motion::tests`, `blender::tests`.

- Motion Studio UI (`src/components/motion/`, `src/lib/motion/`, contract `docs/motion-api.md`):
  the bar's Motion button mounts `MotionTimeline` over the stage for the active page (transport,
  ruler, camera lane, shots, element lanes, one playhead, collaborators' playheads). The room is
  the source: `init.canvas.compositions`, `composition` and `composition:playhead` messages land
  in `src/lib/motion/store.ts` (src/lib/ws.ts); REST answers a page the room has not mentioned.
  `src/lib/motion/contract.ts` re-exports `shared/motion.ts` / `shared/motionRuntime.ts` and
  resolves `token` easings from the CSS custom properties. The player owns the clock: each tick
  calls `frameStateAt`, moves the editor's view (`stageCamera.ts`; reduced motion cuts key to key),
  and sends each page frame its element-track values (`elementCss.ts`) with `--t` and a
  `doop:seek` event through the runtime's `doop:motion` message (an adopted sheet, never saved).
  "Key the camera here" sends `set_camera`; "Animate storyboard" queues a board card asking the
  resident agent to animate every shot per the notes `animate_storyboard` extracts — element
  tracks on the reported `data-doop-id` targets, camera moves, captions, TODO marker clips. Writes
  are `PATCH …/composition`
  ops with `expectedRevision` (409 reloads). Export (`MotionExportDialog.tsx`): `POST …/renders`,
  then `renderInBrowser` (the compositor, `compositor.ts`, paints each frame from `t`: still frames
  rasterised once, frames with element tracks or seek-safe scene markup re-rasterised per frame
  from their HTML with the values and `--t` written in; MediaRecorder records in real time, so a
  slow paint stretches the browser render) or `renderOnDesktop` (`motion_render` drives
  `/c/<id>/motion-render`, `MotionRenderHarness.tsx`, through `__doopMotionSeek` /
  `__doopMotionCapture`), uploaded to `PUT /api/renders/:id/upload`. Limits: camera rotation shows
  only in renders; spring tokens written as `linear()` resolve to linear. Tests:
  `motionStudio.test.ts`, `motionElementCss.test.ts`, `motionTokens.test.ts`.

## 5. Security and Secrets

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft /
  Apple sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` / `APPLE_*` client pairs; the iOS app
  signs in with Apple natively against `APPLE_APP_BUNDLE_IDENTIFIER`). Configuration and secrets
  (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, provider client IDs/secrets) come from the
  environment (`.env`, documented in `.env.example`); never committed.

- Credentials kept for users are encrypted at rest (`server/secretBox.ts`): `sealedText` columns
  in `server/db/schema.ts` (model-account keys and tokens, integration and GitHub tokens,
  Linear/Slack installs, webhook secrets) are AES-256-GCM sealed on write and opened on read, so
  call sites see plaintext. Keys come from `SECRETS_ENCRYPTION_KEYS` (`id:base64`, first one
  active; dev and tests use a built-in key, unset in production stores plaintext and warns). After
  boot `resealSecrets` (`server/secretBackfill.ts`) seals legacy plaintext and re-seals rows under
  a rotated-out key. Never filter on a sealed column; each write uses a fresh IV. better-auth seals
  social sign-in tokens itself (`account.encryptOAuthTokens`). Sync-key secrets, APNs tokens and
  MCP OAuth tokens stay plaintext (looked up by value). Tests: `secretBox.test.ts`.

- Reading a failed auth call (`src/lib/authError.ts`): only our own API sends a string
  `error.code`, so `authErrorCode` is what `AuthPage.tsx` matches on and `authErrorMessage`
  is what it shows. Railway's edge answers in its own shape whenever it cannot reach the
  container (every deploy restart) — `status`, a NUMERIC `code`, `message`, `request_id` — and
  better-fetch spreads that body into `error`, numeric code and all, so a code match that called
  a string method on it threw inside the submit handler and left the form silent. A code that is
  not a string matches nothing, and such a message (`Application failed to respond`) becomes a
  plain try-again rather than being shown. Tests: `authError.test.ts`,
  `authFormBrowser.test.ts` (the real form in Chromium, against that exact edge body).

- Account deletion: Settings → Your account ends with a Delete account card
  (`src/components/DeleteAccount.tsx`) and the iOS app has the same action; both call better-auth's
  `POST /api/auth/delete-user`, with the password when the account has one (`list-accounts` shows a
  `credential` provider), else on a fresh session. The `beforeDelete` hook
  (`server/accountDeletion.ts`) deletes canvases only that user could reach and leaves the rest.
  Tests: `accountDeletion.test.ts`, `deleteAccount.test.tsx`.

- Sign-in policy (`shared/instanceSettings.ts`, `server/instanceSettings.ts`): instance admins set,
  in Admin → Sign-in, whether visitors may sign up with email and password (off hides the form and
  the `/api/auth/*` mount refuses `sign-up/email` with `SIGNUP_DISABLED`; existing accounts still
  sign in, provider sign-ups are untouched), whether signed-out visitors go straight to the OIDC
  provider (`AuthPage` starts the round trip on mount; never after a provider error, under
  `?manual=1`, or in the desktop shell), and a default workspace every new account joins as a member
  (`joinDefaultWorkspace`, in the user-create hook, or on verification when SMTP is on, like
  invites). One row in `instance_settings` (migration 0050), read into memory at boot;
  `GET /api/oidc-config` adds the public half as `emailPasswordSignup` / `ssoAutoRedirect`;
  `GET`/`PATCH /api/admin/instance-settings` edit it (409 with a `refusal`). Auto-redirect is
  refused until an admin has signed in through SSO, so a provider nobody has proven cannot lock the
  instance out. Env keeps secrets and provider wiring only. Tests: `instanceSettings.test.ts`, the
  policy cases in `authFormBrowser.test.ts`.

- MCP OAuth (better-auth `mcp()` plugin): 1h access tokens, 30-day refresh tokens
  (`MCP_REFRESH_TOKEN_TTL_S` in `server/mcpTokens.ts`; the plugin neither rotates nor revokes
  them). A daily prune deletes expired token rows but keeps the newest per user and client,
  since `allowance.ts` reads any row as proof an agent once connected.

## 6. Build and Dependency Management

- Canvas access: `canvasRole` in `server/access.ts` gives owners, members and workspace members
  edit, and share-link visitors the link's level (`none` / `view` / `comment` / `edit`). REST,
  the WebSocket room and MCP gate reads, comments and writes on it separately; spec in
  `.workflow/specs/share-link-roles.md`.
- Design libraries add their own gate beside canvas access, never inside it: `libraryRole` in
  `server/libraries.ts` (manage = `canManageCanvas`, curate = `canEditCanvas`, read =
  `canAccessCanvas`, plus every signed-in account for a `public` library while
  `DOOP_PUBLIC_LIBRARIES` is on). A library read opens the library routes and tools only, never
  `/api/canvases/:id`, the room or the frame tools. Visibility (`private` / `workspace` / `public`)
  is set from the share dialog by a manager; `workspace` needs the canvas in a workspace.

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 8 (Rolldown-based) - frontend build tool (`vite build`), with `@vitejs/plugin-react` 6.

## 7. Testing Stack

- Vitest 5 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.
- Browser tests drive one shared Chromium and one fixture server (`tests/browser.ts`), which
  `tests/globalSetup.ts` starts before any worker runs. The server hands out a production build:
  `tests/fixtures.vite.config.ts` is the app's own build with every `tests/fixtures/*.html` as an
  entry beside `index.html`, built once per run (about a second, as its own `vite build` process
  with `NODE_ENV=production`) into a temp directory and served by `vite preview`; there is no dev
  server and no live-reload client. A file calls `pagePerTest()` for a page per test in its own
  context (focus emulated, 30s navigation bound) and `fixtureUrl()` for its page. A fixture
  exposes what a test needs on `window`; a test cannot import `/src/...` from the page. A test of
  what the canvas page itself does mounts the real `CanvasPage` with no backend
  (`tests/canvasPageFixture.ts`: the room's socket stubbed, the session and API answered by the
  test). Only a test about what the server does starts one, and serves the same build in front of
  it with `serveBuilt(proxy)`: `pageControlsBrowser.test.ts`, whose subject is the room's broadcasts
  racing the HTTP responses and undo against the stored pages.
- CI runs the browser tests on the Chrome for Testing build named in `.chrome-version`, installed
  by the `test` job and passed as `CHROME_PATH`, so a runner image update cannot change the
  browser without a commit. `bun run test:linux [vitest args]` (`scripts/test-linux.sh`,
  `tests/linux.Dockerfile`, needs Docker) runs the suite in a two-CPU Linux container, for a
  test that fails on CI and passes on a Mac, and for the clipboard tests a Mac skips; on Apple
  Silicon the container uses Debian's Chromium, since Chrome for Testing has no Linux arm64 build.

## 8. CI/CD and Delivery

- GitHub Actions:
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint` + `format:check` + `doc-lint`, `build`
    and `test` (four vitest shards) as parallel jobs on push to `dev`, `staging` and `main` and on PRs, cancelling
    superseded PR runs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and installer
    release (tag `desktop-v*`, universal macOS DMG, Windows NSIS, Linux AppImage/.deb/.rpm,
    optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Build identity and update check (`server/buildInfo.ts`, `server/updateCheck.ts`,
  `shared/updateCheck.ts`): the image carries `DOOP_BUILD_SHA` / `DOOP_BUILD_DATE` (Dockerfile
  build args from `docker.yml`; a checkout reads `git rev-parse HEAD`), served publicly at
  `GET /api/version` and shown in Settings → General → About (`AboutCard.tsx`). The server asks
  GitHub's REST API, unauthenticated (`user-agent: diazo-update-check`), for the newest
  `DOOP_UPDATE_BRANCH` commit of `DOOP_UPDATE_REPO` whose `docker.yml` run succeeded (`GET
.../actions/workflows/docker.yml/runs?status=success`: a finished image build is the one
  signal that `:main` exists for it without a GHCR token; a repository without the workflow
  falls back to the branch head), then `compare/<running>...<latest>` for the count and titles.
  States: `current`, `behind`, `ahead`, `diverged`, `unknown` (`no-build-sha`, `not-found`,
  `rate-limited`, `unreachable`), `disabled` (`DOOP_UPDATE_CHECK=false`). Kept an hour, a
  failure 15 minutes, a spent limit until `x-ratelimit-reset`; ETags make a revalidation free;
  concurrent asks share one check; 8s timeout. `GET /api/update-status` answers instance admins
  and, on `DOOP_INSTALL=local`, everyone (404 otherwise). `ServerUpdateCard.tsx` sits in
  `UpdateCard`'s stack (browser and desktop alike), lists three titles, links the compare page
  and gives `updateCommand(install)`; dismissed per latest commit under `doop:update-dismissed`.
  `DOOP_INSTALL` is set by `install-local.sh`, compose and the k3s manifest, else guessed
  (`KUBERNETES_SERVICE_HOST`, `/.dockerenv`, a checkout). Tests: `buildInfo.test.ts`,
  `updateCheck.test.ts` (stubbed fetch), `updateStatusHttp.test.ts`, `serverUpdateCard.test.tsx`.

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.

## 10. Frontend Stack

- React 18.3.1 + Vite 8 - SPA, entry at `index.html`.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `docs/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.
- Chromium shell (the macOS app): `desktop/src-tauri-chromium` builds the same sources (its
  `[[bin]]` and build script point into `desktop/src-tauri`) on Tauri 3.0.0-alpha.5 with
  `tauri-runtime-cef` 3.0.0-alpha.6 (CEF 154, Chromium 154), so frame iframes render out of the
  editor's process. Same name, bundle id and executable as the WebKit app it replaces, so the
  WebKit app updates into it. Linking the CEF runtime makes `build.rs` set `cfg(chromium)`, which
  selects the runtime in `main()`, keeps the profile in `Application Support/dev.bryann2k.diazo/cef`
  (`cef-dev` for debug builds; the app is Diazo, `dev.bryann2k.diazo`, from 0.15.0, and
  `src/identity_migration.rs` first copies the old `design.doop.desktop` folders over when the new
  ones are empty) and, on the first launch, moves the WebKit app's cookies and
  localStorage over (`src/webkit_migration.rs`, read in-process through WebKit's own API); menu
  types go through `ShellRuntime`. Run it with `bun run dev:chromium` or `build:chromium` in
  `desktop/` (Tauri 3 CLI, needs cmake + ninja); see `desktop/README.md`.
- Interface language (`src/lib/i18n/`, no library): English (`en/`, the source catalog, one
  `as const` namespace per area) and Brazilian Portuguese (`pt-BR/`, typed `Catalog`, so a missing
  key fails typecheck). Components call `useT()` and `t('namespace.key', vars)`; `{name}`
  placeholders are type-checked, `{ one, other }` values pick a plural by `{count}`, and a key kept
  in a table is a `PlainMessageKey` translated at render. The active language is this browser's pick
  (`doop-locale` in `localStorage`, Settings -> General), else the server's
  `DEFAULT_LOCALE` (`GET /api/locale-config`, asked once before React mounts), else `en`; the list
  lives in `shared/locales.ts`. `tests/i18n.test.ts` checks every catalog against English. Screens
  not yet converted still render English.
- Home (`src/pages/Home.tsx`, `src/components/HomeHero.tsx`): a 12.5px rail (canvases, workspaces,
  explore, resources, agents, an Ask Doop pill bound to ⌘/), Import + New canvas in the top bar, and
  a hero over the brand's gradient wave: the hopping Disc-D, a greeting, a strip of suggestion chips
  (the "on" chip wears the drifting colour beam from `src/styles.css`) and a composer. A prompt makes
  a canvas named after it (`src/lib/homePrompt.ts`), queues it as the first board card asking for N
  drafts, and opens the canvas; a card that cannot queue rides along as the canvas composer's draft.
  The hero's top-right close button asks to "Hide Prompt Box" before hiding the whole prompt area.
  `src/lib/homePreferences.ts` remembers the choice in this browser under `doop.home.prompt-box-hidden`;
  Settings → General → Show Prompt Box restores it. The preference also updates other open tabs.
  Import makes a canvas and opens it with `?import=1`, which `CanvasPage` turns into the import
  picker. `GET /api/canvases` adds `people` (owner, then members) for the tiles' avatar stacks.
  The rail is `src/components/AppRail.tsx`, mounted by Home, Automations, Integrations, Community,
  Workspace and Admin alike (a page's own group, such as the admin indexes, goes in as children;
  Settings draws its own rail from the same `ui/dash.tsx` parts); it owns
  the ⌘K search palette (`CanvasSearchModal.tsx`), the connect-an-agent modal, the collapsed
  narrow state (remembered in `localStorage` under `doop-rail`) and the account face at the bottom.
  From another page the rail sends scope picks home as `/?scope=` and new workspaces as
  `/?workspace=new`. The workspace in view opens under its row: All canvases, People, Fonts, and
  for its owner and admins Plan & billing and Settings (`workspacePanesFor`); on the Workspace page
  they switch its pane in place, elsewhere they go to `/w/<id>?pane=…`, and the page keeps the
  pane in its URL. The rail keeps the last lists it drew (`lastLists`), so a page change does not
  blink its rows out, and fades only when collapsed or expanded. Home warms the Workspace page's
  detail while a workspace's canvases are in view (`src/lib/workspaceCache.ts`), so its panes draw on
  the first frame instead of a skeleton; the page refetches on arrival.

## 11. Developer Experience Tooling

- oxlint 1.x + oxlint-tsgolint (type-aware rules) - lint, config in `.oxlintrc.json`; ESLint 10 with
  the typescript-eslint parser runs only the `process.env` ban in `eslint.config.js`.
- Prettier 3.9.6 - formatting (no semicolons, single quotes, printWidth 120), config in
  `.prettierrc.json`.
- Husky 9.1.7 + lint-staged 17.3.0 - pre-commit hook runs `lint-staged` (`.husky/pre-commit`).
- commitlint 21.2.2 (`@commitlint/config-conventional`) - conventional commit / PR title linting,
  config in `commitlint.config.js`.

## OSS integration scope

The integration registries currently register Linear only. Canvas imports offer websites, live-app
sync and GitHub repositories; frame exports offer PNG/JPG with progress feedback and desktop saving.
Figma, Canva and PSD are deferred. Migration 0019 is reserved for the deferred Figma integration;
the OSS journal skips it while retaining the shared migration tags and timestamps for 0020–0022.
Gemini cloud workers remain an operator-managed, opt-in pilot; see `docs/gemini-cloud-pilot.md`.

The shared font library serves public font assets with CORS so sandboxed frames can load them.
Migrations 0040 (agent feedback) and 0041 (custom fonts) retain their shared timestamps; their OSS
snapshots omit the deferred Figma `integrations.refresh_token` column, as does the credential
encryption backfill. Desktop downloads use the platform-neutral `https://doop.design/download` page.

## Speech backend (phase 3, partial)

`shared/speech.ts` defines the catalog, preferences, routing and validated job
request. `server/speech.ts` persists jobs and preferences, claims desktop work
atomically and adapts cloud providers and the internal sidecar protocol.
`server/speechJobs.ts` validates canvas assets, requires cloud estimate
acknowledgement, normalizes results and writes transcripts/audio media.
`server/speechRoutes.ts` exposes the authenticated REST relay;
`server/speechTools.ts` supplies the same tools to MCP and the resident agent.
Migrations 0074–0076 add speech tables, durable request parameters and a partial
unique index allowing one active job per person. Restarted jobs fail without
automatic retries. Voice accounts are excluded from runner selection.

Contract and limitations: [speech-api.md](speech-api.md). Tests:
`tests/speech.test.ts`, `tests/speechHttp.test.ts`, `tests/agentToolParity.test.ts`
and `tests/agentRunners.test.ts`. The desktop engine worker, installer, model
release manifests and actual sidecar remain pending. No speech engine is
bundled or downloaded by this change.
