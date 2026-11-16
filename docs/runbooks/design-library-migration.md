# Runbook: bring the design-library canvases into one library

How the owner's design-library canvases are copied from doop.design, turned into libraries, and merged into one with AI. Read by Bryan and by agents helping with that migration.
Status: steps written 2026-11-14, end-to-end run unverified, updated 2026-11-16

Agent keys go in the environment only, never in a file. The source canvases are only read; the four canvases on the instance are never modified.

## Purpose

- Runs: a one-off migration of "Design Library", "Design Library · by function", "Design Library · A UI components", "Design Library · B Sections & screens" and "Design Library · C Motion, type & effects".
- Open this when: these canvases are copied to a new instance, or the merged library is rebuilt.

## Copy a canvas from doop.design

```sh
export DOOP_FROM_KEY=dpk_…   # agent key of the doop.design account that sees the canvas
export DOOP_TO_KEY=dpk_…     # agent key of the account on the Diazo instance
npx tsx scripts/pull-library.ts --from https://doop.design --canvas <id> --to <instance origin> --dry-run
# Expect: the pages and frames it would copy, nothing written
npx tsx scripts/pull-library.ts --from https://doop.design --canvas <id> --to <instance origin>
# Expect: a new canvas on the instance; a rerun resumes where it stopped
```

The source is read through MCP (`get_canvas`, `get_frame`) and public `/a/` assets. Progress is kept in the OS temporary folder. Past 100 pages the script stops: turn the target canvas into a library (next step), then run the same command again.

## Turn each canvas into a library

1. Open "Design Library" → File → "Turn into a library…". The `sheets` preset is detected. Check the report (Ignored, Unreadable, Duplicates), review the proposed categories (`§` sections and page names), apply. No frame is changed.
2. Wait for indexing to finish (the library's `items · variants` counter). The rendered pass then reads the scripted sheets.
3. Do the same for "Design Library · by function".
4. Copy its categories into "Design Library": `POST /api/libraries/<design-library>/transfer { "fromLibraryId": "<by-function>", "dryRun": true }`, review `matched`, `onlyFrom` and `onlyTo`, then run it again without `dryRun`. Only "Design Library"'s curation is written; a second run changes nothing. Archive "by function" afterwards.

## Merge four canvases into one library with AI

1. Connect a model account of your own (Settings → Diazo Agent). Curation runs on that account, never on the server's tier. For about 7,000 frames, expect about 120 calls (one for the tree, one per batch of 60 items on the account's small model, plus a few retries).
2. Rail → Libraries → "Organise with AI". Tick "Design Library" first (its copy wins when a design is duplicated), then A, B and C. Name the library, Start.
3. Follow the progress (reading the canvases, the tree, filing). The window can close: the task continues on the server and resumes after a restart. An account error fails it: "Retry from where it stopped".
4. Review the tree: rename, merge ("Merge into…"), move, delete a category (its items become unclassified), move items. Check the "Unclassified" and "Duplicates" tabs.
5. "Create library": a new canvas, one page per category, frames copied in a grid, then indexed. Tick "Unsorted" to keep unclassified items.

By API (session): `POST /api/library-curations { sourceIds: [...] }`, `GET /:id`, `GET /:id/plan`, `PATCH /:id/plan { edits }`, `POST /:id/apply`. An agent can `start_library_curation` and `get_library_curation`; a person applies.

## Validation

- The new library's gallery lists every category with thumbnails. Expect: "Preparing previews" ends.
- ⌘F → Library finds an item from each source canvas. Expect: one row per family, its variants under it.
