# Design libraries

A library is a canvas whose frames are indexed as **items** with **variants**, **categories**, **tags** and
**import rules**. People browse it in a gallery, pull from it with ⌘F, and agents search and insert through
tools. Today all of this is a naming convention read by regexes.

Status: built (2026-11-14, branch `feat/design-libraries`, migrations 0066 and 0067). Plan:
[../plans/design-libraries.md](../plans/design-libraries.md); what changed from this spec while building is its
"Deviations" section (notably: the pull script reads through MCP, AI suggestions have their own column).

## Open decisions

Each one has a recommendation. The plan assumes the recommendation, so nothing blocks the build.

| #   | Decision                                                         | Recommendation                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What a library is                                                | A **canvas kind**: a canvas with a `libraries` row. Items are a rebuildable index of its frames (section "What a library is").                                                                  |
| D2  | Which existing canvas becomes the real library                   | "Design Library" (1,278 frames, sheets). Transfer the categories of "Design Library · by function" (5,412 exploded frames) onto it by item id, then archive the exploded copy.                  |
| D3  | What "infinite pages" means                                      | Categories are unlimited and are the gallery's pages. Library canvases also get a page cap of 1,000 instead of 100.                                                                             |
| D4  | Where the libraries live                                         | They are on doop.design (hosted upstream), and this feature exists only in the fork. A one-off pull script copies them to the fork instance (plan step 7.5). Needs Bryan's go and an agent key. |
| D5  | May agents write to a library                                    | Yes by default on this instance (`AGENT_LIBRARY_WRITES=true`). Rules, visibility and deletion stay people-only whatever the flag says.                                                          |
| D6  | Public libraries                                                 | Ship personal and workspace first. Public sits behind `DOOP_PUBLIC_LIBRARIES` (default off): most of the content is copied from vendors (shadcnblocks, TuffUI, footer.design), some of it paid. |
| D7  | What an insert makes                                             | A scoped snapshot, as today. An item becomes a linked component only when a person promotes it.                                                                                                 |
| D8  | Scripted sheets                                                  | Never frozen to static HTML by default. The index reads the rendered DOM instead. Freezing is a per-library rule, off.                                                                          |
| D9  | AI-written tags and descriptions                                 | Off by default, last phase. It costs model calls, billed like image descriptions.                                                                                                               |
| D10 | The per-user list of libraries (`reference_library`, 8 canvases) | Keep the table. Raise the cap to 20. Workspace libraries are included without being picked.                                                                                                     |
| D11 | Route and name                                                   | `/libraries` (list), `/l/<canvasId>` (gallery), `/l/<canvasId>/i/<itemId>` (item). Rail label "Libraries".                                                                                      |

## The problem

Read from the two live canvases on 2026-11-14 (read-only, through MCP).

- **Pages are used as categories, and they ran out.** "Design Library · by function" has 98 pages for a cap of 100
  (`MAX_PAGES` in `server/store.ts`). The page names show the squeeze: `013 Inputs & forms · Checkboxes & choice
cards + Whole forms & validation + Switches`. Three functions share one page because there is no page left.
- **One frame per variant does not scale.** The exploded canvas holds 5,412 frames (2,218 of them 760×560 cards).
  `get_canvas` returns 1.39 MB of JSON without any HTML. The original holds the same designs in 1,278 frames.
- **Metadata lives in drawn chrome.** A sheet's header says `4 variants of 8 · shadcnblocks.com/blocks/login`, or
  `19 items · tuffui.com/r · MIT`. An exploded card has a `.libbar` with the id, the label, the vendor line and a
  hand-made `view original ↗` link. No code can filter on any of it.
- **Scripted sheets hide their ids.** `cp.tuff-answers` builds 19 cells from `const P='cp.tuff-'` and an array
  `[['chart-card', …], …]`. The id `cp.tuff-chart-card` exists only after the script runs. `frameSearchText()` in
  `server/canvasFind.ts` sees `cp.tuff-` and `chart-card` as two strings, and `looksLikeId('chart-card')` in
  `FindBar.tsx` is false. So ⌘F lists no variant, and a search for the full id finds nothing.
- **The insert copies the wrong box.** In a static sheet the id sits in a caption (`.m b`) under the design
  (`.v`). `find()` in `src/lib/findPreviewRuntime.ts` climbs from the caption to the first 160×110 ancestor, which
  is the wrapper of both. The copy takes the mono caption along. (Read from the code, not reproduced.)
- **Copies lose their dependencies.** The exploded `cp.scb-login-button-passkey-dark` keeps
  `<use href="#key">`, but the `<symbol>` stayed in the sheet it was cut from. The icon is blank.
- **"Library item" is a guess.** `isLibraryItem` in `src/lib/findInsert.ts` accepts `cp.*` and `ui.*`, or any hit
  on a canvas whose name contains "design library". The real kinds are `cp` 1,738, `mo` 1,068, `footer` 781, `bk`
  652, `hero` 573, `bg` 126, `sw` 90, `tx` 62, `ft` 44, `ic` 35, `rs` 28, `as` 28. Rename the canvas and most of
  them stop inserting.
- **Search loads everything.** `/api/find` calls `store.load` on every canvas the user can open, so one ⌘F
  "everywhere" pulls the HTML of 6,690 library frames into memory.
- **Sorting is manual agent work.** Frames were last written by "SWE-2 Flash · Library sort" and "Codex · Sort 10
  · AI & chat": agents re-cut and re-placed the library by hand because nothing else could.

What already works and stays: the ids are unique (5,308 of 5,308), the grammar is regular
(`<kind>.<source>-<slug>`), and the ⌘F preview, drag and insert are good.

## User stories

**A person building a library**

- I turn a canvas into a library and see at once how many items and variants it found, and what it could not read.
- I drop a frame, a web import or an SVG into it, and the library's rules give it an id, a category and a status.
- I fix what the rules flagged in an inbox, instead of hunting through pages.
- I tag, re-categorise, deprecate or hide an item without touching its HTML.

**A person designing**

- ⌘F finds "otp" as one row per component, with its variants under it. Hover previews exactly that variant.
- I filter by kind (components, blocks, motion) and by category from the same bar.
- I open the gallery, compare every variant of an item side by side, and drop one into my frame.
- A block I inserted last month says when its library item changed, and I can pull the new version.

**An AI agent over MCP**

- `search_library` answers with families and variants, not text snippets, and `get_library_item` gives me the
  markup.
- `insert_library_item` puts the item into a frame for me, scoped and with provenance.
- `import_to_library` runs the same rules a person gets, and tells me why something was refused.

**The resident agent**

- Its prompt lists the asker's libraries. It searches them before it draws a common pattern.
- A plan card's references name items, so "Go design" starts from the right variant.

## What a library is

Three options were weighed.

| Option                           | How it works                                                                                       | For                                                                                                                                                | Against                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. **Canvas kind** (chosen)      | A canvas with a `libraries` row. Frames stay the source of truth. `library_items` is a projection. | Everything a canvas does keeps working: editor, pages, deferred HTML, room, MCP frame tools, sharing, duplicate. Nothing is migrated or rewritten. | The index can lag behind a write (bounded, see budgets). A 10k-frame canvas is still heavy to open in the editor, so the gallery must not need the room.        |
| B. Special page type             | One "library page" inside each project canvas.                                                     | Close to the designs that use it.                                                                                                                  | A library is shared across projects; a page is not. Each canvas would carry its own copy. Per-page access does not exist in `server/access.ts`.                 |
| C. New entity with its own store | `library_items` holds the HTML, like `components` does.                                            | Clean model, small rows.                                                                                                                           | A second authoring surface, a second editor, a second sync. This is the reason PR #299 was dropped (FORK.md). Bryan's 6,690 frames would need a real migration. |

Decision: **A**. "A special page with infinite pages" is read as: a special canvas whose browsing surface (the
gallery) has no page limit.

Consequences:

- A canvas is a library when `canvas.library` is set (mirrored in memory from the `libraries` table, like
  `canvas.skills`). The `canvases` table is not touched, which keeps upstream merges clean.
- The index is a **projection**, like `asset_refs`: it can be dropped and rebuilt from the frames at any time.
- What a person curates (tags, category, status) is stored apart, keyed by item id, so a rebuild never loses it.
- Converting a canvas writes no frame. Converting back deletes the projection and nothing else.

## Concepts

- **Item**: one reusable design with an id unique in its library. `bk.scb-login`.
- **Variant**: an item whose `parentId` is another item. `bk.scb-login-google-first-divider` is a variant of
  `bk.scb-login`. A variant is a full item: it has an id, can be searched, tagged and inserted.
- **Family**: an item with no parent. Search results and gallery tiles are families.
- **Sheet**: a frame that holds a family and its variants as cells.
- **Kind**: the id's first segment (`cp`, `bk`, `mo`…). A library declares its kinds, their labels and whether
  they can be inserted (`rs` resources and `as` rule cards cannot).
- **Source**: the id's second segment (`scb`, `tuff`, `fd`), a vendor or origin with a URL and a licence.
- **Category**: a path of up to three levels, `Inputs & forms/OTP & code inputs`. Unlimited in number.
- **Tag**: a free label, lowercase, at most 12 per item.
- **Status**: `active`, `draft` (failed a rule, waiting in the inbox), `deprecated`, `hidden`.

### How frames map to items

The extractor reads each frame with the library's rules and yields zero or more items.

| Frame, as found in the live libraries                                               | Yields                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Static sheet: `.hd` header, then `.g > div` cells, each `.v` (design) + `.m b` (id) | 1 family from the frame name, 1 variant per cell. The variant's box and element are the `.v`, not the caption. |
| Scripted sheet: `#g` filled by a script, cells `.c > .d` + `.m b`                   | Same, but only the rendered pass sees the cells. The static pass yields the family alone, marked `scripted`.   |
| Exploded card: `.libbar` (`.lid`, `.lbl`, `.meta`) + `.itemwrap`                    | 1 item. Its parent is the longest family id that prefixes its id (`cp.scb-login-button` for `…-passkey-dark`). |
| Section header `§ Inputs A — Text fields & core inputs` (2040×88)                   | No item. It sets the category of the frames that follow it on the page, until the next `§`.                    |
| Page title `013 Inputs & forms · … — title`, `INDEX — …`                            | No item (ignored by name).                                                                                     |
| A frame with a component main (`data-doop-component`)                               | 1 item in `component` mode. Its variants are the combinations of its enum props.                               |
| Any other frame                                                                     | 1 item for the whole frame. Its id comes from the name, or is assigned on import.                              |

Explicit markers always win over detection. An author or an agent may write them, and the import writes them when
it can:

- `data-doop-item="<id>"` on the element that is the item (on `<body>` for the whole frame);
- `data-doop-variant="<id>"` on a variant's design element;
- `data-doop-tags="dark, auth"` and `data-doop-category="Auth/Log in"` beside either.

They follow the existing `data-doop-*` rule: agents keep them when they rewrite markup.

### Ids

Grammar (`shared/libraryIds.ts`): `kind.source-slug` or `kind.slug`, lowercase, `[a-z0-9]` segments joined by
`.` then `-`, at most 120 characters. `AS-IMG-02` style ids are accepted as legacy and matched case-insensitively.

- Unique per library. A collision on import follows the rule `ids.onCollision`: `suffix` (`-2`), `reject` or
  `replace`.
- A frame named `<id> — <label>` gives its id and label. This is today's convention and stays the default naming
  rule, so the canvas and the Layers panel read the same.
- A variant with no id of its own gets `<family id>-<slug of its label>`, then `-2`, `-3`.

### Provenance and versions

- An inserted block keeps `data-doop-ref="<item id>"` (unchanged, the `@scope` selector depends on it) and gains
  `data-doop-ref-lib="<library canvas id>"` and `data-doop-ref-rev="<n>"`.
- An item's `rev` goes up by one each time its content hash changes during indexing. The HTML history itself is
  the frame's `frame_versions`; items do not store old markup.
- "Update available" means `data-doop-ref-rev` is lower than the item's `rev`. Pulling it replaces the block with
  a fresh snapshot, as one undo step, after a confirmation (local edits to the block are lost).
- Items keep `sourceUrl` and `license` from their source, shown on the item page and returned to agents.

## Data model

New tables (migration: next free number at execution time; latest on `bryann2k/main` is 0064).

```
libraries                       one row per library canvas
  canvas_id        text  pk
  description      text  not null default ''
  rules            jsonb not null          LibraryRules (shared/libraryRules.ts)
  taxonomy         jsonb not null          { kinds: Kind[], sources: Source[], categories: Category[] }
  visibility       text  not null          'private' | 'workspace' | 'public'
  index_state      jsonb                   { status, total, done, rendered, failed, startedAt, finishedAt }
  rules_version    integer not null        bumped when rules change; items indexed under an older one are stale
  disabled_at      bigint                  set by "stop being a library"; rows kept 30 days
  created_at, updated_at  bigint, updated_by text

library_items                   the projection; rebuildable
  canvas_id        text  \ pk
  item_id          text  /
  parent_id        text                    family id; null for a family
  frame_id         text  not null
  page_id          text  not null
  position         integer not null        order inside its frame
  label            text  not null
  description      text  not null
  kind             text  not null          '' when the id has none
  source           text  not null
  category         text  not null          'Unsorted' when no rule found one
  tags             jsonb not null          string[]
  mode             text  not null          'snapshot' | 'component'
  locator          jsonb not null          { whole: true } | { elementId } | { anchor }
  box              jsonb                   { x, y, w, h } in frame px; null until the rendered pass
  scripted         boolean not null
  status           text  not null          rule outcome: 'active' | 'draft'
  findings         jsonb not null          RuleFinding[] (why it is a draft, lint score, duplicate of)
  hash             text  not null
  rev              integer not null
  search_text      text  not null          visible text of the item, at most 2,000 chars
  indexed_at       bigint not null
  index (canvas_id, frame_id), index (canvas_id, parent_id), index (canvas_id, category)

library_item_meta               what people curate; never touched by a rebuild
  canvas_id, item_id            pk
  label, description, category  text, null = use the indexed value
  tags                          jsonb, null = use the indexed value
  status                        text, null | 'deprecated' | 'hidden' | 'active' (accepts a draft)
  use_count                     integer not null default 0
  last_used_at                  bigint
  updated_at, updated_by
```

- The effective item is `meta` over `library_items` (`effectiveItem` in `shared/library.ts`).
- `reference_library` (existing) stays the per-user list of libraries to search. Its cap goes from 8 to 20.
- `canvas.library` (`LibraryInfo`: description, visibility, counts, index state) rides on the canvas object.
  Rules and taxonomy are fetched on demand, not broadcast.
- A copied canvas (`store.duplicateCanvas`) copies its `libraries` row and `library_item_meta`, then reindexes.
- Deleting a canvas deletes all three.

## Infinite pages, and 10,000 items

- **Categories replace pages as the unit of browsing.** The gallery shows one virtual page per category. There is
  no limit and nothing to renumber.
- **Canvas pages stop being the bottleneck.** `maxPages(canvas)` returns 1,000 for a library and 100 otherwise.
  `PagesPanel` gets a filter field and a windowed list above 100 pages.
- **Nothing loads everything.**
  - Queries read the in-memory search index, built from `library_items` rows. No frame HTML is involved.
  - The index of one library is built on first use and dropped after 10 idle minutes, like frame HTML.
  - Tiles are images. A live iframe exists only for the item a person hovers or opens.
  - Reading one item's markup uses `store.renderableFrame(frameId)`, which reads one frame, never `store.load`.
  - A full reindex walks frames in batches of 50 through `renderableFrame`, so memory stays flat.
  - The gallery never joins the canvas room, so the 1.4 MB frame list of a big canvas is not sent.
- **Sheets over exploded frames.** With real variants, 1,278 sheets carry what 5,412 cards carried. The editor's
  culling, LOD and per-page deferred HTML then have a canvas a quarter the size to deal with.

## Import rules

Rules belong to a library and are edited in its settings (`LibraryRules`, `shared/libraryRules.ts`, versioned
JSON). They run in two places: when a frame is **imported** (added through "Add to library", a tool, or any
import that lands on a library canvas), and when the library is **indexed**. Import may change the frame;
indexing never does.

```ts
interface LibraryRules {
  version: 1
  ids: {
    pattern: 'kind.source-slug' | 'kind.slug' | 'slug'
    onCollision: 'suffix' | 'reject' | 'replace'
  }
  naming: { frameName: '{id} — {label}' | '{label}' }
  detect: {
    /** frame names that are not items: section headers, page titles, indexes */
    ignore: string[] // globs: '§ *', '* — title', 'INDEX*'
    /** a frame whose name matches starts a category for the frames after it */
    section: string | null // '§ * — {category}'
    variants: {
      mode: 'auto' | 'selectors' | 'none'
      cell?: string // '.g > div'
      id?: string // '.m b'
      label?: string
      design?: string // '.v': what is previewed, boxed and copied
    }
  }
  categorise: { by: ('marker' | 'section' | 'page' | 'kind')[]; kindMap: Record<string, string>; fallback: string }
  css: { inlineSymbols: boolean; pruneUnused: boolean; freezeScripts: 'never' | 'ask' | 'always' }
  tokens: { map: 'off' | 'suggest' | 'apply' }
  lint: { gate: 'off' | 'warn' | 'draft'; minScore: number; ignoreRules: string[] }
  dedup: { by: ('id' | 'hash')[]; onDuplicate: 'draft' | 'skip' | 'replace' }
  placement: { page: 'category' | 'current'; gap: number }
  search: { synonyms: Record<string, string[]> }
}
```

What an import does to a frame, in order (`server/libraryImport.ts`, one pure function per stage, all reported in
an `ImportReport` that a dry run returns without writing):

1. **Ignore**: a name matching `detect.ignore` is placed but yields no item.
2. **Id**: read from the name or a marker; otherwise assigned from kind, source and a slug of the label. Checked
   against the grammar and for collisions.
3. **Naming**: the frame is renamed to `naming.frameName`.
4. **Variants**: cells are found by the selectors, or by `auto`. `auto` looks for repeated sibling blocks that
   each hold exactly one text matching the id grammar; the design element is the largest child that does not hold
   that text. Static cells get `data-doop-variant` and a `data-doop-id` (through `server/elementIds.ts`).
5. **Dependencies**: `<symbol>`, `<linearGradient>` and other `<defs>` an item's `<use>` or `url(#…)` points at
   are copied in when the source frame has them (`css.inlineSymbols`). CSS no selector uses is dropped
   (`css.pruneUnused`, by selector name as `server/componentCss.ts` does, never a guess on dynamic classes when
   the frame is scripted).
6. **Tokens**: literal colours, radii and font families that equal a token of the library canvas
   (`shared/designTokens.ts`, `resolveToken`) are listed (`suggest`) or rewritten to `var(--name)` (`apply`).
7. **Lint gate**: `lintFrame` (`server/lint.ts`, `shared/slopRules.ts`) scores the frame. Under `minScore`, `warn`
   records a finding and `draft` also keeps the item out of search until a person accepts it. Nothing is ever
   refused outright: a draft is the strictest outcome.
8. **Dedup**: an item whose id exists follows `ids.onCollision`. One whose content hash equals another item's is
   flagged `duplicateOf` and follows `dedup.onDuplicate`.
9. **Categorise**: the first of `categorise.by` that answers. `marker` is `data-doop-category`; `section` is the
   last section frame above it; `page` is the page name with its leading number removed; `kind` is `kindMap`.
10. **Placement**: the frame goes to the page of its category (created if missing) or the current page, appended
    below the last frame with `placement.gap`.

Presets (`RULE_PRESETS`): `blank` (whole-frame items, no gate) and `sheets` (Bryan's convention: `{id} — {label}`,
`§ *` sections, `* — title` and `INDEX*` ignored, `auto` variants, gate `warn`). Converting a canvas picks the
preset that explains more of its frame names.

## Search and ⌘F

### The index

`shared/librarySearch.ts`, pure and synchronous, one index per library.

- **Tokens**: lowercase, diacritics folded, split on anything that is not a letter or digit. An id is kept whole
  and also split (`cp.scb-otp-input` gives `cp.scb-otp-input`, `cp`, `scb`, `otp`, `input`). Synonyms from the
  rules expand the query, not the index.
- **Fields and weights**: id 10, label 6, tags 5, category 4, source and kind 3, description 2, text 1.
- **Matching**: every query token must match (AND); the last token matches as a prefix. No result under AND falls
  back to OR. No result at all tries one edit of distance 1 on tokens of 5 characters or more.
- **Ranking**: BM25 over the weighted fields, then: exact id +1000, id segment +400, family over lone variant
  +50, `log(1 + use_count)` × 20, `deprecated` −500. `hidden` and `draft` are left out unless asked for.
- **Filters**: `kind:cp`, `in:"Inputs & forms"`, `tag:dark`, `source:scb`, `is:scripted|component|deprecated|draft`
  in the query, or the same as request parameters.
- **Facets**: counts per kind, top-level category, source and tag over the whole match set, before paging.
- **Grouping**: hits are families. A family carries its matched variants (best first) and its total variant
  count. A variant that matches alone still appears under its family.

Rejected: Postgres full-text search. PGlite and Postgres would need to agree on ranking and prefix behaviour, the
store is already in memory, and facets and grouping are easier to keep exact in code.

### Wire shape

```ts
interface LibrarySearchHit {
  libraryId: string
  libraryName: string
  item: LibraryItemSummary // id, label, kind, source, category, tags, status, frameId, locator, box, thumb, rev
  variants: LibraryItemSummary[] // the matched ones, at most 12
  variantCount: number
  score: number
}
interface LibrarySearchResult {
  hits: LibrarySearchHit[]
  total: number
  facets: Record<'kind' | 'category' | 'source' | 'tag', { value: string; label: string; count: number }[]>
  cursor?: string
}
```

`GET /api/libraries/search?q=&lib=&kind=&category=&tag=&source=&status=&limit=&cursor=`. Without `lib` it covers
every library the caller may read and has in their list.

### ⌘F

- A fourth scope, **Library**, beside page, canvas and everywhere. The scope control becomes a `DropdownMenu` with
  `DropdownMenuRadioGroup`. Library is the default when the canvas is a library or the person has one in their
  list.
- Rows are families with their variants underneath, as today's grouped rows, but they come from the index. The
  code that guessed them is deleted: `LIBRARY_ID`, `looksLikeId`, `variantIds`, `splitFrameName` in
  `FindBar.tsx`; `LIBRARY_ID` and `LIBRARY_CANVAS` in `findInsert.ts`. `isLibraryItem` becomes "the row has an
  item whose kind is insertable".
- Kept as they are: the hover intent, `FindPreview`, `useFindDrag`, `insertLibraryItem`, `InsertedBlockBox`, the
  footer hint, ↩ / ⇧↩ / ⌘C.
- The preview and the snapshot are told where the item is (`locator`) instead of searching for a text. The
  runtime's `find(term)` stays as the fallback for `{ anchor }`.
- A row of kind chips (`ToggleChip`, `size="sm"`) sits under the field in the Library scope. The footer has
  "Open in gallery", which goes to `/l/<id>?q=<query>`.
- The page, canvas and everywhere scopes keep their text search. "Everywhere" answers for library canvases from
  the index and no longer loads their HTML.

### Agent tools

Defined once in `server/libraryTools.ts` (`DESIGN_LIBRARY_TOOLS`, the shape `server/componentTools.ts` uses) and
registered for MCP and for the resident agent under the same names, so `tests/agentToolParity.test.ts` passes
without a new exception.

| Tool                  | Input                                                                                                                        | Returns                                                                                            | Writes                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| `list_libraries`      | none                                                                                                                         | The libraries this account can use: id, name, item and variant counts, kinds, top categories.      | no                          |
| `get_library`         | `library_id`                                                                                                                 | Description, kinds, sources, the category tree, the rules in plain words, the index state.         | no                          |
| `search_library`      | `query`, `library_id?`, `kind?`, `category?`, `tag?`, `source?`, `include_drafts?`, `limit?` (default 20, max 50), `cursor?` | `LibrarySearchResult` with `thumbnail` and `url` per item.                                         | no                          |
| `get_library_item`    | `library_id`, `item_id`, `include_html?`                                                                                     | The item, its variants, source and licence, findings, and with `include_html` its scoped snapshot. | no                          |
| `insert_library_item` | `canvas_id`, `frame_id`, `library_id`, `item_id`, `after_element_id?`                                                        | The new block's `element_id`, the frame's lint notes, `fidelity: 'rendered' \| 'static'`.          | the target frame            |
| `import_to_library`   | `library_id`, `frame_ids` (1-20), `category?`, `tags?`, `dry_run?`                                                           | The `ImportReport`: ids given, variants found, findings, duplicates, what was placed where.        | the library (gated)         |
| `set_library_item`    | `library_id`, `item_id`, `label?`, `description?`, `category?`, `tags?`, `status?`                                           | The effective item.                                                                                | `library_item_meta` (gated) |

- There is no separate "list variants" tool: `get_library_item` returns them, and every tool spent is prompt
  budget.
- `find_references` (chat) keeps its name and shape and is answered by the index. A reference may carry an
  `itemId` (`ChatPlanReference` in `shared/types.ts`).
- `find_in_canvas` is unchanged: it is the text search.
- For the resident agent, the libraries are the asker's list plus the canvas's workspace libraries
  (`runState.libraryCanvases`). `import_to_library` and `set_library_item` work only when the run's own canvas is
  the library.
- The guide (`server/guide.ts`) gains a "Libraries" section: search before drawing a common pattern, insert then
  adapt to the frame's tokens, keep `data-doop-ref*`, write the item markers when authoring library content.

## The gallery

Built from `src/components/ui` only (the ESLint rule holds new files to it), with strings in a new `library`
i18n namespace (`en` and `pt-BR`).

**Libraries** (`/libraries`, `src/pages/Libraries.tsx`): `AppRail` with a new "Libraries" row, `DashHeader
variant="bare"`, a grid of `Tile`s (cover: four item thumbnails; `MetaLine`: items · variants · owner), an
`EmptyState` whose action is "Turn a canvas into a library".

**Gallery** (`/l/<id>`, `src/pages/LibraryPage.tsx`):

- Header: the library's name as `DashTitle`, a `SearchField size="header"` (⌘F focuses it, `Kbd` trailing), a
  `Button size="bar"` "Open canvas", a `MenuButton` for settings, inbox and reindex.
- Left: the category tree, `DashNavItem density="rail"` rows with `count`, and kinds as `ToggleChip`s above it.
- Main: a windowed grid of item tiles (`Tile`, `TileCover aspect="4/3"` with the item's thumbnail on its own
  background, `TileBody` with the id in mono `text-caption` and the label, a `Badge` for the variant count, a
  `Badge tone="outline"` for draft or deprecated). 60 items per request, more on scroll.
- State lives in the URL (`?q=&kind=&in=&tag=`), so a view can be linked.
- Hover on a tile for 400 ms swaps the image for the live preview (one iframe at a time, sandboxed).
- A tile drags like a ⌘F row when the gallery was opened from a canvas.

**Item** (`/l/<id>/i/<itemId>`, also a `Sheet` over the gallery):

- Head: id (mono, click copies), label, kind and status `Badge`s, source link and licence, category breadcrumb.
- **Variants side by side**: every variant in a grid of live previews at one scale, each with its id, a "Use"
  `Button` and a copy-id `IconButton`. Scripted sheets carry the "static once inserted" note that ⌘F shows.
- Actions: `Button variant="primary"` "Use in « frame »" when opened from a canvas with a frame selected, else
  "Use in a canvas…" (`CanvasSearchModal`). "Open in canvas" flies to the frame. "Promote to component".
- `Tabs`: Variants, Details (description, tags, category, editable in place for editors), Findings (rule
  outcomes, lint), Used in (frames carrying its `data-doop-ref`, from a scan of the caller's recent canvases).

**In the canvas** (`src/components/library/LibraryPanel.tsx`): a fourth tab of the Layers panel beside Layers,
Components and Tokens. A library `Select`, a `SearchField`, the category tree collapsed to one level, a
two-column grid of tiles. Click inserts into the selected frame, drag drops between elements (`useFindDrag`),
⇧ click opens the item.

**"Use in this frame"** from the gallery: the canvas opens the gallery as `/l/<id>?from=<canvasId>&frame=<frameId>`.
"Use" calls `POST /api/libraries/:id/items/:itemId/insert` and returns to the canvas with the block picked and
`InsertedBlockBox` open.

**Building**: `ConvertToLibraryModal` (preset, the dry-run counts, what was ignored, what could not be read),
`LibraryRulesForm` (a `SettingsCard` per rule group with `CardRow`s, and a live dry run on the right),
`LibraryInbox` (drafts with their findings, a `SelectionBar` with Accept, Hide and Re-run rules).

## Sharing and permissions

`libraryRole(userId, canvas)` in `server/libraries.ts` is the one gate for library routes and tools.

| Visibility  | Who reads items (search, gallery, insert)                        | Who curates (meta, import, rules)                      |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `private`   | Whoever `canAccessCanvas` lets in                                | Whoever `canEditCanvas` lets in                        |
| `workspace` | The same; the canvas must be in a workspace, so every member has | The same. Rules and visibility need `canManageCanvas`. |
| `public`    | Every signed-in account on the instance                          | The same as above; public never grants a write         |

- A library read is **not** canvas access. `canvasRole` is not changed. A public library's reader gets items,
  thumbnails and item markup through the library routes only: no room, no `/api/canvases/:id`, no frame tools.
  This is the split `server/community.ts` already makes for published canvases.
- Share links stay canvas links. A `view` link lets its holder browse the gallery of that canvas.
- Changing rules or visibility, converting and disabling need `canManageCanvas` (the owner, or a workspace
  admin).
- A person's list (`reference_library`) can hold any library they can read. Workspace libraries are in every
  member's list without being picked.
- Public libraries appear on a "Libraries" shelf in Community, where "Copy" duplicates the canvas with its rules
  and curation. Making one public shows a warning about third-party content and needs
  `DOOP_PUBLIC_LIBRARIES=true`.

## Migration

Turning the existing canvases into libraries changes no frame.

1. **Convert**: "Turn into a library" (canvas menu, and the Libraries page). The dry run reports families,
   variants, ignored frames, frames it could not read, duplicates. Apply creates the `libraries` row and starts
   the index. The `sheets` preset reads today's names, sections and sheets as they are.
2. **Render pass**: scripted sheets get their variants, every variant gets a box and a thumbnail.
3. **Transfer categories** (D2): for each item id present in both libraries, copy the category of "by function"
   into the `library_item_meta` of "Design Library". Ids are unique in both, so the match is exact. The report
   lists ids that exist on one side only.
4. **Inbox**: whatever the rules flagged. Nothing is hidden until a person chooses the `draft` gate.
5. **Old behaviour until then**: a canvas that is not a library still gets the text scopes of ⌘F. The name-based
   guess is removed in the same step that adds the Library scope, and step 1 is one click.
6. **Undo**: "Stop being a library" sets `disabled_at`. The index is dropped, the rules and curation are kept for
   30 days and restored if the canvas is converted again.
7. **Across instances** (D4): the live canvases are on doop.design. `scripts/pull-library.ts` reads a canvas page
   by page from a remote Doop with an agent key and recreates it locally with the same frame names, pages and
   HTML. It only reads from the source.

## Budgets

| What                                      | Budget                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| Search, server side, 10,000 items         | p95 under 15 ms                                               |
| ⌘F keystroke to rows on screen            | under 150 ms after the 120 ms debounce                        |
| Index build for 10,000 items from rows    | under 400 ms, under 40 MB                                     |
| Static reindex of one frame after a write | under 20 ms of CPU, within 2 s of the write (debounced)       |
| Full static reindex of 5,000 frames       | under 60 s, memory flat (batches of 50)                       |
| Rendered pass                             | background priority in the renderer gate, 2 pages at most     |
| Gallery first page                        | under 1 s, 60 items, no iframe mounted                        |
| Live iframes in the gallery               | 1; in the item view, 12 at most, the rest images              |
| Search response                           | under 60 KB for 20 families                                   |
| Item snapshot from the server             | under 3 s rendered; static fallback when the renderer is busy |

## Security

- **Item markup is untrusted.** It renders only in sandboxed iframes (`sandbox="allow-scripts"`, never
  `allow-same-origin`) under the frame CSP, as `FindPreview` does. Tiles are server-rendered images.
- **Snapshots are inert.** Scripts are removed already; the snapshot also drops `on*` attributes,
  `javascript:` URLs, `<iframe>`, `<object>`, `<embed>` and `<base>`.
- **Rules carry selectors.** They are capped at 200 characters, compiled in a `try`, and run only inside the
  sandboxed renderer page or over parse5 nodes, with the 5 s deadline `server/cssPrune.ts` uses.
- **Agent writes are gated.** `AGENT_LIBRARY_WRITES` (`server/env.ts`, default true) covers `import_to_library`
  and `set_library_item`; when false they answer "libraries on this instance are curated by people; propose the
  item in a comment instead", the wording `AGENT_GUIDELINE_WRITES` uses. No tool changes rules, visibility or the
  existence of a library.
- **Reads go through one gate.** Every route and tool calls `libraryRole`. Search is limited to libraries that
  pass it, and to 30 requests per 10 s per account. `insert_library_item` also needs `canEditCanvas` on the
  target.
- **Provenance is not authority.** `data-doop-ref*` attributes are never used to grant anything.
- **Licences.** Items show their source and licence. Public sharing is off by default (D6).
- No new outbound request, so no new SSRF surface. The pull script runs by hand, outside the server.

## AI curation

Built 2026-11-14 (branch `feat/ai-library-curation`, migration 0068). Bryan's library is four
canvases whose page names are numbered and split alphabetically (`01 Heroes · AI products · A–L`,
`02 … · L–Z`); categories read from them were junk.

- **One merged library, sources untouched.** A curation reads up to 8 canvases the requester
  manages, folds duplicates (same markup, or same label and text across sources; the first source
  wins) and keeps a family's cards in one entry.
- **The model builds the tree from the items.** A spread of up to 450 entries (name, page, a
  little text) goes to the requester's own configured model, which answers a tree of at most three
  levels with short human names; the answer is read strictly (`parseTree`). The account's small
  tier then files every entry, 60 per call (`n|name|page|WxH|text`, about 100 characters each),
  answered as `{"a":{"1":"c12"}}` (`parseAssignments`). Thumbnails are not sent: vision on 7,000
  items would cost ten times more for little gain over names and text.
- **Review before writing.** The plan (tree, assignments, duplicates, entries already in another
  library) is edited with `rename`, `merge`, `delete`, `move`, `add`, `assign`; nothing is written
  but the job row until apply.
- **Apply.** A new canvas, one page per category with items (named by path; up to 1,000 pages as
  the canvas becomes a library), copies in a shelf grid, then `createLibrary` with the tree as its
  taxonomy and the category read from the page first.
- **Cost.** About `ceil(items / 60) + 1` calls, plus retries; 400 at most. Usage is totalled on the
  job and priced with `shared/modelPrices.ts`.
- **No account, no curation.** The server tier is never spent on it.

Also: **Start empty** (`POST /api/libraries/new`, starting categories typed or suggested by the
same model routing) and the import's chosen category written as `data-doop-category`, so the
index keeps it (before, the page rule kept the top level only).

## Duplicates on import

Built 2026-11-14 (migration 0069). Provenance lives in the frame HTML so the projection can be
rebuilt: `doop-import-source` (website imports) or `data-doop-source-url` gives
`library_items.source_key` (normalised: host without `www`, path without trailing slash, non-tracking
query kept, no scheme or fragment); `data-doop-origin="<canvasId>:<frameId>"` (every import and
curation copy, the first origin kept) gives `origin`. Every import (REST, Add to library…, Start
empty, MCP and resident `import_to_library`, the curation for other libraries) checks every library
the person can use: `same-url`, `same-content` (origin or family hash), `similar` (word Jaccard ≥
0.8 on name and text). Matches are not imported unless `force` or `as_variant_of`; `check_library`
and `POST /api/libraries/check` ask without writing.

## Out of scope

- Live-linked snapshot items. A block that must follow its source is a component (`<doop-use>`).
- Editing variants visually. Variants are edited in the sheet, in the canvas editor.
- A marketplace, payments, ratings.
- Federation between Doop instances beyond the one-off pull script.
- Embedding-based (semantic) search. Synonyms and optional AI tags cover the need for now.
- Auto-arranging a library page as a managed grid.
- Mapping Figma libraries.
- The iOS app.
