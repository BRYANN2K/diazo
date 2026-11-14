# redoop features

What this fork adds on top of [kgoedecke/doop](https://github.com/kgoedecke/doop), and the
upstream pull requests it merged ahead of upstream. Resync notes and the deploy recipe are in
[FORK.md](../FORK.md).

## Features added in this fork

- **⌘F across every page** — results grouped by frame, with thumbnails and a large preview.
  Agents get the same search with the `find_in_canvas` MCP tool.
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
  a scoped block) and `insert_library_item`, which places the copy for them.
- **Reference library** — store design-library items as references, find them with
  `find_references`, and attach them to plan cards (thumbnails, remove button, Settings card). Up to
  20 canvases; the workspace's design libraries come along without being picked. On a design
  library `find_references` answers from its index (families, with `item_id`), and a plan may name
  the item, which is checked and shown with its own image.
- **Plan-first Chat tab** — thread list, one composer, plan card and repo chip. An editor's line
  in the Chat tab asks Doop without an `@mention`, with a model picker per ask. A thread's Reply
  action points the composer at that thread. The composer and the message bubbles follow the
  design library's chat sections.
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
- **Handoff to Stip** — a frame marked ready for dev builds a Stip change pack, previewed in the
  Inspector and plan cards, then written into the linked repo by the desktop app's single write
  command (`repo_write_change`). Agents call `create_handoff`.
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
- **Local install on a Mac** — one `curl … | sh` runs doop in a single Apple `container` on
  `127.0.0.1:4400`, with PGlite and uploads in `~/.doop/data` and secrets generated on the Mac
  ([Run doop](../README.md#install)).
- **Usage meter** — every model transport reports its tokens, each resident run lands in an
  `agent_runs` ledger with its time and cost (the provider's figure, else a per-model price
  table), and a Usage tab shows the totals per run and per model. Agents call `get_usage`.
- **Run replay** — every frame version and activity line a resident run writes carries its run
  id: open a run from the Usage tab to see its timeline and each frame before and after, then roll
  the whole run back in one undo step (frames edited since need a confirmation).
- **Component ↔ file mapping** — map a component or a frame to its file and export in the linked
  repo (`code_links`). The Inspector's Code row suggests the file from `repo_search` /
  `repo_list`; `get_component`, `get_frame` and the Stip pack (`code-links.json`) carry the
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
- **Model duel** — Duel in the agents composer sends one brief to 2-3 models, each into its own
  sibling frame; a comparison card shows each render with its cost, time and lint score, and the
  one you keep is saved as a canvas decision while the others are archived (hidden, not deleted).
- **Self-hosting** — Docker image `ghcr.io/bryann2k/doop:bryann2k-main` (amd64 + arm64) built on every push, k3s
  manifests in `deploy/k3s/` with a persistent volume for uploads, exposed through Tailscale
  Serve only (no ingress, no Funnel).

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
