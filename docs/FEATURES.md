# Diazo features

Status: current, updated 2026-11-16

What this fork adds on top of [kgoedecke/doop](https://github.com/kgoedecke/doop), and the
upstream pull requests it merged ahead of upstream. Resync notes are in
[runbooks/upstream-resync.md](runbooks/upstream-resync.md) and the deploy recipe in
[runbooks/k3s-deploy.md](runbooks/k3s-deploy.md). The README sums them up in
[What it does today](../README.md#what-it-does-today).

## Features added in this fork

- **Diazo's own identity** — doop's name and logo are trademarks, so the fork is Diazo: its mark
  (an ink-outline D and a blue print D), the "diazo" wordmark, the Diazo Agent's face in agent
  orange (animated while it works), Diazo in every interface string, email and agent guide,
  `@diazo` mentions (`@doop` still routes), the desktop app `Diazo.app` (`dev.bryann2k.diazo`,
  data copied over from the doop shell on first launch) and the install scripts. Internal
  identifiers (`data-doop-*`, `DOOP_*`, tables, MCP tool names) are unchanged
  ([DESIGN.md, Marks](DESIGN.md#marks-diazo)).

- **⌘F across every page** — a palette: This canvas (this page or all pages), Library or All as
  one segmented control, results in sections (canvas matches, then library items with their
  thumbnail, kind, category and variants), a large side preview with variant chips and Insert /
  Go to, and the keys in the footer (↩, ⇧↩, ⌥↩ variants, ⌘C). The preview runs the item live:
  its animations, transitions and scripts play and hover demos react under the pointer, paused
  while off screen. Agents get the same search with the `find_in_canvas` MCP tool.
- **Insert from ⌘F** — hovering a result moves the live preview onto that variant without
  reloading it. Clicking a library item (a row the library index answered) while a frame is selected inserts a
  copy: its HTML plus only the CSS that matches it, scoped with `@scope`, with fresh
  `data-doop-id`s, the SVG symbols and gradients it points at (ids prefixed per insert), nothing
  that runs (no scripts, handlers or `javascript:` URLs), and `data-doop-ref` /
  `data-doop-ref-lib` / `data-doop-ref-rev` keeping the item, its library and its revision. You can also drag the
  row onto any frame; a line shows the drop slot between elements. ⇧ click goes to the item,
  ↩ / ⇧↩ / ⌘C do the same from the keyboard. A box beside the copy sends an instruction to the
  chat (**Adapt**, through the plan → Go flow) or removes the copy (**Undo**).
- **Design libraries** — a canvas becomes a library (File → Turn into a library…): its frames are
  indexed as items, a family with its variants, each with a kind, a category and tags, read from
  the frame names (`<id> — <label>`), `§` section frames and the sheets' cells, or from
  `data-doop-item` / `data-doop-variant` markers. Converting changes no frame. ⌘F has a Library
  scope answered by the index: one row per family, its variants under it, kind chips, and insert
  as before. The Libraries page (rail → Libraries, `/libraries`) lists them as tiles; a library's gallery
  (`/l/<id>`) filters by kind, category and search and opens an item with every variant side by side;
  "Use" inserts it into the frame the gallery was opened from (⌘F → Open in gallery), or into a
  canvas and frame picked there, and the canvas opens with the block picked.
  A frame's menu has "Add to library…": the library's rules give each copy an id, its variants'
  markers, the SVG definitions it points at, a category, a page and a status (a low lint score can
  keep it a draft), shown as a dry run first; the frames themselves are not changed.
  Who can use a library is set in its share dialog: the people with access, its workspace, or —
  only with `DOOP_PUBLIC_LIBRARIES=true`, off by default — every account on the instance, after a
  warning that library content is often a vendor's. A public library is searched, browsed and
  inserted from (Community has a Libraries shelf: Use, Copy), never opened as a canvas.
  A block inserted from a library shows "From library" in the element panel, with Update when its
  item has a newer revision (a fresh copy in its place, one undo step, after a confirmation).
  Agents call `list_libraries`, `get_library`, `search_library`, `get_library_item` (with the item as
  a scoped block) and `insert_library_item`, which places the copy for them; `import_to_library` and
  `set_library_item` write to one while `AGENT_LIBRARY_WRITES` is on (the default).
  An item whose frame holds a component goes in as a linked instance ("Promote to component" makes
  one). ⌘F everywhere answers libraries from their index, without loading them. Search knows common
  UI synonyms ("login" finds "sign in") and ranks what is used most first. A library can let a
  model describe and tag its thin items (off by default, 200 a day, suggestions wait in the inbox).
  `scripts/pull-library.ts` copies a library from another doop or Diazo instance
  ([runbooks/design-library-migration.md](runbooks/design-library-migration.md)).
  The category tree the convert wizard proposes drops page numbers ("16 "), alphabetical splits
  ("· A–L") and continuations, and folds the categories that then collide.
- **Organise a library with AI** — Libraries → Organise with AI (also offered by the convert
  wizard): tick several canvases, and a model on your own connected account reads their items,
  folds the duplicates (same markup, or the same name and text across canvases; the first canvas
  ticked wins), proposes ONE category tree of up to three levels from the items themselves (no
  numbers, no A–L splits) and files every item, a family's cards together. You review it: counts and
  thumbnails per category, rename, merge, move, remove, add, move items, see what stayed
  unclassified and what is already in another of your libraries. Create library then makes a new
  canvas with one page per category, the frames copied there in a tidy grid, and turns it into a
  library with that tree; the canvases you picked are never changed. About one model call per 60
  frames (7,000 frames ≈ 120 calls), resumable after a restart, retry from where a failed run
  stopped. Agents can start one (`start_library_curation`) and read it (`get_library_curation`);
  the human applies it.
- **Start a library from scratch** — New library → Start empty: a name, what it is for, and starting
  categories typed one per line (`Components/Buttons`) or suggested by your model from one line.
  The gallery of an empty library says how to fill it: Add to library… on any frame (now with a
  category), a website import then Add to library…, or an agent with `import_to_library`.
- **"We already have it"** — every import into a library is checked against all your libraries
  first: the same page (a website import's address, normalised: no tracking, scheme or `www`), a
  copy of the same frame (every copy records where it came from) or the same content, or a near
  copy (name and text sharing 80% of their words). Add to library… then shows "Already in
  <library> → <category>: <item>" with Open, Import anyway and Add as a variant. Agents get the
  match back from `import_to_library` instead of a second copy (with `force` / `as_variant_of` once
  the human decides) and can ask first with `check_library`.
- **Library previews that are ready** — after a library is indexed, and at boot, the server renders
  the item thumbnails it does not have yet in the background (gallery order first, a few at a time,
  never in the way of a person or an agent), and the gallery says "Preparing previews · N / M"
  meanwhile. A thumbnail shows the item's demo, not its sheet card: the label strip and caption are
  left out, scripted and animated demos are given time, a pointer over them and their animations
  moved past the first frame, and the result is trimmed and framed at the tile's 4:3 on the demo's
  own background. A tile loads only on screen, shows a skeleton, and waits out a busy renderer
  instead of breaking. `RENDER_BACKGROUND_CONCURRENCY` sets how many pages that work may hold.
- **Reference library** — store design-library items as references, find them with
  `find_references`, and attach them to plan cards (thumbnails, remove button, Settings card). Up to
  20 canvases; the workspace's design libraries come along without being picked. On a design
  library `find_references` answers from its index (families, with `item_id`), and a plan may name
  the item, which is checked and shown with its own image.
- **Plan-first Chat tab** — thread list, one composer, plan card and repo chip. An editor's line
  in the Chat tab asks the Diazo Agent without an `@mention`, with a model picker per ask. A thread's Reply
  action points the composer at that thread. The composer and the message bubbles follow the
  design library's chat sections. Until someone asks the Diazo Agent, the tab shows a welcome with suggestion
  chips tied to the canvas (a pricing page, a landing page, an accessibility review of the selected
  frame, the canvas's first skill as `/name` in the composer). The agent's turn sits in its own
  place: a thinking row while it works, the reason and a Retry when an ask fails. The list follows
  new lines while you read at the bottom; scrolled up, a "Jump to latest" pill (or "New messages")
  brings you back.
- **Canvas skills** (upstream issue #380) — named know-how per canvas: a saved brief, or "how we
  do a pricing page here". Agents see each skill's "when to use it" line and load the matching
  one on their own (`list_skills`, `get_skill`, `set_skill` over MCP, and the same tools for the
  resident agent). Typing `/name` in an ask, or picking it from the composer's `/` menu, loads it
  for sure. You manage skills in the Memory panel.
- **Link a local project** (desktop app) — link a canvas to a folder on your Mac. The agent can
  only list, read and search it (`repo_list`, `repo_read`, `repo_search`); the path stays on the
  machine.
- **Anti-slop lint** — a rules engine checks every frame (client iframe or server renderer), a
  badge on the frame and a Quality section in the Inspector show the result, and the resident
  agent fixes lint errors before finishing. Agents call `lint_frame`.
- **Frame checks** — the server renderer lays each frame out at 375, 768 and 1440px (horizontal
  overflow, clipped text, tap targets under 44px) and walks it with the Tab key (WCAG AA text
  contrast, visible focus, tab order). An A11y badge on the frame and the Inspector's Quality
  section show the result, stored on the frame. Agents call `check_frame`.
- **Send to Orca** (desktop app) — a ready-for-dev frame can be sent to an Orca worktree on
  this Mac or a paired environment (the `vps` target): the desktop app creates the worktree
  and starts a coding agent in it after a native confirmation, and the canvas watches the
  task's live state until the PR. The agent reads its brief — the frame's PNG export, the
  canvas's design tokens and code links — over MCP (`get_handoff`) and reports with
  `update_dev_task`; nothing writes into the worktree and no absolute path
  ever reaches the server ([docs/orca.md](orca.md)).
- **Zoomed-out frame pictures** — frames too small for live documents show stored previews at
  their on-screen width. Edits keep the previous picture until its replacement loads. Unchanged
  previews survive a server restart, and moving a frame does not render it again. A neutral
  placeholder and bounded retries cover cold or busy renderers. Preview work starts on demand.
- **Live frames** (desktop app) — a frame that shows a local dev server (`localhost` only) with a
  LIVE badge, created from the import picker or with `create_live_frame`, and snapshotted at the
  frame's size.
- **Drift review** — compare a frame with a live URL: pixel score, drift cards, a compare modal
  and a CI webhook. Agents call `compare_with_url`; the desktop app fetches local URLs
  (loopback GET/HEAD only).
- **Built page** — a signed preview-deploy webhook per canvas (Import → Preview deploys, secret
  shown once). Each route the deploy lists is captured onto a "Built" page beside a snapshot of
  its designed frame (matched by route mapping or name), scored as a drift comparison, and
  rewritten in place on the next delivery. Payload and CI recipe in
  [docs/built-page.md](built-page.md).
- **All-in-one install, local or remote** — `scripts/install.sh` (`curl … | sh`) detects the
  system and offers two modes. Local (the default, or a one-question prompt) sets up the server
  on this machine — Apple's `container` on macOS (a LaunchAgent starts it at login), Docker or
  Podman on Linux (a systemd user unit instead) — and the app pointed at
  `http://127.0.0.1:4400`. `--remote <url>` installs only the app and writes its `server.json`
  after checking the address the way the app does (https, or http on this computer) and that
  `/api/locale-config` answers; nothing runs on the machine. Both install the `diazo` command
  (start, stop, restart, status, logs, update, open, uninstall); `--app-only`, `--server-only`,
  `--use-local`, `--dry-run`. The app's Diazo → Local Server menu (macOS, desktop 0.16) shows the
  server's status and starts, stops or restarts it, opens its logs and switches the app to it;
  Settings → About shows the same status ([Install](../README.md#install)).
- **Local install on a Mac or Linux box** — one `curl … | sh` runs Diazo in a single container on
  `127.0.0.1:4400`, with PGlite and uploads in `~/.diazo/data` (an older `~/.doop` is kept in
  place) and secrets generated on the machine; Apple's `container` on macOS, Docker or Podman on
  Linux ([Install](../README.md#install)).
- **Desktop app from this repo** — `scripts/install-desktop.sh` (`curl … | sh`) installs the app
  from a `desktop-v*` release of this repo, checked against its SHA-256: `Diazo.app` on macOS
  with no Apple signing needed, the `.deb` or `.rpm` package on Debian/Fedora-family Linux, the
  AppImage elsewhere (`--appimage` forces it); on Windows
  `scripts/install-desktop.ps1` (`irm … | iex`) runs the setup silently and can write the server
  choice (`-Server`, or `DOOP_DESKTOP_SERVER`). The app then updates itself from the same
  releases, signed with this fork's own updater key ([Desktop app](../README.md#desktop-app)).
- **Usage meter** — every model transport reports its tokens, each resident run lands in an
  `agent_runs` ledger with its time and cost (the provider's figure, else a per-model price
  table), and a Usage tab shows the totals per run and per model. Agents call `get_usage`.
- **Run replay** — every frame version and activity line a resident run writes carries its run
  id: open a run from the Usage tab to see its timeline and each frame before and after, then roll
  the whole run back in one undo step (frames edited since need a confirmation).
- **Component ↔ file mapping** — map a component or a frame to its file and export in the linked
  repo (`code_links`). The Inspector's Code row suggests the file from `repo_search` /
  `repo_list`; `get_component`, `get_frame` and a dev task's brief carry the
  mapping. Agents call `set_code_link` and `suggest_code_links`. Read-only on the repo.
- **Token sync with the repo** — the Tokens panel reads the linked repo's CSS variables
  (`:root`, `@theme`, dark blocks as a theme) and Tailwind v3 theme, parsed without running them,
  shows the diff, and applies the ticked values in doop. The other way, doop's values become a
  unified patch against the repo's style files, written by the desktop app's `repo_apply_patch`
  only after its native dialog lists every file and the diff (needs a desktop release).
- **Frame → code** — the Inspector exports a frame as a React (`.tsx` + `.css`) or Astro component:
  raw values equal to a token become `var(--token)`, mapped components are imported from their
  files. A diff preview against the repo comes first; the write goes through `repo_apply_patch`
  and then maps the frame to its new file. Agents call `export_frame_code` (returns the files).
- **`doop` CLI** — `bun run doop`, code in `cli/` ([usage](cli.md)): link a project folder to a
  canvas with `.doop.json`, `open` it, `find` frames, `pull` / `push` a frame as an HTML file
  (a push is refused when the frame changed on the canvas since the pull), and `doop mcp install`
  for Claude Code, Codex and Devin. It authenticates with an agent key.
- **Model picker** — the composer's foot carries two pills: the model and, where the connection
  has one, its reasoning effort. The model menu opens on a search field (model, id or connection
  name; typing anywhere in the menu goes to it) over the connections, each showing its
  recommended entries with the rest under "Older (N)". The effort pill opens a radio list with a
  one-line blurb per level and wears a dial glyph; in a narrow foot the model name truncates and
  the effort pill keeps only its dial.
- **Model duel** — Duel in the agents composer sends one brief to 2-3 models, each picked from
  what the connection can actually run (its live provider catalog; on the Claude Plan the
  "Latest" aliases and every pinned Claude version). The dialog is just the brief, with three
  compact slots in its foot (Model 1, Model 2, an optional Model 3); each is a model button
  plus an effort pill, opening the composer's own menus (a grouped, searchable model list, a
  reasoning-effort radio starting at the connection's setting) and can be cleared. The same
  model can run twice at different efforts; two identical slots are
  flagged and hold Start back. Each designs into its own sibling frame. A comparison card
  shows each render with its cost, time, effort and lint score, and the one you keep is saved as
  a canvas decision while the others are archived (hidden, not deleted).
- **Devin and Grok on the desktop (ACP)** — Settings → Diazo Agent lists **Devin (desktop)** and
  **Grok (desktop)** when the desktop app can run them: the shell starts the CLI already installed
  and signed in on the computer (`devin acp`, `grok agent stdio`) and drives it over the Agent
  Client Protocol, with the run's Diazo MCP server, the way the Claude Plan runs Claude Code. Each
  is a connection of its own, in the composer's model picker and the model duel, with its model
  menu (curated plus what `devin models` / `grok models` list) and effort (Grok's
  `--reasoning-effort`; Devin's effort picks the model variant, `swe-2` + Max → `swe-2-max`).
  Permission requests are granted for Diazo's canvas tools only. Needs a desktop release.
- **Self-hosting** — Docker image `ghcr.io/bryann2k/diazo:main` (also `:latest` and
  `:sha-<commit>`; amd64 + arm64) built on every push to `main`, k3s manifests in `deploy/k3s/`
  with a persistent volume for uploads, exposed through Tailscale Serve only (no ingress, no
  Funnel).
- **Update check against this fork** — every image knows its commit and build date
  (`GET /api/version`, Settings → General → About). The server asks GitHub, at most hourly and
  without a token, for the newest `main` commit whose image build succeeded and compares it with
  the running one; instance admins (and a local install's user) get an "Update available · N new
  commits" card, in the browser and the desktop app, with the commit titles, a link to the compare
  page and the command for their install (`diazo-local update`, `docker compose pull && docker
compose up -d`, `kubectl -n doop rollout restart deploy/doop`). Dismissed per build;
  `DOOP_UPDATE_CHECK=false` turns it off.
- **Agents add fonts** — the `upload_font` MCP tool adds a TTF/OTF/WOFF/WOFF2 file (10 MB, one
  face) to a font library, as Settings → Fonts does: the canvas's (its workspace's, else its
  owner's) or a named workspace's, for whoever may change that library. The file comes by URL,
  as a one-time `curl` upload or as base64; the answer names the family, weight and style read
  from the file and the CSS to write, and Diazo adds the `@font-face` to the frames.
- **Demo and README screenshots** — `scripts/seed-demo.ts` boots a local instance seeded with an
  invented product (Fieldnote), with a scripted stand-in for the model API and a fake desktop
  device serving a demo repo, so the agent, usage, duel, curation and repo features run without a
  provider. `scripts/readme-shots.ts` takes the README screenshots from it.
- **Redesign 2026-11 (Cyanotype bench)** — the interface follows the redesign frames of the canvas
  "redoop — Redesign 2026-11": a graphite palette with signal blue for people and selection and
  agent orange for anything an agent does, Atkinson Hyperlegible Next / Mono with Familjen Grotesk
  for headings (self-hosted), named motion tokens (durations, three `linear()` springs, a 30 ms
  stagger) with a reduced-motion fallback, restyled primitives (gliding tabs and segmented
  controls, number roll, agent thinking line), the floating editor shell (title and presence in
  one island, Import / Export / Motion / Play / Share in another, Connect AI in the agent panel),
  the orange beam round a frame an agent is writing, the new composer and the dotted home hero
  ([DESIGN.md](DESIGN.md)).
- **Motion Studio (timeline UI)** — the bar's Motion button opens a timeline under the stage for
  the page: transport and timecode, a ruler, the camera lane with its keys, the shots between them
  and any element lanes, one playhead to scrub. Playing or scrubbing moves the editor's own view
  through the camera's shots (cuts instead of glides under reduced motion). "Key the camera here"
  keyframes the current view at the playhead; "Animate storyboard" asks the Diazo Agent to turn
  the page's frames into shots and camera moves. Export renders MP4 or WebM in the browser
  (MediaRecorder over a compositor that draws every frame from the time alone) or, in a desktop
  shell that offers it, frame by frame with ffmpeg through the `/c/<id>/motion-render` harness.
  Built against the contract in `docs/motion-api.md` (`feat/motion-backend`); the client types in
  `src/lib/motion/contract.ts` are an adapter until that branch merges.
- **Motion Studio pro — the director kit and the effect stack (backend)** — on top of the MVP
  contract: a `Direction` on the composition (treatment, beats with per-shot seconds and handovers,
  look, pass budget) that `animate_storyboard` consumes; preset tools writing editable keyframes
  (`apply_camera_preset`, `apply_transition`, `apply_text_animation`); agent-visible render checks
  (`get_scene_snapshot` contact sheets, `check_scene`, `critique_scene` with a bounded rubric loop);
  and a P1 effect stack — 43 registered effects on tracks with `fx:<id>.<param>` keyframe lanes,
  blend modes, adjustment layers gating stacks over clip windows, named looks as adjustment tracks,
  a deterministic filmic shutter (`motionBlur`), and a WebGL2 pass in the compositor with a GLSL
  body for every registered effect (lint rule MO-14 still guards anything unregistered). Same
  tools on MCP and the resident agent through `execMotionPro`.
- **Motion Studio — the director run (backend)** — an Animate card (`kind: 'animate'`) runs a
  staged director loop the server owns: `plan → build → refine × passes → finish`, per-stage and
  run call budgets the model sees in every tool result, gate-checked `end_stage`, paid filings
  deduped on their normalized recipe, `wait_for_job` metered outside active time, `check_scene`
  folded into pass rubrics, the best pass restored on regression, and the film judged `delivered`,
  `delivered_with_issues` or `failed` at finish — ordinary cards keep their 24/40-turn runs.
  Director runs persist (`director_runs`), broadcast on the room and list/get/stop over REST.
- **Motion Studio — element layers, blends and presets (backend)** — an element track carrying an
  effect stack, a non-normal blend, a matte or masks promotes to a layer: `shared/motionLayers.ts`
  plans promotion, static/dynamic rasters, transform placement, pads, scales and the layer budgets
  (MO-15..19), `shared/motionBlend.ts` gives the 26 colour blend modes a CPU reference and the
  compositor's GLSL, and `shared/motionElementPresets.ts` compiles 56 seeded element presets
  (20 entrances, 20 exits, 16 emphasis) plus staggered starts to ordinary editable keyframes.
  `add_effect`/`set_effects` accept `frame_id`+`element_id` and create the track; `set_layer`,
  `get_layer_plan`, `list_element_presets` and `apply_element_preset` ship on MCP and the resident
  agent; `check_scene` reports `layers` and `motion_variety`; render jobs refuse an over-budget
  film at creation and the headless renderer picks its GL path through `RENDER_GL`. The browser
  layer engine and the editor land separately (P0-FE).
- **Motion Studio ("Rostrum") — a page can be a film (backend, MVP)** — an ordinary page gains a
  seekable, deterministic timeline: duration/fps/size, camera tracks over the page's world,
  per-element property tracks, clips, audio and captions (contract in `shared/motion.ts`, API in
  `docs/motion-api.md`). `shared/motionRuntime.ts` evaluates the frame state at time t as a pure
  function — the player seeks, never runs clocks — and `shared/motionLint.ts` flags non-seek-safe
  markup (wall clocks, free-running loops, unseeded random, CSS animations, GSAP, autoplaying
  media). Compositions persist per page with bounded version history, copy with page/canvas
  duplication and broadcast live over the canvas room (`composition`, `composition:playhead`,
  `render:progress`). REST under `/api/canvases/:id/pages/:pageId/composition` (+ `/renders`,
  `/api/renders/:id` upload into `/a/` assets) behind the view/edit gates; agents get
  `get_composition`, `set_composition` (whole body or ops), `animate_storyboard`, `lint_motion`
  and `render_composition`, resident-agent included. `animate_storyboard` reads each shot's
  frame for its notes (mouvement / transition / son / voix off / notes labels, FR and EN) and
  its animatable elements — `data-doop-id` targets stamped the way comments stamp theirs — and
  every `set_composition` reports the noted shots still without an element track, so the film
  gets animated elements, not just camera cuts. Renders are queued jobs: the browser renders
  them (MediaRecorder/WebCodecs) or the desktop shell does deterministically — a hidden webview
  seeks the page frame by frame and a local, allowlisted `ffmpeg` encodes, all behind
  `__DOOP_MOTION_RENDER__`. Phases 2 to 5 add transitions, camera presets and text animators,
  `3d` clips (a glTF asset with a fallback image, driven by time, scroll or pointer), media rows
  (speed, cuts, beats, transcript, recipe, ducking, captions), `generate_video` on OpenRouter and
  Gemini keys, a speech engine (installed models in the desktop shell, cloud providers on the
  user's own key, custom models and cloned voices), a Blender op relay whose write and render
  tools need a grant in the shell, `blender` and `server` render targets — the server one under
  60 s / 1080p / 30 fps / one-per-account caps on the instance's headless Chromium — Lottie and
  HyperFrames import/export of the transform subset, and the motion duel (each pick animates its
  own copy of the storyboard page).

- **Speech job backend (phase 3, partial)** — persisted jobs and preferences,
  explicit cloud estimates on connected user keys, owner-scoped desktop relay,
  word-timed media transcripts and voice-over audio clips with their recipes.
  REST, MCP and resident tools share one service. Installers and real local engines
  are pending; unpinned catalog downloads are blocked. Contract: [speech-api.md](speech-api.md).

## Merged upstream PRs

| PR   | What it brings                                                                          |
| ---- | --------------------------------------------------------------------------------------- |
| #412 | Off-screen frames are culled and show their preview render instead of a blank box.      |
| #314 | Level of detail: a budget of live frames, the rest render as server images.             |
| #434 | The stage no longer re-renders on every zoom frame.                                     |
| #435 | The stage box is read once per wheel flush.                                             |
| #436 | The layout zoom is kept across small zoom changes.                                      |
| #437 | Camera CSS variables are written only where they are read.                              |
| #439 | Panel resize keeps its mark until the last dragged edge is released.                    |
| #399 | A wedged Chromium renderer is relaunched instead of hanging every render.               |
| #456 | Hardened renderer (leases, queues, pixel limits, `/healthz/renderer`), `.ico` favicons. |
| #277 | `edit_frame_html` inserts the replacement text literally.                               |
| #390 | No more ghost presences when two joins overlap.                                         |
| #505 | Security: frame CSP, non-root container, gated agent style-guide writes.                |
| #462 | Cut (⌘X) frames and layers through a shared canvas clipboard.                           |
| #476 | Image placement at native size, HTTP upload-and-place endpoint.                         |
| #457 | OpenCode in the Connect AI picker.                                                      |
| #506 | External stylesheets synced into frames, with their `url()`s and fonts resolved.        |

Dropped: **#299** (older component library). Merging it would add a second component system next
to upstream's.
