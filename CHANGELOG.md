# Changelog

What changed in Diazo, newest first. Read by users, instance admins and contributors.
Status: current through the fork's first changes, updated 2026-11-16

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), 0.x, so a breaking change bumps the minor.

Diazo started on 2026-11-12 from doop 0.14.0. Versions up to 0.14.0 are doop's own; their notes stay in doop's repository and in this file's git history. The desktop app has its own log in [desktop/CHANGELOG.md](desktop/CHANGELOG.md). Every change below is on `main` and ships in the `:main` image; the fork has not tagged a web release yet.

## [Unreleased]

- Add the Motion Studio director run: Animate cards run a staged
  `plan → build → refine → finish` loop owned by the server — visible call
  budgets, gate-checked stages, paid-filing idempotency, metered job waits,
  pass rubrics from `check_scene`, best-pass restore, and a delivery verdict
  judged on the film — with persisted runs broadcast to the room and
  list/get/stop routes.
- Add the Motion Studio element-layer backend: element tracks carry effect
  stacks, 26 colour blend modes, layer contracts, mattes and masks; static
  layer planning with budgets and lint; 56 seeded element motion presets
  with staggering; `set_layer`, `get_layer_plan`, `list_element_presets`
  and `apply_element_preset` on MCP and the resident agent; render jobs
  refuse over-budget films at creation and `RENDER_GL` picks the headless
  GL path.
- Add the partial speech job backend: estimates, persisted transcripts, voice-over
  audio clips, secure desktop relay, and matching canvas tools. Local engine
  installers and the speech sidecar remain pending.
- Extend the Motion Studio backend through phases 2 to 5: transitions, camera
  presets, text animators and 3D clips on the composition contract; GIF and
  PNG-sequence renders; media rows with transcripts and ducking; video
  generation on OpenRouter and Gemini keys; the speech engine catalog with
  desktop installs; the Blender op relay behind grants; server-side renders
  (webm/pngseq, 60 s, 1080p, 30 fps, one per account); Lottie and HyperFrames
  interchange; and the motion duel.


### Added

- Design libraries: turn a canvas into a library with rules, then browse it in a gallery (`/libraries`, `/l/<id>`), search it from ⌘F and the Layers panel's Library tab, and insert an item into a frame as a linked block that offers updates.
- Library imports with a dry run, a lint gate and token mapping, an inbox for review, public libraries on the Community page, and item thumbnails rendered in the background.
- Organise with AI: one proposed category tree for several source canvases, reviewed and then applied to a new library canvas. "Start empty" makes a library from scratch.
- AI descriptions and tags for thin library items, off until a library manager turns them on.
- Duplicate checks: a library says when it already has an item, by page URL, content or similarity.
- ⌘F as a palette across every page of a canvas, a library or everything you can open, with a live preview that plays its animations and hover states.
- Model duel: one brief to two or three models, each in its own slot with its own reasoning effort, compared on a card with render, cost, time and lint score; the pick is kept as a canvas decision.
- Frame lint (anti-slop rules) and frame checks (overflow, clipping, tap targets, contrast, focus) in the Inspector's Quality section, with the `lint_frame` and `check_frame` tools for agents.
- Run history: every agent run is recorded with its model, tokens and cost (Usage panel, `get_usage`), its timeline of frame changes, and a one-step rollback of the whole run.
- Canvas chat: a thread list, a composer with a model picker, plan cards and "Go design".
- Canvas skills: named know-how per canvas, loaded by agents when the task matches, and picked from the composer's `/` menu.
- Link a canvas to a local project through the desktop app: agents read and search the repository, frames map to code files, design tokens sync both ways as a reviewed patch, and a frame exports as a React or Astro component.
- Live frames: a frame that shows a local app running on this Mac, in the desktop app.
- Drift review: compare a frame with a live URL, from the canvas or from CI.
- Built page and preview-deploy webhooks.
- Ready for dev → a Stip change pack, from the Inspector or `create_handoff`.
- The `diazo` command line (`doop` kept as an alias): link a folder to a canvas, find, pull and push frames, and install the MCP server in Claude Code, Codex or Devin.
- Devin and Grok as local agents on the desktop app, over ACP, next to the Claude Plan.
- Every pinned Claude model in the model menus, OpenAI models named one way, and each provider's live catalog.
- `upload_font` for agents, and `upload_asset`'s `place` to drop an uploaded image on the canvas.
- OpenCode in Connect AI.
- Cut with ⌘X and from the frame and layer menus.
- Build identity at `/api/version` and in Settings → About, and an "Update available" card for admins when a newer image of `main` is built.
- One-command install on a Mac: the local server in Apple's `container`, and the desktop app through a curl script.
- The installers detect the system: the desktop app installs on Linux (.deb, .rpm or AppImage) and Windows (a PowerShell script), and the all-in-one install offers a local server (Docker or Podman on Linux, with a systemd user unit) or a remote one (`--remote <url>`, checked like the app's own server choice).

### Changed

- **Breaking:** the product is now Diazo and its agent the Diazo Agent (`@diazo`), with its own marks. Internal identifiers keep the doop name, so data, keys and integrations carry over.
- The repository, the container image and the update check point at `BRYANN2K/diazo`. The desktop app is `dev.bryann2k.diazo` and updates from the fork's own feed and signing key.
- A canvas opens on one page and loads the other pages' HTML on demand; only the frames in view are live; room messages and API responses are compressed.
- The find bar is a palette with sections and a preview pane.
- The chat opens with canvas suggestions, a turn layout, a jump to the latest message and a calmer composer.
- Server renders go through one bounded gate, recover from a wedged Chromium, and can run in a remote Chrome over CDP.
- Work merges through `dev` and `staging` before `main`; CI runs on all three.
- The model picker splits into two pills: the model opens a short searchable menu grouped by
  connection (recommended entries up front, the rest under "Older"), and the reasoning effort
  gets its own radio popover with a dial glyph on the pill. Duel slots split the same way.

### Fixed

- Animate storyboard animates the shots, not just the camera: it reads each frame's shot notes (mouvement / transition / son / voix off / notes, FR and EN) and animatable elements — stamping `data-doop-id`s the way comments do — and `set_composition` reports the noted shots still without an element track until the film is done.
- Uploaded assets survive a container restart on the k3s deploy (persistent volume for `/app/data`).
- A delivered card run is recorded as done, not stopped.
- Duel entries are labelled by model name, not by raw id, and no duel card shows when a list answer is not a list.
- Synced stylesheets resolve their `url()`s against the sheet, so synced fonts load.
- A culled frame shows its preview render instead of a blank box.
- A zoomed-out canvas shows frame designs instead of white boxes, with stored pictures sized to the zoom and a neutral placeholder while they load. Unchanged pictures survive restarts and moves; edits replace them without caching an older design as current. Busy renderers and network interruptions retry, off-screen pictures can leave the memory cache, and a frame going live fades its picture away.
- Presence: no ghost presences on overlapping joins, and a leave is broadcast when a connection switches canvas.
- `edit_frame_html` inserts its replacement text literally.
- Settings → Diazo Agent: Connect on a Devin or Grok desktop agent did nothing — the shell refused the agent commands, and the row hid the error. Connect now shows progress and any error under the row.
- An unsent Agents-tab composer draft survives a reload or an app relaunch: the text is parked per account and canvas in the browser, removed on sign-out, and pruned past 30 days or 50 canvases.

### Security

- The desktop app no longer gives doop.design (upstream's hosted service, which this fork does not control) access to the app's native features. Only the server the app opens gets them. With nothing chosen the app now opens the Diazo server on this computer (`http://127.0.0.1:4400`) and offers to choose another when it does not answer. Needs a desktop release.

[Unreleased]: https://github.com/BRYANN2K/diazo/compare/v0.14.0...main
