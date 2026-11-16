/**
 * Design libraries: a canvas whose frames are indexed as items with
 * variants, categories, tags and import rules. The vocabulary shared by the
 * server (indexer, routes, tools) and the client (⌘F, the gallery).
 * Spec: .workflow/specs/design-libraries.md.
 */

import type { DuplicateMatch } from './libraryProvenance.ts'

/** Who may use a library. `public` needs DOOP_PUBLIC_LIBRARIES. */
export type LibraryVisibility = 'private' | 'workspace' | 'public'

/** The lifecycle an item is in. `draft` failed a rule and waits in the
 *  inbox; `deprecated` sinks in search; `hidden` never shows. */
export type ItemStatus = 'active' | 'draft' | 'deprecated' | 'hidden'

/** What an insert makes of an item: a scoped copy, or a linked instance. */
export type ItemMode = 'snapshot' | 'component'

/** Where an item sits in its frame: the whole document, the element
 *  carrying a `data-doop-id`, or the element around a text (its id). */
export type ItemLocator = { whole: true } | { elementId: string } | { anchor: string }

/** An item's box in frame px, known once the rendered pass has run. */
export interface ItemBox {
  x: number
  y: number
  w: number
  h: number
}

export type RuleFindingKind =
  'no-id' | 'id-collision' | 'duplicate' | 'lint' | 'missing-dependency' | 'unreadable' | 'token-match' | 'suggested'

/** Why an item is what it is: a rule outcome, shown in the inbox and to agents. */
export interface RuleFinding {
  kind: RuleFindingKind
  message: string
  /** the other item, for `duplicate` and `id-collision` */
  itemId?: string
  /** the lint score, for `lint` */
  score?: number
  /** the referenced ids, for `missing-dependency` */
  refs?: string[]
}

/** A kind: the id's first segment (`cp`, `bk`, `mo`…). */
export interface LibraryKind {
  id: string
  label: string
  /** resources and rule cards cannot be inserted */
  insertable: boolean
}

/** A source: the id's second segment (`scb`, `tuff`), a vendor or origin. */
export interface LibrarySource {
  id: string
  label: string
  url?: string
  license?: string
}

/** A category: a path of up to three levels, `Inputs & forms/OTP & code inputs`. */
export interface LibraryCategory {
  path: string
  label?: string
}

export interface LibraryTaxonomy {
  kinds: LibraryKind[]
  sources: LibrarySource[]
  categories: LibraryCategory[]
}

export const EMPTY_TAXONOMY: LibraryTaxonomy = { kinds: [], sources: [], categories: [] }

/** The category an item gets when no rule found one. */
export const UNSORTED = 'Unsorted'

/** How far an index run got. */
export interface LibraryIndexState {
  status: 'idle' | 'running' | 'done' | 'failed'
  total: number
  done: number
  rendered: number
  failed: number
  startedAt?: number
  finishedAt?: number
}

/** What rides on `canvas.library`: enough to show a library, never its rules. */
export interface LibraryInfo {
  description: string
  visibility: LibraryVisibility
  /** families: items with no parent */
  items: number
  /** variants: items with a parent */
  variants: number
  index: LibraryIndexState | null
  rulesVersion: number
  /** a model describes and tags thin items (off by default) */
  describeItems?: boolean
  /** the thumbnail prewarm, once it has looked at this library */
  thumbs?: ThumbProgress
}

/** How many of a library's items have their thumbnail in storage. */
export interface ThumbProgress {
  ready: number
  total: number
  /** missing ones are being rendered */
  running: boolean
  /** items whose thumbnail could not be rendered this run */
  failed?: number
}

/** One indexed item: a row of the rebuildable projection. */
export interface LibraryItem {
  canvasId: string
  itemId: string
  /** the family id; null for a family */
  parentId: string | null
  frameId: string
  pageId: string
  /** order inside its frame */
  position: number
  label: string
  description: string
  /** '' when the id has none */
  kind: string
  source: string
  category: string
  tags: string[]
  mode: ItemMode
  locator: ItemLocator
  box: ItemBox | null
  scripted: boolean
  /** the rule outcome; curation may override it (see effectiveItem) */
  status: ItemStatus
  findings: RuleFinding[]
  hash: string
  rev: number
  searchText: string
  sourceUrl: string | null
  license: string | null
  /** the page it was captured from, normalised: what "same page" compares */
  sourceKey?: string | null
  /** the frame it was copied from, `<canvasId>:<frameId>` */
  origin?: string | null
  indexedAt: number
  /** from curation; 0 on a bare row */
  useCount?: number
}

/** What people curate, stored apart so a rebuild never loses it. A null
 *  field falls through to the indexed value. */
export interface LibraryItemMeta {
  canvasId: string
  itemId: string
  label: string | null
  description: string | null
  category: string | null
  tags: string[] | null
  /** 'active' accepts a draft */
  status: 'active' | 'deprecated' | 'hidden' | null
  useCount: number
  lastUsedAt: number | null
  updatedAt: number
  updatedBy: string | null
  /** a model's description and tags for a thin item, until accepted */
  suggested?: ItemSuggestion | null
}

/** What a model proposed for an item whose person left the fields empty:
 *  searchable at once, shown as people's words only once accepted. */
export interface ItemSuggestion {
  description: string | null
  tags: string[] | null
  at: number
}

/** The item as people see it: curation over the index. */
export function effectiveItem(item: LibraryItem, meta: LibraryItemMeta | null | undefined): LibraryItem {
  if (!meta) return item
  return {
    ...item,
    label: meta.label ?? item.label,
    description: meta.description ?? item.description,
    category: meta.category ?? item.category,
    tags: meta.tags ?? item.tags,
    status: meta.status ?? item.status,
    useCount: meta.useCount,
    ...(meta.suggested ? { searchText: suggestedText(item.searchText, meta.suggested) } : {}),
  }
}

function suggestedText(searchText: string, s: ItemSuggestion): string {
  return [searchText, s.description ?? '', ...(s.tags ?? [])].filter(Boolean).join(' ')
}

/** A family and its variants, in frame order. */
export interface ItemFamily {
  family: LibraryItem
  variants: LibraryItem[]
}

/** Group items into families. A variant whose parent is missing stands as
 *  its own family, so nothing is lost. */
export function familyOf(items: LibraryItem[]): ItemFamily[] {
  const byId = new Map(items.map((it) => [it.itemId, it]))
  const families = new Map<string, ItemFamily>()
  for (const it of items) {
    if (it.parentId && byId.has(it.parentId)) continue
    families.set(it.itemId, { family: it, variants: [] })
  }
  for (const it of items) {
    if (!it.parentId) continue
    families.get(it.parentId)?.variants.push(it)
  }
  for (const f of families.values()) f.variants.sort((a, b) => a.position - b.position)
  return [...families.values()]
}

/** An item on the wire: what search, ⌘F and the gallery need. */
export interface LibraryItemSummary {
  id: string
  parentId: string | null
  label: string
  kind: string
  source: string
  category: string
  tags: string[]
  status: ItemStatus
  mode: ItemMode
  frameId: string
  pageId: string
  locator: ItemLocator
  box: ItemBox | null
  scripted: boolean
  rev: number
  /** the image URL of the item */
  thumb: string
  /** the size of its frame, for cropping the frame preview to the item */
  frameSize?: { w: number; h: number }
}

export function itemSummary(item: LibraryItem, thumb = ''): LibraryItemSummary {
  return {
    id: item.itemId,
    parentId: item.parentId,
    label: item.label,
    kind: item.kind,
    source: item.source,
    category: item.category,
    tags: item.tags,
    status: item.status,
    mode: item.mode,
    frameId: item.frameId,
    pageId: item.pageId,
    locator: item.locator,
    box: item.box,
    scripted: item.scripted,
    rev: item.rev,
    thumb,
  }
}

export type LibraryFacetName = 'kind' | 'category' | 'source' | 'tag'

export interface LibraryFacet {
  value: string
  label: string
  count: number
}

/** One family in a search: the family, the variants that matched, how many it has. */
export interface LibrarySearchHit {
  libraryId: string
  libraryName: string
  item: LibraryItemSummary
  /** the matched ones, best first, at most 12 */
  variants: LibraryItemSummary[]
  variantCount: number
  score: number
}

export interface LibrarySearchResult {
  hits: LibrarySearchHit[]
  total: number
  facets: Record<LibraryFacetName, LibraryFacet[]>
  cursor?: string
}

/** What converting a canvas, or changing its rules, would give: the dry run. */
export interface LibraryPreview {
  frames: number
  families: number
  variants: number
  /** frames whose scripts build variants the static pass cannot see */
  scripted: number
  ignored: { frameId: string; name: string; section?: string }[]
  unreadable: { frameId: string; name: string; reason: string }[]
  duplicates: { itemId: string; frameIds: string[] }[]
  categories: { path: string; count: number }[]
  /** the kinds, sources and categories the frames suggest */
  taxonomy: LibraryTaxonomy
}

/** A library in a list: the canvas it is, and what the caller may do. */
export interface LibraryListEntry {
  id: string
  name: string
  library: LibraryInfo
  role: 'read' | 'curate' | 'manage'
  workspaceId: string | null
  /** picked in the person's reference library */
  listed: boolean
}

/** One library in full: its rules and taxonomy, for its settings and agents. */
export interface LibraryDetail extends LibraryListEntry {
  rules: unknown
  rulesText: string[]
  taxonomy: LibraryTaxonomy
}

/** One item with its variants and provenance. */
export interface LibraryItemDetail {
  libraryId: string
  libraryName: string
  item: LibraryItemSummary & {
    description: string
    sourceUrl: string | null
    license: string | null
    findings: RuleFinding[]
    useCount: number
  }
  variants: LibraryItemSummary[]
  /** the family, when the item is a variant */
  family: LibraryItemSummary | null
}

/** Curation a person may write on an item. */
export interface LibraryItemPatch {
  label?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  status?: 'active' | 'deprecated' | 'hidden' | null
}

/** What an import does to one frame (a dry run returns it; an apply carries it out). */
export interface ImportFrameReport {
  frameId: string
  /** the name says it is not an item: placed, and yields none */
  ignored: boolean
  /** the duplicate rule left it out */
  skipped?: boolean
  item?: {
    itemId: string
    label: string
    kind: string
    source: string
    category: string
    tags: string[]
    status: 'active' | 'draft'
  }
  /** the variant ids found in it */
  variants: string[]
  findings: RuleFinding[]
  changes: {
    name?: string
    html?: string
    pageId?: string
    /** a page to create for its category, by name */
    newPage?: string
    x?: number
    y?: number
  }
}

export interface ImportReport {
  frames: ImportFrameReport[]
  /** frames left out because a library already holds them (unless forced) */
  duplicates?: { frameId: string; name: string; matches: DuplicateMatch[] }[]
  totals: { frames: number; items: number; variants: number; ignored: number; drafts: number; findings: number }
}
