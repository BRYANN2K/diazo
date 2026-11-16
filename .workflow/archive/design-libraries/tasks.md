# Design libraries - implementation plan

Spec: [design-libraries spec](../../specs/design-libraries.md). Read it first: this plan names things the spec
defines (`LibraryRules`, `libraryRole`, the tables, the tools) and does not repeat them. Status: proposed, waiting
for Bryan's go. The open decisions D1-D11 of the spec are assumed as recommended.

9 phases, 40 steps. Phase 1 is a thin vertical slice: turn a canvas into a library, index it, and search it from
⌘F and MCP.

## Executor rules

- One branch, `feat/design-libraries`, started from `bryann2k/main`. One commit per step, conventional, lowercase
  subject, scope `library` (`feat(library): static extractor for sheets and exploded cards`).
- Tests first: write the step's tests, see them fail, then write the code.
- Before each commit: `bun run typecheck`, then the lint line below, then the step's test files with
  `bunx vitest run <files> --maxWorkers=4`.
- The whole suite (`bunx vitest run --maxWorkers=4`) runs at the end of each phase, and only when the 1-minute
  load is under 20 (`sysctl -n vm.loadavg`). Parallel suites crashed the Mac: never start two.
- Lint: `bunx oxlint --type-aware --deny-warnings --ignore-pattern '.claude/**' . && bunx eslint . --max-warnings 0`.
- Stage files by explicit path. Never `git add -A` or `git add .`.
- No push, no deploy, no change on another branch or worktree.
- English in code, comments and docs. Use the `clean-code:typescript` skill for every TypeScript file.
- Migrations: use the **next free number at execution time** (the latest on `bryann2k/main` is 0064 today).
  Generate with `npx drizzle-kit generate`, check the journal and snapshot, and never renumber an existing one.
- i18n: every new string goes into `src/lib/i18n/en/library.ts` and `src/lib/i18n/pt-BR/library.ts` in the same
  commit. A key missing from `pt-BR` fails the type check.
- UI: new files under `src/components/**` and `src/pages/**` compose `src/components/ui` only (the ESLint rule
  refuses raw `<button>`, `text-[…]`, hex colours). A new primitive needs a story in `src/stories/`.
- Docs: the "Docs" line of a step says what to update. `bun run doc-lint` must pass at the end of each phase.
- Tasks: one Promethee task per step in the "Doop" project, created when the step starts, completed when it is
  committed.
- A step that turns out wrong about the code (a function that does not exist, a different seam) is fixed in
  place: keep the goal and the acceptance criteria, note the deviation in the commit body.

## Fixtures

Step 0.1 creates these under `tests/fixtures/library/`. They are reduced from the live libraries and are the
ground truth for every extractor, collector and snapshot test.

`sheet-static.html`, frame name `bk.scb-login — shadcnblocks · Login (4)`, 2040×440:

```html
<!doctype html>
<html>
  <head>
    <style>
      .hd {
        height: 72px;
        display: flex;
        gap: 18px;
      }
      .g {
        display: grid;
        grid-template-columns: repeat(4, 490px);
        gap: 20px 12px;
      }
      .v {
        width: 490px;
        height: 300px;
        overflow: hidden;
        background: #fff;
      }
      .v.dk {
        background: #09090b;
      }
      .m {
        font: 10px/1.5 monospace;
        color: #7d7a72;
      }
      .b {
        background: #09090b;
        color: #fff;
        height: 44px;
      }
      .ic {
        width: 20px;
        height: 20px;
        stroke: currentColor;
      }
      @keyframes pu {
        50% {
          opacity: 0.4;
        }
      }
      .unused {
        color: red;
      }
    </style>
  </head>
  <body>
    <svg width="0" height="0">
      <symbol id="key" viewBox="0 0 24 24"><path d="M2 12h20" /></symbol>
    </svg>
    <div class="hd">
      <span class="k">bk · scb</span>
      <h1>shadcnblocks · Login</h1>
      <p>Sign-in screens: keep one primary path.</p>
      <span class="r">4 variants of 8 · shadcnblocks.com/blocks/login</span>
    </div>
    <div class="g">
      <div>
        <div class="v">
          <span class="b"
            >Sign in<svg class="ic"><use href="#key"></use></svg
          ></span>
        </div>
        <div class="m"><b>bk.scb-login-minimal-email-password</b> · 420px column, focus ring 4px</div>
      </div>
      <div>
        <div class="v dk"><span class="b" onclick="x()">Log in</span></div>
        <div class="m"><b>bk.scb-login-social-with-email-option</b> · dark, 3 stacked provider buttons</div>
      </div>
    </div>
    <script>
      setInterval(() => document.body.classList.toggle('go'), 8000)
    </script>
  </body>
</html>
```

`sheet-scripted.html`, frame name `cp.tuff-answers — TuffUI · Interactive answers (3)`, 2040×714:

```html
<!doctype html>
<html>
  <head>
    <style>
      #g {
        display: grid;
        grid-template-columns: repeat(8, 240px);
        grid-auto-rows: 200px;
        gap: 12px;
      }
      .c {
        display: flex;
        flex-direction: column;
      }
      .d {
        flex: 1;
        display: grid;
        place-items: center;
      }
      .m {
        height: 52px;
      }
      .m b {
        display: block;
      }
    </style>
  </head>
  <body>
    <header>
      <span class="k">tuff · E</span>
      <h1>TuffUI · Interactive answers (3)</h1>
      <span class="n">3 items · tuffui.com/r · MIT</span>
    </header>
    <div id="g"></div>
    <script>
      const P = 'cp.tuff-'
      const I = [
        ['chart-card', 'bars grow 500ms', '<div class="sh">Tickets</div>'],
        ['dot-histogram', 'every sample a dot', '<svg width="210" height="108"></svg>'],
        ['json-viewer', 'collapsible tree', '<pre class="js">{ }</pre>'],
      ]
      const G = document.getElementById('g')
      I.forEach(([id, r, h]) =>
        G.insertAdjacentHTML(
          'beforeend',
          `<div class="c"><div class="d">${h}</div><div class="m"><b>${P}${id}</b><span>${r}</span></div></div>`,
        ),
      )
    </script>
  </body>
</html>
```

`card-exploded.html`, frame name `cp.scb-login-button-passkey-dark — Sign in with passkey · inverted on dark`,
760×560:

```html
<!doctype html>
<html>
  <head>
    <style>
      .libbar {
        display: flex;
        gap: 10px;
      }
      .itemwrap {
        padding: 18px;
      }
      .v {
        width: 490px;
        height: 260px;
      }
      .lb {
        height: 40px;
      }
    </style>
  </head>
  <body>
    <div class="libbar">
      <span class="lid">cp.scb-login-button-passkey-dark</span>
      <span class="lbl">Sign in with passkey · inverted on dark · key icon</span>
      <span class="meta">shadcnblocks · Auth entry buttons</span>
      <a href="https://doop.design/c/SwKb3CgHjZ?frame=rqvwy9ECNp">view original ↗</a>
    </div>
    <div class="itemwrap">
      <div>
        <div class="v dk"><span class="lb">Sign in with passkey</span></div>
      </div>
    </div>
  </body>
</html>
```

Plus `names.json`: 40 real frame names, covering `§ Inputs A — Text fields & core inputs`,
`013 Inputs & forms · Checkboxes & choice cards + Whole forms & validation + Switches — title`,
`INDEX — all domains & pages`, `AS-IMG-02 — One icon family, one stroke`, `rs.shadcnblocks — rs.shadcnblocks`,
`footer.fd-dark-1 — footer.design · Dark 1/3 (12)`, `mo.tk-staggered-y-spin — rotateY 0 → 360°`,
`photo-stack — stack`, and a plain `Login screen`.

`tests/libraryFixtures.ts` exports `fixture(name)`, `libraryCanvas(frames)` (a `Canvas` with pages and frames
built from the fixtures) and `syntheticItems(n)` (deterministic `LibraryItem[]` for the 10,000-item tests).

## Phase 0 - Foundations

Pure code in `shared/`, no server, no UI. The three steps are independent after 0.1.

### 0.1 Types, id grammar, fixtures

- **Goal**: the vocabulary every later step imports.
- **Files**: `shared/library.ts` (`LibraryInfo`, `LibraryItem`, `LibraryItemMeta`, `LibraryItemSummary`,
  `ItemLocator`, `ItemBox`, `ItemStatus`, `RuleFinding`, `LibraryTaxonomy`, `LibraryKind`, `LibrarySource`,
  `LibraryCategory`, `effectiveItem(item, meta)`, `familyOf(items)`); `shared/libraryIds.ts` (`ITEM_ID_RE`,
  `parseItemId(id)` → `{ kind, source, slug }`, `splitFrameName(name)` → `{ id, label }` moved here from
  `FindBar.tsx`, `itemSlug(label)`, `assignItemId({ kind, source, label }, taken, onCollision)`,
  `parentIdOf(id, familyIds)` longest prefix followed by `-`); `tests/fixtures/library/*`;
  `tests/libraryFixtures.ts`.
- **Tests first**: `tests/libraryIds.test.ts`: every name of `names.json` splits as expected; `AS-IMG-02` is a
  legacy id; `photo-stack` has no kind; `parentIdOf('cp.scb-login-button-passkey-dark', ['cp.scb-login',
'cp.scb-login-button'])` is `cp.scb-login-button`; `cp.scb-loginx` is not a child of `cp.scb-login`; collisions
  under `suffix`, `reject`, `replace`; ids longer than 120 are refused. `tests/library.test.ts`: `effectiveItem`
  prefers meta, a null meta field falls through, `status` meta `active` accepts a draft.
- **Accept**: no import from `server/` or `src/`; `FindBar.tsx` still compiles using the moved `splitFrameName`.
- **Docs**: none.

### 0.2 Rules model

- **Goal**: `LibraryRules` with defaults, presets and a strict parser.
- **Files**: `shared/libraryRules.ts` (`LibraryRules`, `DEFAULT_LIBRARY_RULES`, `RULE_PRESETS.blank`,
  `RULE_PRESETS.sheets`, `parseLibraryRules(raw)` → `{ ok, rules } | { ok: false, errors }`, `nameMatches(glob,
name)`, `sectionCategory(pattern, name)`, `detectPreset(frameNames)`, `describeRules(rules)` → plain-language
  lines for `get_library`, `MAX_SELECTOR = 200`).
- **Tests first**: `tests/libraryRules.test.ts`: defaults parse; unknown keys are dropped; a selector over 200
  characters, an unknown enum value and a `minScore` outside 0-100 are errors with a path; `nameMatches('§ *', …)`
  and `'* — title'`; `sectionCategory('§ * — {category}', '§ Inputs A — Text fields & core inputs')` is
  `Inputs/Text fields & core inputs` (the letter after the domain is dropped); `detectPreset(names.json)` is
  `sheets`, and `blank` for ten plain names.
- **Accept**: `parseLibraryRules(JSON.parse(JSON.stringify(rules)))` round-trips every preset.
- **Docs**: none.

### 0.3 Search core

- **Goal**: the index, the query language, ranking, facets and grouping, as pure functions.
- **Files**: `shared/librarySearch.ts` (`tokenize(text)`, `idTokens(id)`, `parseQuery(q)` → `{ terms, filters }`,
  `buildIndex(items, taxonomy)` → `LibraryIndex`, `searchIndex(index, query, { limit, cursor, includeDrafts,
synonyms })` → `LibrarySearchResult` without the library fields, `FIELD_WEIGHTS`), with postings in typed
  arrays; `shared/library.ts` gains `LibrarySearchHit`, `LibrarySearchResult`, `LibraryFacet`.
- **Tests first**: `tests/librarySearch.test.ts`: `otp` returns the family `cp.scb-otp-input` first and nests its
  matching variants; the exact id outranks a label match; `log bu` matches `login button` (prefix on the last
  term); AND falls back to OR; `buton` finds `button` only when nothing else matches; `kind:cp in:"Inputs &
forms" tag:dark otp` filters; facets count the whole match set, not the page; a hidden item never appears and a
  draft appears only with `includeDrafts`; a deprecated one sinks; the cursor pages without repeats; a synonym
  `{ login: ['sign in'] }` widens the query; `syntheticItems(10_000)` builds in under 400 ms and answers 200
  queries with a p95 under 15 ms (use `performance.now()`, generous ×3 margin so the test is not flaky).
- **Accept**: no dependency added; no `Date.now()` or randomness inside the index.
- **Docs**: none.

## Phase 1 - Vertical slice: convert, index, search

After this phase Bryan can convert "Design Library", type `otp` in ⌘F and get families with variants from a real
index, and an agent can call `search_library`.

### 1.1 Tables and the in-memory mirror

- **Goal**: store libraries, items and curation; hydrate them; expose `canvas.library`.
- **Files**: `server/db/schema.ts` (`libraries`, `libraryItems`, `libraryItemMeta` as in the spec);
  `server/db/migrations/<next>_design_libraries.sql` + journal + snapshot; `server/db/persist.ts`
  (`saveLibrary`, `deleteLibrary`, `replaceFrameItems(canvasId, frameId, items)`, `deleteItemsOfFrame`,
  `loadLibraryItems(canvasId)`, `saveItemMeta`, `loadItemMeta(canvasId)`, hydrate the `libraries` rows in
  `hydrate()`, delete all three in the canvas deletion path, copy `libraries` and `library_item_meta` in the
  duplicate path); `server/libraries.ts` (`getLibrary(canvasId)`, `createLibrary(canvasId, preset, actor)`,
  `updateLibrary`, `disableLibrary`, `libraryRole(userId, canvas)` → `'read' | 'curate' | 'manage' | null`,
  private visibility only for now, `libraryInfo(canvas)`); `shared/types.ts` (`Canvas.library?: LibraryInfo`,
  `ServerMessage` gains `{ type: 'library'; library: LibraryInfo | null; actor }`); `server/store.ts`
  (`setLibrary(canvasId, info)`).
- **Tests first**: `tests/libraries.test.ts` (mock `server/db/persist.ts` as `tests/agentToolParity.test.ts`
  does): `createLibrary` picks the preset from the frame names, sets `canvas.library`, broadcasts `library`;
  `libraryRole` is `manage` for the owner, `curate` for an invited member, `read` for a view-link visitor, null
  for a stranger; `disableLibrary` clears `canvas.library` and keeps the row. `tests/librariesHttp.test.ts`
  (real server through `tests/harness.ts`) is created here with one case: a library survives a restart.
- **Accept**: a boot on an existing database applies the migration and changes no `canvases` row; PGlite and
  Postgres both run it.
- **Docs**: none yet.

### 1.2 Static extractor

- **Goal**: frame HTML + rules → items, with no browser.
- **Files**: `server/libraryExtract.ts` (`extractFrameItems({ frame, pageName, sectionCategory, rules, taxonomy
})` → `{ items: ExtractedItem[], scripted: boolean, ignored: boolean }`, built on parse5 like
  `server/elementIds.ts`; helpers `findCells(doc, rules)`, `autoCells(doc)`, `itemText(node)`, `contentHash`,
  `sourceLine(doc)` reading `tuffui.com/r · MIT` style lines into `{ sourceUrl, license }`).
- **Tests first**: `tests/libraryExtract.test.ts`:
  - `sheet-static.html` gives the family `bk.scb-login` (label `shadcnblocks · Login`, kind `bk`, source `scb`)
    and two variants whose locator is the `.v` (`{ elementId }` when the `.v` has a `data-doop-id`, else
    `{ anchor: '<id>' }`), with `parentId` set and positions 0 and 1;
  - with `variants.mode: 'selectors'` and the selectors of the spec, the same result as `auto`;
  - `sheet-scripted.html` gives the family alone, `scripted: true`;
  - `card-exploded.html` gives one item whose label comes from the frame name and whose `search_text` holds
    `Sign in with passkey` but not the `.libbar` text;
  - an ignored name gives `ignored: true` and no item; a `§` frame gives no item;
  - `data-doop-item`, `data-doop-variant`, `data-doop-tags`, `data-doop-category` win over detection;
  - a frame with `data-doop-component` gives `mode: 'component'`;
  - `mode: 'none'` gives one whole-frame item; the same HTML twice gives the same hash; a changed `.v` changes
    only that variant's hash;
  - a 300 KB document is extracted in under 50 ms.
- **Accept**: no write, no store access: the function is pure over its arguments.
- **Docs**: none.

### 1.3 Indexer

- **Goal**: keep `library_items` in step with the frames, and keep one search index per library in memory.
- **Files**: `server/libraryIndex.ts`: `reindexLibrary(canvasId)` (frames in reading order per page, batches of
  50 through `store.renderableFrame`, section categories carried down each page, `parentIdOf` resolved once all
  families are known, `rev` kept when the hash is unchanged and incremented otherwise, `index_state` updated per
  batch), `reindexFrame(canvasId, frameId)` (debounced 1.5 s per frame, skipped while the frame streams),
  `removeFrameItems`, `indexFor(canvasId)` (lazy `buildIndex` from `loadLibraryItems` + meta, dropped after 10
  idle minutes, patched in place after a frame reindex), `resumeIndexing()` at boot for libraries whose state is
  `running`; `server/store.ts`: `onFrameWrite(listener)` called with `{ canvasId, frameId, kind: 'write' |
'delete' | 'move' }` from the places that call `persist.saveFrame`, `persist.saveFramePage` and the frame
  delete (verify the list in `store.ts`; there are six `saveFrame` calls today); `server/index.ts`: wire the
  listener and `resumeIndexing()`.
- **Tests first**: `tests/libraryIndex.test.ts`: a library of the three fixtures indexes to 1 + 2 + 1 + 1 items;
  the exploded card's parent is found when its family exists and stays null when it does not; editing one
  variant bumps one `rev`; deleting a frame removes its items; moving a frame under another `§` changes its
  category; a frame write on a canvas that is not a library does nothing; a reindex interrupted after one batch
  resumes; `store.load` is never called (spy). `tests/libraryIndexHttp.test.ts` (harness): 300 generated frames
  index and a restart keeps the items.
- **Accept**: memory stays flat while reindexing (no frame HTML retained: assert `store.stats().loaded`
  unchanged); the listener costs nothing measurable on a non-library canvas.
- **Docs**: none.

### 1.4 REST and the client API

- **Goal**: create, read, search.
- **Files**: `server/libraryRoutes.ts` (router mounted at `/api/libraries` behind the session gate):
  `GET /` (libraries the caller may read: own, shared, the reference list), `POST /preview` `{ canvasId, rules?
}` (dry run: counts and unreadable frames, no write), `POST /` `{ canvasId, preset? }`, `GET /:id`, `PATCH
/:id` `{ description?, rules?, taxonomy? }`, `DELETE /:id`, `POST /:id/reindex`, `GET /search`,
  `GET /:id/items` (browse: search with an empty query), `GET /:id/items/:itemId` (item + variants),
  `GET /:id/items/:itemId/html` (`{ html, width, height, locator }` through `renderableFrame`),
  `PATCH /:id/items/:itemId` (meta); a rate limit of 30 searches per 10 s per account; `server/index.ts` mounts
  it; `src/lib/api.ts` (`listLibraries`, `previewLibrary`, `createLibrary`, `getLibraryDetail`, `updateLibrary`,
  `deleteLibrary`, `reindexLibrary`, `searchLibraries`, `libraryItem`, `libraryItemHtml`, `setLibraryItemMeta`).
  The existing `GET`/`PUT /api/library` (the per-user list) is untouched.
- **Tests first**: extend `tests/librariesHttp.test.ts`: the owner previews then creates; the stranger gets 404
  on every route (never 403, like canvases); a view-link visitor searches but cannot patch; an editor patches
  meta but not rules; search without `lib` covers only readable libraries; the 31st search in 10 s is 429;
  an invalid `rules` body is 400 with the parser's paths; `/html` returns one frame's HTML and does not load the
  canvas.
- **Accept**: every handler calls `libraryRole` first; no handler calls `store.load`.
- **Docs**: none yet.

### 1.5 Agent read tools

- **Goal**: `list_libraries`, `get_library`, `search_library`, `get_library_item` for MCP and the resident agent.
- **Files**: `server/libraryTools.ts` (`DESIGN_LIBRARY_TOOLS`: `{ name, title, description, readOnly, shape, run
}` like `COMPONENT_TOOLS`, context `{ userId, actor, libraries(): Canvas[], canvas? }`; `runLibraryTool`);
  `server/mcp.ts` (register the four after the component tools; libraries are the account's readable ones);
  `server/resident.ts` (push them into `TOOLS` with `zodToJsonSchema`, handle them in `execTool`, libraries are
  `runState.libraryCanvases` plus the canvas itself when it is a library; add them to `CHAT_READ_TOOL_NAMES`);
  `server/guide.ts` (a `LIBRARIES` section, short: search before drawing a common pattern, what a family and a
  variant are).
- **Tests first**: `tests/libraryTools.test.ts`: each tool's result shape; `search_library` returns
  `thumbnail` (`/i/<frameId>.jpg?preview` for now) and `url` (`/l/<lib>/i/<itemId>`); `get_library_item` with
  `include_html` returns the frame's HTML for now (the scoped snapshot arrives in 2.5) and says so in a
  `fidelity: 'frame'` field; a library the account cannot read answers like a missing one.
  `tests/agentToolParity.test.ts` passes with no new exception.
- **Accept**: tool descriptions say what a family and a variant are in one sentence each; no tool text mentions
  internal table names.
- **Docs**: none yet.

### 1.6 FindBar: pure rows out of the component

- **Goal**: make `FindBar.tsx` (721 lines) able to take a second source of rows, with no behaviour change.
- **Files**: `src/lib/findRows.ts` (`FrameGroup`, `ResultRow`, `groupByFrame`, `relevance`, `resultRows`,
  `focusOf`, `defaultFocus`, `rowKey`, `rowDomId` moved out); `src/components/find/FindResultList.tsx` (the
  remote list markup, taking rows and callbacks); `src/components/FindBar.tsx` (imports them).
- **Tests first**: `tests/findRows.test.ts` pins today's grouping and order on a recorded `CanvasFindHit[]`
  (write the expectations from the current code before moving it). The existing `tests/findInsert.test.ts`,
  `tests/findInsertBlock.test.ts` and `tests/findPreviewRuntime.test.ts` stay green untouched.
- **Accept**: a pure move: `git diff --stat` shows `FindBar.tsx` shrinking and no i18n change.
- **Docs**: none.

### 1.7 ⌘F Library scope, and "Turn into a library"

- **Goal**: the slice's user value.
- **Files**: `src/lib/findLibrary.ts` (`libraryRows(result)` → `ResultRow`s whose group carries `item`,
  `libraryFocus(row)`); `src/lib/findRows.ts` (`ResultRow.item?: LibraryItemSummary`; delete `LIBRARY_ID`,
  `looksLikeId`, `variantIds`; text groups no longer infer variants); `src/lib/findInsert.ts` (delete
  `LIBRARY_ID` and `LIBRARY_CANVAS`; `isLibraryItem(row)` is "has an item of an insertable kind"; `rowAction`
  and `footerHint` take the row); `src/components/FindBar.tsx` (scope `'library'`, the scope control as
  `DropdownMenu` + `DropdownMenuRadioGroup`, default scope rule of the spec, a 120 ms debounce for the library
  scope, kind `ToggleChip`s, "Open in gallery" in the footer once 3.2 exists);
  `src/components/library/ConvertToLibraryModal.tsx` (`Modal`: preset `Segmented`, the dry-run counts, a
  `Disclosure` listing unreadable frames, one primary `Button`); `src/components/MainMenu.tsx` /
  `src/lib/actions/registry.ts` (action `library-convert`, File menu, editors who may manage);
  `src/lib/i18n/{en,pt-BR}/library.ts` + both `index.ts`; `src/lib/store.ts` (apply the `library` room message).
- **Tests first**: `tests/findLibrary.test.ts`: a `LibrarySearchResult` becomes family rows with variant rows;
  a non-insertable kind (`rs`) makes click go, not insert. `tests/findLibraryUi.test.tsx` (happy-dom, API
  mocked): on a library canvas the scope defaults to Library; typing `otp` renders one family row with "3
  variants"; ↓ walks into the variants; ↩ with a frame selected calls `insertLibraryItem` with the variant's
  focus; ⇧↩ navigates; a canvas named "Design Library" that is not a library gets no insert (the guess is gone).
  `tests/convertLibraryUi.test.tsx`: the modal shows the preview counts and creates on confirm.
- **Accept**: on a copy of a real sheet, `otp` in ⌘F shows the family first, its variants under it, and the
  insert still works through the existing preview path. No regex on ids remains in `src/`.
- **Docs**: README "This fork": new bullet **Design libraries** (what a library is, convert, ⌘F Library scope,
  the four tools). TECHSTACK section 4: a "Design libraries" bullet naming `shared/library*.ts`,
  `server/libraries.ts`, `server/libraryExtract.ts`, `server/libraryIndex.ts`, `server/libraryRoutes.ts`,
  `server/libraryTools.ts`, the tables, and the tests. FORK.md: one line under features.

## Phase 2 - Rendered truth: boxes, thumbnails, exact preview and insert

### 2.1 In-page collector and the rendered pass

- **Goal**: read variants from the DOM the frame's scripts built, with each variant's box.
- **Files**: `shared/libraryCollect.ts` (`collectLibraryItems(rules)`: one self-contained function, exported with
  its source string the way `shared/slopCollect.ts` exports `SLOP_COLLECTOR_SOURCE`; returns `{ items: { id,
label, notes, box, anchor, elementId?, text, html }[] }`; a 5 s internal deadline); `server/libraryIndex.ts`
  (`renderedPass(canvasId, frameId)`: `loadFramePage(frame, { priority: 'background' })`, wait 1.7 s for late
  scripts as `findSnapshot.ts` does, evaluate, merge into the frame's items; a queue of at most 2 concurrent
  pages; skipped when `rendererAvailable()` is false; `index_state.rendered` counts); static frames get boxes
  from the same pass.
- **Tests first**: `tests/libraryCollectBrowser.test.ts` (Chromium through `tests/browser.ts`):
  `sheet-scripted.html` yields three items `cp.tuff-chart-card`, `cp.tuff-dot-histogram`, `cp.tuff-json-viewer`
  with non-empty boxes that lie inside the `.d` cells; `sheet-static.html` yields boxes equal to the `.v`
  rectangles (490×300); an infinite-loop script does not hang past the deadline. `tests/libraryIndex.test.ts`
  gains: the rendered result replaces the scripted family's empty variant list; a renderer failure leaves the
  static items in place and records `failed`.
- **Accept**: with no browser installed the suite still passes (browser file skipped as the other
  `*Browser.test.ts` files are) and the static index is unchanged.
- **Docs**: TECHSTACK bullet: the two passes.

### 2.2 Preview by locator

- **Goal**: the preview frames the design itself, not the box around a caption.
- **Files**: `src/lib/findPreviewRuntime.ts` (the `focus` message accepts `{ selector?: string, text?: string }`;
  a selector is tried first, `find(text)` is the fallback); `src/components/FindPreview.tsx` and
  `src/lib/findSnapshot.ts` (`focus` becomes `ItemFocus = { key, selector?, text }`; `LivePreview` compares
  keys); `src/lib/findLibrary.ts` (`libraryFocus` builds it from the locator: `[data-doop-id="…"]`, else the
  anchor plus the rule's `design` selector resolved from the cell).
- **Tests first**: extend `tests/findPreviewRuntimeBrowser.test.ts`: on `sheet-static.html` a selector focus
  outlines the `.v` (490×300), while the text focus of the old path outlines the wrapper (taller): assert the two
  differ, which pins the bug the spec describes. On `sheet-scripted.html` the anchor focus resolves to the `.d`.
- **Accept**: hovering variants still never reloads the iframe.
- **Docs**: none.

### 2.3 Snapshot v2

- **Goal**: a copy that is complete, inert and traceable.
- **Files**: `shared/librarySnapshot.ts` (the snapshot function and `LibrarySnapshot` moved out of
  `findPreviewRuntime.ts`, self-contained, with a source export; new fields `defs: string[]` for the `<symbol>`,
  gradients, filters and clip paths the item's `<use href>` and `url(#…)` reference; sanitising: drop `on*`
  attributes, `javascript:` URLs, `<iframe>`, `<object>`, `<embed>`, `<base>`); `shared/libraryBlock.ts`
  (`libraryBlock(snap, { ref, libraryId, rev })` moved from `src/lib/findInsert.ts`, emitting an inline
  `<svg width="0" height="0" aria-hidden>` with the defs, and `data-doop-ref-lib` / `data-doop-ref-rev`);
  `src/lib/findInsert.ts` (uses them; `KEPT_DOOP_ATTRS` gains the two attributes; `InsertedItem` gains
  `libraryId`, `rev`); `src/lib/findPreviewRuntime.ts` (imports the shared function by source).
- **Tests first**: extend `tests/findSnapshotBrowser.test.ts`: the `sheet-static.html` variant with
  `<use href="#key">` snapshots with the `#key` symbol in `defs`; `onclick` is gone; `.unused` is not in
  `rules`. `tests/libraryBlock.test.ts` (moved cases of `tests/findInsertBlock.test.ts` plus): the three ref
  attributes are on the wrapper; ids inside the defs are prefixed so two inserts of the same item do not clash.
- **Accept**: an item inserted before this step still renders (old blocks have no `-lib` / `-rev`; nothing
  requires them).
- **Docs**: README bullet "Insert from ⌘F": mention provenance and dependencies.

### 2.4 Variant thumbnails

- **Goal**: an image per item, so lists never mount an iframe.
- **Files**: `server/libraryThumbs.ts` (`itemThumb(canvasId, itemId)`: render the frame through
  `renderFrame` with a `clip` of the item's box plus 12 px, JPEG, longest side 640, cached in storage under
  `lt/<canvasId>/<itemId>-<hash>.jpg`, background priority, `RendererBusyError` → 503 with `Retry-After`);
  `server/screenshot.ts` (`RenderOptions.clip`); `server/libraryRoutes.ts`
  (`GET /:id/items/:itemId/thumb.jpg`, immutable cache headers since the hash is in the URL via `?v=<hash>`);
  `src/components/library/ItemThumb.tsx` (the image; when the endpoint answers 503 or the item has no box, the
  frame preview `/i/<frameId>.jpg?preview` cropped with CSS from the box ratio; `FramePreview`'s empty and
  failed states reused).
- **Tests first**: `tests/libraryThumbs.test.ts` (renderer mocked): the clip is the box plus margin clamped to
  the frame; the cache key changes with the hash; a busy renderer is a 503. `tests/itemThumb.test.tsx`
  (happy-dom): falls back to the CSS crop on error, and computes the crop from a box.
- **Accept**: the thumbnail of `bk.scb-login-social-with-email-option` shows the dark card alone.
- **Docs**: TECHSTACK: the thumbnail route and its cache key.

### 2.5 Server-side snapshot and insert

- **Goal**: insert an item without a browser tab, for the gallery and for agents.
- **Files**: `server/librarySnapshot.ts` (`snapshotItem(canvasId, itemId)`: rendered through `loadFramePage` +
  the shared snapshot source, focus by locator; static fallback when no renderer: the element's `outerHTML` by
  parse5 with the frame's `<style>` blocks kept whole under the scope, `fidelity: 'static'`;
  `insertItem({ library, itemId, target, afterElementId, actor })`: `libraryBlock`, placed after the element or
  at the end of `<body>` with parse5 source offsets as `server/elementIds.ts` does, fresh `data-doop-id`s,
  written with `actions.updateFrame` as an ordinary design write, `use_count` incremented);
  `server/libraryRoutes.ts` (`POST /:id/items/:itemId/insert` `{ canvasId, frameId, afterElementId? }`, needs
  `libraryRole` read and `canEditCanvas` on the target; `POST /:id/items/:itemId/used` for client-side inserts).
- **Tests first**: `tests/librarySnapshot.test.ts` (renderer mocked to return a recorded snapshot): the block
  lands after the named element; without one, before `</body>`; a locked frame is refused; an approved frame
  moves to `needs_review`; a frame version is filed; the static fallback is used when `rendererAvailable()` is
  false and reports it. `tests/librariesHttp.test.ts`: a reader of the library without edit on the target gets 404.
- **Accept**: the server result and the browser result of the same insert differ only in generated ids.
- **Docs**: TECHSTACK: the two insert paths and when each runs.

## Phase 3 - The gallery

Steps 3.1 to 3.3 need only Phase 1 and can be built beside Phase 2.

### 3.1 Libraries page and the rail

- **Goal**: a place where libraries are listed and made.
- **Files**: `src/pages/Libraries.tsx`; `src/App.tsx` (routes `/libraries`, `/l/:id`, `/l/:id/i/:itemId`);
  `src/components/AppRail.tsx` (a "Libraries" `DashNavItem` with `LibraryIcon`, added to
  `src/components/ui/icons.tsx` from Lucide); `src/lib/i18n/{en,pt-BR}/library.ts` and `rail.ts`;
  `src/stories/Library.stories.tsx` (the library tile).
- **Tests first**: `tests/librariesPage.test.tsx` (happy-dom): tiles for each library with counts; the
  `EmptyState` when there is none, whose action opens `ConvertToLibraryModal` with a canvas picker.
- **Accept**: the rail row is on every page that mounts `AppRail`; the page follows the dashboard frame
  (`DashHeader variant="bare"`, `DashTitle`).
- **Docs**: DESIGN.md component index: `ItemThumb`, the library tile. README bullet extended.

### 3.2 Gallery

- **Goal**: browse 10,000 items by category, kind and search.
- **Files**: `src/pages/LibraryPage.tsx`; `src/components/library/LibraryFacets.tsx` (kind chips, category tree
  from `taxonomy.categories` with facet counts), `LibraryGrid.tsx` (windowed rows: `useWindowedGrid` in
  `src/hooks/use-windowed-grid.ts`, no new dependency), `LibraryItemTile.tsx`; `src/lib/libraryQuery.ts` (URL ⇄
  `{ q, kind, in, tag }`, cursor paging, stale-response guard); the ⌘F footer link of step 1.7 is turned on.
- **Tests first**: `tests/libraryQuery.test.ts`: URL round trip; a response older than the newest request is
  dropped. `tests/libraryPage.test.tsx` (happy-dom): a category click filters and updates the URL; scrolling to
  the end asks for the next cursor once; a draft shows its badge only to someone who may curate.
  `tests/libraryGalleryBrowser.test.ts` (Chromium, API answered by the test with `syntheticItems(10_000)`):
  fewer than 120 tiles are in the DOM at any scroll position, no `<iframe>` is mounted until a tile is hovered,
  and at most one after.
- **Accept**: the budgets "Gallery first page" and "Live iframes" of the spec.
- **Docs**: stories for `LibraryItemTile` and `LibraryFacets`.

### 3.3 Item view

- **Goal**: one item with every variant side by side.
- **Files**: `src/components/library/LibraryItemView.tsx` (page and `Sheet` forms), `VariantCard.tsx` (image
  first, live `FindPreview` when in view, capped at 12 live), `ItemDetails.tsx` (description, tags, category,
  status with in-place editing for curators through `PATCH …/items/:itemId`), `ItemFindings.tsx`.
- **Tests first**: `tests/libraryItemView.test.tsx` (happy-dom): variants render in index order; ⌘C on a focused
  card copies its id; a reader sees no edit control; saving tags calls the API and shows the effective item;
  "Open in canvas" navigates to `/c/<id>?frame=<frameId>`.
- **Accept**: 40 variants on screen mount 12 iframes at most.
- **Docs**: story for `VariantCard`.

### 3.4 Use in a frame from the gallery

- **Goal**: close the loop from browsing to the design.
- **Files**: `src/pages/LibraryPage.tsx` (reads `?from=&frame=`), `src/components/library/UseItemButton.tsx`
  ("Use in « name »" → `api.insertLibraryItem` → `navigate('/c/<from>?frame=<frame>&inserted=<elementId>')`;
  "Use in a canvas…" → `CanvasSearchModal`, then the same with the picked canvas and its last selected frame, or
  a frame picker); `src/pages/CanvasPage.tsx` (on `?inserted=`: pick the element, open `InsertedBlockBox`);
  `src/lib/actions/registry.ts` (action `library-open`, chord ⇧⌘L only if `tests/actionRegistry.test.ts`
  confirms it is free on every platform, else no chord).
- **Tests first**: `tests/useItemButton.test.tsx`: the label names the frame; a failed insert shows the notice
  and stays; `tests/canvasPageFixture`-based case: `?inserted=` picks the block.
- **Accept**: gallery → Use → back on the canvas with the block selected, in under 3 s on a static item.
- **Docs**: README bullet extended.

### 3.5 Library tab in the Layers panel

- **Goal**: pull from a library without leaving the canvas.
- **Files**: `src/components/library/LibraryPanel.tsx`; `src/components/LayersPanel.tsx` (a fourth tab,
  shown when the person has at least one library); the tile's drag reuses `useFindDrag` from
  `src/components/FindDrag.tsx` and `insertLibraryItem`.
- **Tests first**: `tests/libraryPanel.test.tsx` (happy-dom): the library `Select` remembers its pick
  (`doop:library-panel` in `localStorage`); click with a frame selected inserts; ⇧ click opens the item sheet.
  `tests/libraryPanelBrowser.test.ts` (Chromium, real `CanvasPage` fixture): dragging a tile over a frame shows
  the drop line and the drop inserts between the two elements.
- **Accept**: the panel mounts no iframe.
- **Docs**: TECHSTACK: the panel and its storage key.

## Phase 4 - Import rules

### 4.1 The pipeline, dry run

- **Goal**: every stage of the spec's import as a pure function, composed into a report.
- **Files**: `server/libraryImport.ts` (`planImport({ library, frames, existing, tokens })` → `ImportReport`;
  stages `stageIgnore`, `stageId`, `stageNaming`, `stageVariants`, `stageDependencies`, `stageDedup`,
  `stageCategorise`, `stagePlacement`; `ImportReport` = per frame `{ frameId, item?, variants, findings,
changes: { name?, html?, pageId?, x?, y? } }` plus totals); `shared/library.ts` (`ImportReport`, `RuleFinding`
  kinds: `no-id`, `id-collision`, `duplicate`, `lint`, `missing-dependency`, `unreadable`, `token-match`).
- **Tests first**: `tests/libraryImport.test.ts`: a plain frame "Login screen" gets `cp.login-screen` under
  `kind.slug` with a default kind, or a `no-id` finding when the rules give no default kind; a second one gets
  `-2` under `suffix` and a finding under `reject`; the exploded card with a dangling `<use href="#key">` gets
  `missing-dependency`, and none when the source sheet is among the frames (the symbol is copied in); two frames
  with the same hash give `duplicate`; categorise order `marker` > `section` > `page` > `kind`; placement appends
  below the last frame of the category's page.
- **Accept**: `planImport` writes nothing (the store is not imported by the module).
- **Docs**: none.

### 4.2 Lint gate and token mapping

- **Goal**: the two stages that need other subsystems.
- **Files**: `server/libraryImport.ts` (`stageLint(report, lintFrame)` with `lintFrame` injected from
  `server/lint.ts`; `stageTokens(report, tokens, mode)`), `shared/libraryTokens.ts` (`tokenMatches(css, tokens)`
  → `{ value, token, count }[]` for colours normalised through `cssColorToRgba` of `shared/slopRules.ts`, radii
  and font families; `applyTokenMatches(html, matches)` rewriting declarations to `var(--name)` inside `<style>`
  and `style=""` only).
- **Tests first**: `tests/libraryTokens.test.ts`: `#09090b` and `rgb(9, 9, 11)` both match a token `--color-ink:
#09090b`; a value inside a `url()` or a gradient stop list is left alone under `apply` unless it is a whole
  stop; `suggest` changes nothing. `tests/libraryImport.test.ts` gains: gate `warn` records the score; `draft`
  sets status `draft`; `off` never calls the linter; ignored rules are filtered.
- **Accept**: token mapping never touches markup outside CSS.
- **Docs**: none.

### 4.3 Apply an import

- **Goal**: frames really enter a library.
- **Files**: `server/libraryImport.ts` (`applyImport(report, actor)`: frames copied from another canvas with
  `actions.createFrame`, or changed in place when already in the library; renames and moves through
  `updateFrameMeta` of `server/pageTools.ts`; HTML changes through `actions.updateFrame` with the `annotation`
  option when only markers and ids were added, an ordinary write otherwise; pages created with
  `actions.createCanvasPage`); `server/libraryRoutes.ts` (`POST /:id/import` `{ sourceCanvasId?, frameIds,
category?, tags?, dryRun? }`, 20 frames per call, 6 calls a minute); `src/lib/api.ts`;
  `src/components/FrameContextMenu.tsx` ("Add to library…" → `AddToLibraryModal.tsx`: library `Select`, the dry
  run's findings, `Button` Add); a frame created on a library canvas by any other import (website, SVG, PDF,
  paste) is indexed as usual and gets its findings from the same stages at index time, with no change to it.
- **Tests first**: `tests/libraryImportApply.test.ts`: a frame from a project canvas is copied, never moved; the
  copy has the new name, page and markers; the source is untouched; an annotation-only change keeps
  `ready_for_dev`; a failed frame leaves the earlier ones in place and reports. HTTP: the 21st frame is a 400.
- **Accept**: importing `card-exploded.html` next to `sheet-static.html` yields a working icon.
- **Docs**: README bullet: adding to a library and what the rules do.

### 4.4 Rules editor

- **Goal**: rules are per library and editable, with their effect visible before saving.
- **Files**: `src/components/library/LibraryRulesForm.tsx` (one `SettingsCard` per group: Ids and naming,
  Detection, Categories, CSS, Tokens, Quality gate, Duplicates, Search synonyms; `CardRow` + `Select`,
  `Segmented`, `Input variant="well"`, `Switch`), `LibrarySettings.tsx` (description, kinds and sources tables,
  the form, "Reindex", "Stop being a library" in an `AlertDialog`); a debounced `POST /api/libraries/preview`
  with the edited rules feeding a "what changes" panel (items gained, lost, moved category, new drafts).
- **Tests first**: `tests/libraryRulesForm.test.tsx` (happy-dom): editing a selector asks for a preview once per
  400 ms; a parser error shows under its field by path; Save is disabled while invalid; saving bumps
  `rules_version` and triggers a reindex. `tests/librariesHttp.test.ts`: an editor who is not a manager gets
  404 on `PATCH` with rules.
- **Accept**: switching `variants.mode` from `auto` to `none` shows the variant count going to 0 before saving.
- **Docs**: TECHSTACK: where rules live and who may change them.

### 4.5 Inbox

- **Goal**: review what the rules flagged in one place.
- **Files**: `src/components/library/LibraryInbox.tsx` (a `List` of drafts and flagged items, each with its
  findings; `SelectionBar` with Accept, Hide, Re-run rules; a duplicate shows both thumbnails with "Keep this
  one"); `server/libraryRoutes.ts` (`POST /:id/items/batch` `{ itemIds, status }`); a count badge on the gallery
  header's menu.
- **Tests first**: `tests/libraryInbox.test.tsx`: accepting sets meta status `active` and the item leaves the
  list; "Keep this one" hides the other; the badge counts drafts only for curators.
- **Accept**: an accepted draft appears in ⌘F at the next search.
- **Docs**: none.

## Phase 5 - Agents

### 5.1 `insert_library_item`

- **Goal**: agents place items instead of redrawing them.
- **Files**: `server/libraryTools.ts` (the tool over `insertItem` of step 2.5; result: `element_id`,
  `fidelity`, and the notes `componentWriteNotes` style: "adapt it to this frame's tokens with edit_frame_html;
  keep data-doop-ref*"); `get_library_item` with `include_html` now returns the scoped block
  (`fidelity: 'rendered' | 'static'`); `server/mcp.ts`, `server/resident.ts` (registered; counts as a design
  write for the run's delivery check and for the lint-before-finishing pass).
- **Tests first**: `tests/libraryTools.test.ts`: the tool refuses a target the account cannot edit, a
  non-insertable kind, and a frame mid-stream; the resident version cannot target another canvas.
  `tests/agentToolParity.test.ts` green.
- **Accept**: a resident run that inserts one item and adapts it counts as delivered.
- **Docs**: README bullet: the agent tools so far.

### 5.2 `import_to_library` and `set_library_item`

- **Goal**: agents can build and curate, behind a switch.
- **Files**: `server/env.ts` (`AGENT_LIBRARY_WRITES: bool({ default: true })` with the comment style of
  `AGENT_GUIDELINE_WRITES`); `.env.example`; `server/libraryTools.ts` (both tools, refusing with the spec's
  sentence when the flag is off; `import_to_library` always returns the report and honours `dry_run`);
  `server/resident.ts` (available only when the run's canvas is the library); `server/guide.ts` (authoring
  library content: the markers, one family per sheet, ids).
- **Tests first**: `tests/libraryTools.test.ts`: flag off refuses both and writes nothing; `dry_run` writes
  nothing; `set_library_item` cannot set `status: 'hidden'` on a library the account only reads.
  `tests/residentLibrary.test.ts`: on a project canvas the two tools answer "this run's canvas is not that
  library".
- **Accept**: no tool can change rules, visibility or delete a library (assert the tool list).
- **Docs**: TECHSTACK: the flag. `deploy/k3s` is not changed (the default is right for the instance).

### 5.3 References and the resident prompt on the index

- **Goal**: the plan-first flow uses items.
- **Files**: `server/resident.ts` (`find_references` answered by `searchIndex` for canvases that are libraries,
  falling back to `findInCanvas` for those that are not, same result keys plus `item_id`, `variant_count`; a `#
Libraries` system block from `libraryBrief(libraries)`: name, counts, kinds, top ten categories; plan
  validation accepts and checks `itemId`); `shared/types.ts` (`ChatPlanReference.itemId?`);
  `server/referenceLibrary.ts` (`LIBRARY_MAX_CANVASES = 20`; `libraryFor` adds the workspace libraries of the
  canvas being worked on); `src/components/ReferenceLibraryCard.tsx` (the cap, a "library" `Badge` on real
  libraries); plan card thumbnails use the item thumbnail when `itemId` is set.
- **Tests first**: extend `tests/libraryReferences.test.ts`: results carry `item_id` on a real library; a plan
  naming an unknown `itemId` is refused with the reason; the 21st canvas is refused; a non-library canvas in the
  list still answers through the text search.
- **Accept**: the existing reference-library tests pass unchanged apart from the cap.
- **Docs**: README "Reference library" bullet updated.

## Phase 6 - Sharing and updates

### 6.1 Visibility and the person's list

- **Goal**: personal, workspace.
- **Files**: `server/libraries.ts` (`libraryRole` honours `workspace`; setting it needs the canvas to be in a
  workspace and `canManageCanvas`); `server/libraryRoutes.ts` (`PATCH /:id` `{ visibility }`; `GET /` gains
  `scope=mine|workspace|listed`); `src/components/ShareModal.tsx` (a "Library" section on library canvases: who
  can use it, `Segmented`); `src/pages/Workspace.tsx` (the workspace's libraries as tiles in "All canvases").
- **Tests first**: `tests/libraryAccess.test.ts`: the full matrix of the spec's table for owner, invited
  member, workspace member, workspace admin, link visitor (view, comment, edit), stranger, for read, curate and
  manage; a library read never makes `canAccessCanvas` true (assert on a public and a workspace library).
- **Accept**: `server/access.ts` is not modified.
- **Docs**: TECHSTACK section 6: the library gate beside canvas access.

### 6.2 Public libraries

- **Goal**: everyone on the instance can use a library someone published.
- **Files**: `server/env.ts` (`DOOP_PUBLIC_LIBRARIES: bool({ default: false })`), `.env.example`;
  `server/libraries.ts` (`public` accepted only with the flag); `server/community.ts` + `src/pages/Community.tsx`
  (a "Libraries" shelf; "Use" adds it to the person's list, "Copy" duplicates the canvas);
  `ShareModal` (the third option with the third-party content warning in a `Callout`).
- **Tests first**: `tests/libraryAccess.test.ts`: flag off refuses `public`; flag on lets a stranger search and
  insert but not open `/api/canvases/:id`, join the room or call `get_frame` on it over MCP.
- **Accept**: turning the flag off again hides public libraries from strangers at once (no cached grant).
- **Docs**: README: the flag and the warning.

### 6.3 Update available

- **Goal**: an inserted block knows when its item moved on.
- **Files**: `src/lib/libraryRefs.ts` (`refsIn(html)` → `{ elementId, ref, libraryId, rev }[]`;
  `staleRefs(refs, revs)`); `server/libraryRoutes.ts` (`POST /revs` `{ refs: { libraryId, itemId }[] }` → current
  revs, readable libraries only); `src/components/Inspector.tsx` / `ElementPanel.tsx` (a "From library" row on an
  element carrying `data-doop-ref-lib`: item id, link to the item, "Update" when stale);
  `src/lib/findInsert.ts` (`replaceLibraryBlock(item)`: fresh snapshot in place of the block, one undo step,
  behind an `AlertDialog` naming what is lost).
- **Tests first**: `tests/libraryRefs.test.ts`: refs are read from nested blocks; a block without `-rev` is
  never stale. `tests/libraryUpdateUi.test.tsx`: the row shows "Update" only when stale; confirming replaces the
  block and keeps its position; undo restores it.
- **Accept**: the frame is requested for revs once when selected, not per render.
- **Docs**: README bullet extended.

### 6.4 Component items

- **Goal**: an item that is a component inserts as a linked instance, and a snapshot item can become one.
- **Files**: `server/librarySnapshot.ts` (`insertItem` for `mode: 'component'`: `importComponent` of
  `server/componentActions.ts` then an instance through the path `insert_instance` uses);
  `src/components/library/LibraryItemView.tsx` ("Promote to component": the existing create-component call with
  the item's frame and element; variants of a component item are its enum combinations, rendered with
  `get_component_preview`'s sheet); `src/lib/findInsert.ts` (the client insert of a component item calls the
  server route instead of snapshotting).
- **Tests first**: `tests/libraryComponentItems.test.ts`: inserting a component item creates a linked
  `data-doop-instance` and the import is recorded with its `source`; a second insert reuses the imported
  component; a promoted item reindexes as `mode: 'component'` with the same id.
- **Accept**: `sync_component` works on a component that arrived through a library insert.
- **Docs**: `.context/specs/components.md` "Limits": libraries now reach instances through items.

## Phase 7 - Migration and scale

### 7.1 Convert wizard, complete

- **Goal**: converting Bryan's canvases is one guided action with an honest report.
- **Files**: `src/components/library/ConvertToLibraryModal.tsx` (three steps in one `Modal`: preset with the
  detected one preselected and why; the report with `Tabs` Items, Ignored, Unreadable, Duplicates; the proposed
  taxonomy from sections and pages, editable as a list before applying); `server/libraryRoutes.ts` (`/preview`
  returns the proposed taxonomy; `POST /` accepts it); restoring rules and meta when a disabled library is
  converted again within 30 days; a boot job that deletes rows disabled for longer.
- **Tests first**: `tests/libraryConvert.test.ts`: `names.json` + fixtures produce the expected taxonomy
  (`Inputs/Text fields & core inputs` from the `§` frame; `Inputs & forms` from page `013 Inputs & forms · …`);
  reconverting restores curated tags; the purge leaves a 29-day-old row. UI test for the three steps.
- **Accept**: converting changes no frame (`updatedAt` of every frame equal before and after).
- **Docs**: FORK.md: the conversion recipe for the two existing canvases.

### 7.2 Transfer categories between libraries

- **Goal**: decision D2 as a tool.
- **Files**: `server/libraryImport.ts` (`planTransfer(from, to)` → matched ids with `{ fromCategory, toCategory
}`, ids only in one side; `applyTransfer` writes `library_item_meta.category` and adds missing categories to
  the taxonomy); `server/libraryRoutes.ts` (`POST /:id/transfer` `{ fromLibraryId, dryRun? }`, manage on the
  target, read on the source); `LibrarySettings.tsx` ("Take categories from another library…").
- **Tests first**: `tests/libraryTransfer.test.ts`: 3 shared ids move, 1 is reported missing on each side,
  nothing but meta changes, a second run is a no-op.
- **Accept**: the source library is never written.
- **Docs**: FORK.md recipe extended.

### 7.3 A thousand pages

- **Goal**: lift the cap that made pages merge.
- **Files**: `server/store.ts` (`MAX_LIBRARY_PAGES = 1000`, `maxPages(canvas)`; the two `MAX_PAGES` checks in
  `server/actions.ts` and `server/pageTools.ts` use it); `shared/pages.ts` if the client checks it;
  `src/components/PagesPanel.tsx` (a filter `SearchField` and `useWindowedGrid` in list mode above 100 pages).
- **Tests first**: `tests/pages.test.ts` gains: page 101 is accepted on a library and refused elsewhere; page
  1001 is refused with the message naming 1,000. `tests/pagesPanel.test.tsx`: 600 pages render under 80 rows and
  the filter narrows them.
- **Accept**: `get_canvas` on a 600-page library still lists every page.
- **Docs**: TECHSTACK "Pages over MCP" bullet: the two caps.

### 7.4 "Everywhere" without loading libraries

- **Goal**: ⌘F everywhere stops pulling library HTML into memory.
- **Files**: `server/index.ts` (`/api/find`: canvases that are libraries are answered from `indexFor`, mapped
  to `CanvasFindHit`s with `where: 'name'` and an `item` field; others as today); `server/mcp.ts`
  (`find_in_canvas` without `canvas_id` does the same and says so in its description);
  `shared/canvasFind.ts` (`CanvasFindHit.item?`).
- **Tests first**: `tests/canvasFindEverywhere.test.ts` (harness): with one library and one project canvas, a
  search returns hits from both and `store.stats().loaded` did not grow by the library.
- **Accept**: the budget "Search, server side".
- **Docs**: TECHSTACK ⌘F paragraph.

### 7.5 Pull a library from another Doop (optional, needs D4)

- **Goal**: bring the canvases from doop.design to the fork instance.
- **Files**: `scripts/pull-library.ts` (run with `tsx`; arguments `--from <origin> --canvas <id> --to <origin>`,
  keys from the `DOOP_FROM_KEY` / `DOOP_TO_KEY` environment variables only, never written; reads
  `GET /api/canvases/:id?pageId=` page by page; recreates pages then frames with the same names, sizes,
  positions and HTML; rewrites `/a/` asset URLs by re-uploading each through `upload_asset`'s HTTP path; resumable
  from a local progress file in the OS temp dir; `--dry-run`); `scripts/README` section.
- **Tests first**: `tests/pullLibrary.test.ts` (two harness servers): 3 pages and 12 frames arrive identical; a
  rerun creates nothing; an asset URL is rewritten.
- **Accept**: the source instance receives only GET requests (asserted by the test's request log).
- **Docs**: FORK.md: the command. Skip the step, and say so in the phase's last commit, if Bryan declines D4.

## Phase 8 - Quality

### 8.1 Usage ranking and synonyms

- **Goal**: what is used most comes first; "login" finds "sign in".
- **Files**: `server/libraryIndex.ts` (the index reads `use_count`; `used` increments patch the live index);
  `shared/librarySearch.ts` (default synonym groups for common UI words in `DEFAULT_SYNONYMS`, merged with the
  library's); the gallery gets a "Most used" sort beside "Relevance" and "Newest".
- **Tests first**: `tests/librarySearch.test.ts`: equal text scores order by use; a default synonym applies and a
  library can remove it with an empty list.
- **Accept**: use counts never outrank an exact id match.
- **Docs**: none.

### 8.2 AI tags and descriptions (optional, needs D9)

- **Goal**: items with thin text become findable.
- **Files**: `server/libraryDescribe.ts` (reuses the queue, payer resolution and limits of
  `server/imageDescriptions.ts`: one vision call per item thumbnail returning `{ description, tags[] }`, written
  to `library_item_meta` only where the person left them empty, marked `suggested` in `findings` until accepted);
  `LibrarySettings.tsx` (a `Switch`, off; the cost line); the inbox shows suggestions with Accept.
- **Tests first**: `tests/libraryDescribe.test.ts` (model mocked): off by default; never overwrites a person's
  tags; 200 a day per library; a failure leaves the item as it was.
- **Accept**: with the switch off, no model call is made anywhere in the feature.
- **Docs**: TECHSTACK: the switch and who pays.

### 8.3 Budgets, docs, close

- **Goal**: prove the budgets and leave the docs right.
- **Files**: `tests/libraryScale.test.ts` (`syntheticItems(10_000)` through `indexFor` and the search route:
  build time, p95, response size under 60 KB, memory delta under 40 MB with `process.memoryUsage()` and a wide
  margin); `.context/TECHSTACK.md` (the final "Design libraries" bullet), `README.md` ("This fork" bullet in its
  final form), `FORK.md`, `.context/specs/design-libraries.md` (status "built", deviations listed),
  `.context/plans/INDEX.md` and `.context/specs/INDEX.md` entries updated.
- **Tests first**: the scale test is the test.
- **Accept**: `bun run typecheck`, the lint line, `bun run doc-lint`, `bun run format:check` and the whole suite
  pass.
- **Docs**: as listed.

## Dependencies

| Step     | Needs                           |
| -------- | ------------------------------- |
| 0.2, 0.3 | 0.1                             |
| 1.1      | 0.1, 0.2                        |
| 1.2      | 0.1, 0.2                        |
| 1.3      | 1.1, 1.2, 0.3                   |
| 1.4      | 1.3                             |
| 1.5      | 1.4                             |
| 1.6      | 0.1                             |
| 1.7      | 1.4, 1.6                        |
| 2.1      | 1.3                             |
| 2.2      | 1.7                             |
| 2.3      | 2.2                             |
| 2.4      | 2.1                             |
| 2.5      | 2.3                             |
| 3.1-3.3  | 1.4 (3.3's live cards need 2.2) |
| 3.4      | 2.5, 3.3                        |
| 3.5      | 2.4, 3.2                        |
| 4.1      | 1.3                             |
| 4.2      | 4.1                             |
| 4.3      | 4.2                             |
| 4.4      | 1.4, 4.1                        |
| 4.5      | 4.3, 3.2                        |
| 5.1      | 2.5, 1.5                        |
| 5.2      | 4.3, 1.5                        |
| 5.3      | 1.5, 2.4                        |
| 6.1      | 1.4                             |
| 6.2      | 6.1                             |
| 6.3      | 2.3                             |
| 6.4      | 2.5, 3.3                        |
| 7.1      | 4.1, 1.7                        |
| 7.2      | 7.1                             |
| 7.3      | 1.1                             |
| 7.4      | 1.3                             |
| 7.5      | none (uses only existing REST)  |
| 8.1      | 2.5, 3.2                        |
| 8.2      | 2.4, 4.5                        |
| 8.3      | everything                      |

## What can run in parallel

The executor works alone on one branch, so the default is the linear order below. If Bryan gives several agents
a worktree each, these groups do not touch the same files:

- 0.2 and 0.3.
- 1.2 and 1.6 (server extractor, client refactor).
- Phase 2 (server render path, preview runtime) and 3.1-3.3 (new pages).
- 4.1-4.2 (pure server) and 6.1 (access).
- 7.3, 7.4 and 7.5 with each other and with Phase 8.

`server/libraryRoutes.ts`, `server/libraryTools.ts`, `src/lib/api.ts` and the two `library.ts` i18n files are
touched by many steps: parallel work on them must be merged in step order.

## Order that delivers value earliest

1. Phase 0, then Phase 1: **the slice**. Bryan converts "Design Library" and searches it from ⌘F and MCP.
2. Phase 2: the search becomes exact (scripted sheets, right box, complete copies, thumbnails).
3. 7.1 and 7.2 early if Bryan wants to retire the exploded canvas at once, then 7.3.
4. Phase 3: the gallery.
5. Phase 5.1 and 5.3: agents insert and plan from items.
6. Phase 4, then 5.2: building and curating with rules.
7. Phase 6, then 7.4, 7.5, Phase 8.

Linear order for a single executor: 0.1, 0.2, 0.3, 1.1-1.7, 2.1-2.5, 7.1, 7.2, 7.3, 3.1-3.5, 5.1, 5.3, 4.1-4.5,
5.2, 6.1-6.4, 7.4, 7.5, 8.1-8.3. Step numbers stay as written; only the order moves.

## Risk register

| Risk                                                                           | Likelihood | Impact | Mitigation                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` variant detection misreads a sheet dialect not seen in the fixtures     | High       | Medium | Selectors per library, the convert report's "Unreadable" list, explicit markers always win. Add each new dialect as a fixture.                |
| The rendered pass floods the renderer on a 5,000-frame conversion              | Medium     | High   | Background priority, 2 pages at most, static index usable at once, `index_state` shows progress, the pass resumes at boot.                    |
| The frame-write hook misses a write path, so the index goes stale              | Medium     | Medium | One `store.onFrameWrite` at the persist seam, a test per path, and "Reindex" in settings as the manual repair.                                |
| FindBar regressions while its guesses are replaced                             | Medium     | High   | 1.6 is a pure move pinned by tests before 1.7 changes behaviour; text scopes are untouched.                                                   |
| Upstream merge conflicts in `resident.ts`, `mcp.ts`, `index.ts`, `FindBar.tsx` | High       | Medium | Tools and routes live in new files; the shared files get registration lines only. `canvases` and `access.ts` are not changed.                 |
| Migration number collision with another `feat/*` branch                        | High       | Low    | Next free number at execution time; renumber on merge, never in history.                                                                      |
| Item ids change when a label is edited, breaking provenance                    | Medium     | Medium | Ids come from the frame name or markers, never from live text, once assigned. Import writes the marker so a rename of the label keeps the id. |
| Server and browser snapshots drift apart                                       | Medium     | Medium | One snapshot source in `shared/librarySnapshot.ts`, one `libraryBlock`; a test compares both results on the fixtures.                         |
| Memory: a search index per library kept alive                                  | Low        | Medium | Typed-array postings, 10-minute idle eviction, the 40 MB budget test.                                                                         |
| Vendor content shared publicly                                                 | Medium     | High   | Public is off by default behind an env flag, with a warning; licence shown per item.                                                          |
| A prompt-injected agent floods or poisons a library                            | Low        | High   | `AGENT_LIBRARY_WRITES`, rate limits, drafts under the lint gate, no agent access to rules or visibility.                                      |
| The plan is too large to finish                                                | Medium     | Medium | Every phase ends shippable. Phases 6.2, 7.5, 8.2 are optional and say so.                                                                     |
| The live libraries are on another instance                                     | High       | High   | 7.5, pending D4. Until then the feature is proven on fixtures and on copies made by hand.                                                     |

## Not verified while planning

- The live `get_canvas` (doop.design) returned no `pages` array, so page names were inferred from the 98
  `NNN … — title` frames. The category-from-page rule must be checked on the real pages in step 7.1.
- `publish_library` and `update_library_everywhere` exist on doop.design's MCP but not in this repository. The
  plan relies only on `import_component` and `sync_component`, which are here.
- The caption-in-the-copy bug and the dangling `<use>` were read from the code and one frame, not reproduced.
  Steps 2.2 and 2.3 start with a test that reproduces each.
- The exact call sites for `store.onFrameWrite` (step 1.3) and the renderer's priority option (step 2.1) must be
  confirmed in `server/store.ts` and `server/renderBrowser.ts` before coding.
- No test was run and no feature code was written for this plan.

## Deviations

Built on `feat/design-libraries`, every step done, one commit each (2026-11-14). Where the plan was wrong
or impossible, the smallest sound change was made; each is also in its commit body.

- 0.1: `names.json` fixtures were partly reconstructed: the live name list of doop.design was not pulled.
- 0.1: `splitFrameName` is stricter than planned (an id must match the grammar before the dash).
- 0.2: `ids.defaultKind` added to the rules, for frames whose id carries no kind.
- 0.3: prefix matching applies to the last word and to words of 3 characters or more.
- 1.1: libraries hydrate in their own pass after `store.init`; `source_url` and `license` columns added to
  `library_items` for the vendor warning.
- 1.2: a small parse5 selector engine (`server/libraryDom.ts`) instead of a selector dependency.
- 1.3: index rows are patched on curation; postings are rebuilt lazily on the next search.
- 1.7 / 3.x: `docs/FEATURES.md` carries the README's "This fork" detail; FORK.md is written in French.
- 2.1: the infinite-loop browser test became a deadline on a huge document; rendered-only rows carry an
  `r:` hash so they are told apart from static ones.
- 2.2: the anchor design is resolved in the runtime from the id texts; `findPreviewRuntime` moved to `shared/`.
- 3.2: `use-windowed-grid` was written in 7.3 (the gallery came first without it, then used it).
- 3.3: the "Used in" tab shows the use count only (no per-canvas list is stored).
- 3.4: `?inserted=` is tested through the store helper, not the `CanvasPage` fixture.
- 3.5: the Layers panel drag browser test was not written (click to insert is tested).
- 4.1: `planImport` is a pure module of its own (`server/libraryImportPlan.ts`).
- 4.2: lint cases live in `libraryTokens.test.ts`; draft status is a `data-doop-status` marker, findings
  are not stored.
- 4.4: the "Add to library" UI of 7.2 arrived with 4.4.
- 5.2: the resident write case lives in `libraryWriteTools.test.ts`; 5.3's index cases in
  `libraryReferencesIndex.test.ts`.
- 6.1: `DOOP_PUBLIC_LIBRARIES`, the public role, `/public` and `/copy` landed in 6.1, 6.2 added the shelf.
  ⌘F's in-browser preview of a public library item still reads `/api/frames`, which a stranger cannot.
- 6.3: "From library" sits in the element panel, not the Inspector. Kinds and sources tables are read-only.
- 6.4: a component item is inserted by the server (import, then instance) even from ⌘F.
- 7.5: REST does not take agent keys, so the script reads the source through MCP's read-only `get_canvas`
  and `get_frame` (plus GETs of public assets) and writes the target through MCP; the test asserts the source
  saw only those. Past 100 pages it stops until the target is turned into a library. It was not run against
  any real instance.
- 8.1: synonyms count for 0.6 of a direct match (a several-word one as one word), so defaults widen a search
  without reordering exact hits.
- 8.2: the suggestion has its own column (`library_item_meta.suggested`, migration 0067) instead of a mark in
  `findings`, which live on the rebuildable projection; the daily cap is in memory, like image descriptions'.
- 8.3: the scale test measures through `indexFor` and `searchLibraries` (the search route's body), not
  over HTTP, so the per-account rate limit does not shape it. Measured: build 72 ms, heap +25 MB, p95 3.5 ms,
  largest response 39 KB.
