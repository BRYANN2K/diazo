/**
 * The `diazo` SDK: the typed surface a `query_script` / `run_script` program
 * sees inside the sandbox. This file IS the contract — the same typings are
 * served to agents by `get_sdk_docs` and checked by the parity tests.
 *
 * Conventions:
 * - one global, `diazo`; every function returns a Promise;
 * - ids are the ids MCP tools use (`frame_id`, `page_id`, `item_id`); the
 *   canvas is implicit — the one the tool call names, and no other;
 * - `query_script` exposes only the functions marked "read"; `run_script`
 *   adds every function marked "write";
 * - nothing here deletes a frame, page or component, changes sharing or
 *   approval, imports or views a web page, generates an image, or reaches a
 *   linked repo — those stay on their own tools and confirmations;
 * - a failure rejects with `DiazoError` (`name: "DiazoError"`, a `code`, a
 *   message that names the function and the fix); a limit ends the whole
 *   run with `code: "limit"` and `limit` naming which one.
 */

/* ------------------------------------------------------------------ */
/* small shared shapes                                                 */
/* ------------------------------------------------------------------ */

declare namespace diazo {
  /** Who the run acts as, stamped on every write it makes. */
  interface RunInfo {
    /** the `script_runs` id this run writes under */
    runId: string
    canvasId: string
    /** true when the call asked for `dry_run` */
    dryRun: boolean
  }

  interface Box {
    x: number
    y: number
    width: number
    height: number
  }

  type Severity = 'error' | 'warning'

  interface Finding {
    /** rule id, e.g. `AS-14`, `CK-3`, `MO-2` */
    rule: string
    severity: Severity
    message: string
    /** data-doop-id of the element concerned, when one exists */
    elementId?: string
    selector?: string
  }

  /* ---------------------------------------------------------------- */
  /* diazo.canvas                                                      */
  /* ---------------------------------------------------------------- */

  interface CanvasSummary {
    name: string
    pages: { id: string; name: string; startFrameId?: string }[]
    frames: { id: string; pageId?: string; name: string; box: Box; hidden?: boolean; locked?: boolean }[]
    /** token name → its value (theme overrides under `themes`) */
    tokens: TokenSummary[]
    tokenThemes: string[]
    components: ComponentSummary[]
    /** families available to frames (canvas fonts + built-in webfonts) */
    fonts: string[]
    /** library items matching the brief's terms, when `brief` was given */
    libraryMatches: LibraryItemSummary[]
    /** style-guide names on the canvas — read them before designing */
    guides: { name: string; title?: string }[]
  }

  interface Canvas {
    /** The canvas at a glance: pages, frames (id, name, box — not HTML),
     *  tokens, components, fonts, guides, and the library items that match
     *  `brief`. Pass the job's brief so reuse is decided on real matches.
     *  (read) */
    summary(opts?: { brief?: string }): Promise<CanvasSummary>
    /** Show a line in the agent's status, like the `set_status` tool. (write) */
    status(text: string): Promise<{ ok: true }>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.frames                                                      */
  /* ---------------------------------------------------------------- */

  interface FrameRef {
    id: string
    pageId?: string
    name: string
    box: Box
    hidden?: boolean
    locked?: boolean
    approval?: 'draft' | 'ready_for_dev' | 'needs_review'
    /** chars the full document is; read it with `html()` or `find()` */
    htmlChars: number
  }

  /** One node of `frames.outline`: the element tree an agent edits against,
   *  about a tenth of the HTML's weight. */
  interface OutlineNode {
    /** data-doop-id when the element carries one — the handle `edit` wants */
    id?: string
    tag: string
    /** role, or tag when none */
    name?: string
    /** first ~80 chars of the element's own visible text */
    text?: string
    box?: Box
    children?: OutlineNode[]
  }

  /** Literal design values used in the frame's HTML, for token work. */
  interface StyleInventory {
    colors: { value: string; count: number; token?: string }[]
    radii: { value: string; count: number; token?: string }[]
    spacing: { value: string; count: number; token?: string }[]
    fontFamilies: { value: string; count: number; token?: string }[]
    fontSizes: { value: string; count: number; token?: string }[]
    /** of the literals above, the share already written as var(--name) */
    tokenCoverage: number
  }

  interface FrameFindHit {
    /** data-doop-id of the smallest element holding the match */
    elementId?: string
    /** ~120 chars of context around the first match */
    snippet: string
    /** character offset in the frame's HTML */
    offset: number
  }

  type EditOp =
    /** exact find-and-replace in the frame HTML; `find` must occur once */
    | { op: 'replace'; find: string; replace: string }
    /** set or remove a style property on the element carrying `element` (a data-doop-id) */
    | { op: 'style'; element: string; property: string; value: string | null }
    /** set or remove an attribute on the element */
    | { op: 'attr'; element: string; name: string; value: string | null }
    /** replace the element's inner text (script and style elements refuse) */
    | { op: 'text'; element: string; text: string }
    /** insert markup as last child of the element, or at `before` (a sibling's data-doop-id) */
    | { op: 'insert'; element: string; html: string; before?: string }
    /** remove the element and its subtree */
    | { op: 'remove'; element: string }

  interface EditResult {
    ok: true
    /** ops that applied, in order */
    applied: number
    /** ops that did not, each with the reason (the rest still applied) */
    failed: { index: number; reason: string }[]
    /** frame HTML size after the batch */
    htmlChars: number
    /** the frame's `checks.review`, always present after a write that changed HTML */
    review: ReviewResult
  }

  interface StreamResult {
    ok: true
    /** top-level sections the build was appended in */
    sections: number
    review: ReviewResult
  }

  interface CreateFrameInput {
    name: string
    html: string
    width: number
    height: number
    x?: number
    y?: number
    /** page id; default the canvas's current/first page */
    pageId?: string
  }

  interface ReplaceValuesInput {
    /** which literal kinds to rewrite */
    kinds: ('color' | 'radius' | 'spacing' | 'font' | 'fontSize')[]
    /** 'exact' swaps only values equal to a token's; 'nearest' also takes the
     *  closest token and reports the distance */
    match?: 'exact' | 'nearest'
    /** restrict to these token names; default: the canvas's tokens */
    to?: string[]
  }

  interface ReplaceValuesResult {
    /** literals swapped for var(--name) */
    count: number
    /** literals with no acceptable token, left in place */
    unmapped: { value: string; kind: string }[]
    htmlChars: number
    review: ReviewResult
  }

  interface Frames {
    /** Every frame of the canvas (optionally one page): id, name, box —
     *  never HTML. (read) */
    list(opts?: { pageId?: string }): Promise<FrameRef[]>
    /** The element tree of a frame: tags, data-doop-ids, boxes and short
     *  text — what to edit, without the document's weight. (read) */
    outline(frameId: string): Promise<OutlineNode>
    /** The frame's HTML, whole or the lines around `query`. (read) */
    html(frameId: string, opts?: { query?: string; offset?: number; limit?: number }): Promise<string>
    /** Literal design values in the frame's HTML and their token mapping.
     *  (read) */
    styles(frameId: string): Promise<StyleInventory>
    /** Find a string or selector in a frame. (read) */
    find(frameId: string, query: string): Promise<FrameFindHit[]>
    /** Create a frame with a complete HTML document. Streams the reveal for
     *  viewers like `create_frame` does. (write) */
    create(input: CreateFrameInput): Promise<FrameRef>
    /** Write a frame's HTML in top-level sections, appended live through the
     *  canvas room — viewers watch the design build. Use for a new design on
     *  an existing frame, or to replace one section at a time. (write) */
    stream(frameId: string, html: string): Promise<StreamResult>
    /** One batched edit: several ops applied in order as a single frame
     *  write and a single version. Elements are addressed by data-doop-id
     *  (see `outline`). (write) */
    edit(frameId: string, ops: EditOp[]): Promise<EditResult>
    /** Swap literal values for the canvas's tokens in one pass and report
     *  what had no match. (write) */
    replaceValues(frameId: string, input: ReplaceValuesInput): Promise<ReplaceValuesResult>
    /** Frame metadata: name, position, size, hidden, locked — never html
     *  (use `edit`/`stream`). (write) */
    update(
      frameId: string,
      patch: Partial<Pick<FrameRef, 'name' | 'hidden' | 'locked'> & Box & { pageId: string }>,
    ): Promise<FrameRef>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.checks — server-side numbers instead of screenshots         */
  /* ---------------------------------------------------------------- */

  interface LintResult {
    /** 0–100 anti-slop score */
    score: number
    errors: number
    warnings: number
    issues: Finding[]
  }

  interface MeasureResult {
    ok: true
    /** frame box the measurements were taken at */
    width: number
    height: number
    /** rendered document height vs the frame's (negative = content taller) */
    heightDeltaPx: number
    /** worst horizontal overflow of a single element, px */
    overflowPx: number
    /** elements sticking out of the frame box, with how much */
    outside: { elementId?: string; selector: string; px: number }[]
    /** text nodes clipped by their own box */
    clippedText: number
    /** sibling elements whose boxes overlap without a containment link */
    overlaps: { a: string; b: string; px: number }[]
    /** images that failed to load (broken URLs), with their src */
    brokenImages: { src: string }[]
    /** font families asked for that the renderer substituted */
    fallbackFonts: string[]
    /** console errors the page raised while rendering */
    consoleErrors: string[]
    /** first-level sections with their boxes, for per-section review */
    sections: { selector: string; elementId?: string; box: Box }[]
  }

  interface ResponsiveResult {
    score: number
    errors: number
    warnings: number
    issues: Finding[]
    /** per viewport width: worst overflow px and clipped-text count */
    viewports: { width: number; overflowPx: number; clippedText: number; tapTargets: number }[]
    focus: { focusables: number; reached: number; withoutVisibleFocus: number } | null
  }

  /** Opaque handle to a rendered snapshot; pass it to `diff`. */
  interface Snapshot {
    id: string
    frameId: string
    width: number
    height: number
  }

  interface DiffResult {
    /** share of pixels that differ, 0..1 — a token swap that should change
     *  nothing reports 0 */
    ratio: number
    /** the regions that changed, in frame px */
    regions: Box[]
    /** snapshot is stale: the frame's size changed since */
    resized: boolean
  }

  interface ReviewResult {
    ok: true
    /** anti-slop lint (score + error-level findings) */
    lint: LintResult
    /** responsive + a11y numbers, when a renderer answered */
    responsive: ResponsiveResult | null
    /** layout measurements, when a renderer answered */
    measure: MeasureResult | null
    /** share of style literals already written as var(--name) */
    tokenCoverage: number
    /** markup that redraws an existing component instead of <doop-use> */
    redrawnComponents: { component: string; elementId?: string }[]
    /** every error-level finding across the sources, flattened */
    errors: Finding[]
  }

  interface AutofixResult {
    ok: true
    /** what each fix changed, one line each — nothing else moved */
    changes: string[]
    /** findings that remain after the fixes */
    review: ReviewResult
  }

  interface Checks {
    /** Anti-slop lint of the frame's design (the `AS-*` rules). (read) */
    lint(frameId: string): Promise<LintResult>
    /** Overflow, clipped text, tap targets, contrast and focus at the three
     *  check widths. Needs the server renderer. (read) */
    responsive(frameId: string): Promise<ResponsiveResult>
    /** Layout numbers on the rendered frame: overflow, clipped text,
     *  overlapping siblings, off-frame elements, broken images, fallback
     *  fonts, console errors, per-section boxes. Needs the renderer. (read) */
    measure(frameId: string): Promise<MeasureResult>
    /** Render the frame and keep the pixels server-side for `diff`. (read) */
    snapshot(frameId: string): Promise<Snapshot>
    /** Pixel-diff the frame's current render against a snapshot: ratio of
     *  changed pixels and the changed regions. (read) */
    diff(frameId: string, snapshot: Snapshot): Promise<DiffResult>
    /** Every finding in one result: lint, responsive, measure, token
     *  coverage, redrawn components — no image. Every write returns one.
     *  (read) */
    review(frameId: string): Promise<ReviewResult>
    /** Apply the mechanical fixes only: a contrast failure moved to the
     *  nearest passing token, a tap target grown to 44 px, a literal swapped
     *  for the token of the same value. Reports each change; changes nothing
     *  else. Design decisions stay with the caller. (write, run_script only) */
    autofix(frameId: string, kinds?: ('contrast' | 'tapTarget' | 'tokenLiteral')[]): Promise<AutofixResult>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.tokens                                                      */
  /* ---------------------------------------------------------------- */

  interface TokenSummary {
    name: string
    type: string
    value: string
    themes?: Record<string, string>
  }

  interface TokenInput {
    /** CSS custom property name, `--color-primary` */
    name: string
    type: string
    value: string
    /** value under each named theme that differs */
    themes?: Record<string, string>
  }

  interface Tokens {
    /** The canvas's design tokens (name, type, value, per-theme overrides).
     *  (read) */
    /** namePattern: case-insensitive substring, or a `*` glob over the whole
     *  name (`--brand-*`, `*-color`). Not a regex. */
    get(opts?: { types?: string[]; namePattern?: string }): Promise<TokenSummary[]>
    /** Add tokens; a name already in use is an error. (write) */
    create(tokens: TokenInput[]): Promise<{ ok: true; created: string[]; failed: { name: string; reason: string }[] }>
    /** Change a token's value (and per-theme values). (write) */
    set(name: string, value: string, opts?: { theme?: string }): Promise<{ ok: true }>
    /** Declare the canvas's themes (replaces the list). (write) */
    themes(themes: string[]): Promise<{ ok: true; themes: string[] }>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.components                                                  */
  /* ---------------------------------------------------------------- */

  interface ComponentSummary {
    id: string
    name: string
    description: string
    /** insert syntax, e.g. `<doop-use component="hero" />` */
    usage: string
  }

  interface ComponentDef extends ComponentSummary {
    template: string
    css: string
    props: { name: string; type: string; required?: boolean; default?: unknown }[]
    slots: { name: string; description?: string }[]
  }

  interface Components {
    /** The canvas's components, summarized. (read) */
    list(): Promise<ComponentSummary[]>
    /** One component's full definition. (read) */
    get(componentId: string): Promise<ComponentDef>
    /** Define a component (template + css + props/slots). (write) */
    create(input: Omit<ComponentDef, 'id' | 'usage'>): Promise<ComponentSummary>
    /** Change a component's fields. (write) */
    update(componentId: string, patch: Partial<Omit<ComponentDef, 'id' | 'usage'>>): Promise<ComponentSummary>
    /** Insert `<doop-use>` markup for a component into a frame (before an
     *  element's data-doop-id, else at the end of <main>/<body>). (write) */
    insert(
      frameId: string,
      componentId: string,
      opts?: { before?: string; props?: Record<string, unknown> },
    ): Promise<EditResult>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.libraries                                                   */
  /* ---------------------------------------------------------------- */

  interface LibraryItemSummary {
    itemId: string
    /** `<canvasId>` of the library it belongs to */
    libraryId: string
    label: string
    description: string
    category: string
    tags: string[]
    box?: Box
  }

  interface LibraryItem extends LibraryItemSummary {
    /** the markup the item inserts */
    html: string
    css?: string
  }

  interface LibraryCheckFinding extends Finding {
    itemId: string
  }

  interface Libraries {
    /** Search the design libraries the caller may use, by text and tags.
     *  (read) */
    search(query: string, opts?: { limit?: number }): Promise<LibraryItemSummary[]>
    /** One item with its markup. (read) */
    item(itemId: string, opts?: { libraryId?: string }): Promise<LibraryItem>
    /** The library rules' findings on items (what curation flagged). (read) */
    check(opts?: { libraryId?: string }): Promise<LibraryCheckFinding[]>
    /** Insert a library item into a frame. Subject to AGENT_LIBRARY_WRITES
     *  where the item's library forbids agent curation — insertion on a
     *  canvas is always allowed when the item is readable. (write) */
    insert(frameId: string, itemId: string, opts?: { libraryId?: string; before?: string }): Promise<EditResult>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.compositions                                                */
  /* ---------------------------------------------------------------- */

  interface CompositionSummary {
    pageId: string
    duration: number
    fps: number
    width: number
    height: number
    tracks: number
    revision: number
  }

  interface CompositionDoc extends CompositionSummary {
    tracks: unknown[]
  }

  interface ElementStateAt {
    /** `frameId/elementId` */
    key: string
    x?: number
    y?: number
    width?: number
    height?: number
    opacity?: number
    rotation?: number
    [property: string]: number | string | undefined
  }

  interface StateAtResult {
    t: number
    camera: { x: number; y: number; zoom: number; rotation: number } | null
    elements: ElementStateAt[]
    activeClips: { trackId: string; kind: string }[]
    /** elements whose box crosses the title-safe margin (10% of the frame) */
    titleUnsafe: { key: string; box: Box }[]
    /** element boxes overlapping at t */
    overlaps: { a: string; b: string }[]
  }

  interface Compositions {
    /** The page's composition, or null when it has none. (read) */
    get(pageId: string): Promise<CompositionDoc | null>
    /** Where every animated element is at each given time — boxes and
     *  opacity from the timeline's keyframes, computed, not rendered. One
     *  entry per requested t. (read) */
    stateAt(pageId: string, times: number[]): Promise<StateAtResult[]>
    /** The `MO-*` seek-safety lint of the page's composition and frames.
     *  (read) */
    lint(pageId: string): Promise<{ ok: true; errors: number; warnings: number; issues: Finding[] }>
    /** Build a composition from the page's frames: one shot per frame in
     *  reading order, a camera track cutting between them. (write) */
    storyboard(
      pageId: string,
      opts?: {
        shotSeconds?: number
        margin?: number
        fps?: number
        width?: number
        height?: number
        frameIds?: string[]
      },
    ): Promise<{ ok: true; revision: number; shots: number }>
    /** Apply composition ops atomically (same ops as set_composition). (write) */
    patch(
      pageId: string,
      ops: Record<string, unknown>[],
      opts?: { expectedRevision?: number },
    ): Promise<{ ok: true; revision: number }>
    /** Queue a render job (the existing render gate, background priority).
     *  (write) */
    render(
      pageId: string,
      opts?: { format?: 'mp4' | 'webm'; target?: 'browser' | 'desktop'; range?: { start?: number; end?: number } },
    ): Promise<{ ok: true; jobId: string }>
  }

  /* ---------------------------------------------------------------- */
  /* diazo.search — facts, not pixels                                  */
  /* ---------------------------------------------------------------- */

  interface ImageHit {
    url: string
    width: number
    height: number
    alt: string
    /** dominant colour, when the provider reports one */
    color?: string
    credit?: string
  }

  interface IconHit {
    name: string
    /** hotlinkable SVG URL */
    url: string
    tags: string[]
  }

  interface LogoHit {
    name: string
    domain: string
    /** logo asset URL (SVG preferred) */
    url: string
  }

  interface Search {
    /** Stock photos as text facts: URL, size, alt, main colour. (read) */
    images(query: string, opts?: { limit?: number }): Promise<ImageHit[]>
    /** UI icons as hotlinkable SVGs. (read) */
    icons(query: string, opts?: { limit?: number }): Promise<IconHit[]>
    /** A real company's logo by brand name or domain — one call per brand.
     *  (read) */
    logos(brand: string): Promise<LogoHit[]>
  }

  /* ---------------------------------------------------------------- */
  /* the global                                                        */
  /* ---------------------------------------------------------------- */

  const run: RunInfo
  const canvas: Canvas
  const frames: Frames
  const checks: Checks
  const tokens: Tokens
  const components: Components
  const libraries: Libraries
  const compositions: Compositions
  const search: Search

  interface DiazoError extends Error {
    name: 'DiazoError'
    /** machine-readable reason */
    code:
      | 'permission' // the caller's canvas role forbids it
      | 'not_found' // the id names nothing on this canvas
      | 'invalid' // bad argument (the message says what)
      | 'conflict' // expected_revision or a concurrent write refused it
      | 'unavailable' // a needed service is off (renderer, search, …)
      | 'refused' // an env switch forbids it (AGENT_*_WRITES, DOOP_AGENT_SCRIPTS)
      | 'limit' // a run limit ended the run; `limit` names which
      | 'failed' // anything else
    /** on code 'limit': wall | memory | sdk_calls | frame_writes | script_size | result_size */
    limit?: string
  }
}
