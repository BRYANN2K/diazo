/**
 * Library search: an inverted index over a library's items, a small query
 * language (`kind:cp in:"Inputs & forms" otp`), BM25 ranking over weighted
 * fields, facets and grouping into families. Pure and synchronous: the
 * server builds one index per library from its rows and answers ⌘F, the
 * gallery and the agent tools from it.
 */
import type { LibraryFacet, LibraryFacetName, LibraryItem, LibraryTaxonomy } from './library.ts'

/** How much a match in each field counts. */
export const FIELD_WEIGHTS = {
  id: 10,
  label: 6,
  tags: 5,
  category: 4,
  source: 3,
  kind: 3,
  description: 2,
  text: 1,
} as const

const BONUS = { exactId: 1000, idSegment: 400, family: 50, usage: 20, deprecated: -500 }
/** a prefix match counts for less than the whole word */
const PREFIX_FACTOR = 0.7
const FUZZY_FACTOR = 0.5
/** shortest word that also matches as a prefix when it is not the last */
const MIN_PREFIX = 3
const MIN_FUZZY = 5
const MAX_VARIANTS = 12
const K1 = 1.2
const B = 0.75

/** Lowercase, accents folded, split on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** An id kept whole and split: `cp.scb-otp-input` → itself, cp, scb, otp, input. */
export function idTokens(id: string): string[] {
  const whole = id.toLowerCase()
  return [...new Set([whole, ...tokenize(id)])]
}

export interface QueryFilters {
  kind?: string[]
  category?: string[]
  tag?: string[]
  source?: string[]
  /** scripted | component | deprecated | draft */
  is?: string[]
}

export interface ParsedQuery {
  /** the words, lowercased, in order */
  terms: string[]
  filters: QueryFilters
  /** the query ended in a space: the last word is complete */
  closed: boolean
}

const FILTER_KEYS: Record<string, keyof QueryFilters> = {
  kind: 'kind',
  in: 'category',
  category: 'category',
  tag: 'tag',
  source: 'source',
  is: 'is',
}

/** Split a query into words and `key:value` filters (`in:"Inputs & forms"`). */
export function parseQuery(q: string): ParsedQuery {
  const filters: QueryFilters = {}
  const terms: string[] = []
  const re = /(\w+):(?:"([^"]*)"?|(\S+))|"([^"]*)"?|(\S+)/g
  for (const m of q.matchAll(re)) {
    const key = m[1] ? FILTER_KEYS[m[1].toLowerCase()] : undefined
    if (m[1] && key) {
      const value = (m[2] ?? m[3] ?? '').trim()
      if (value) (filters[key] ??= []).push(value)
      continue
    }
    const word = m[1] ? m[0] : (m[4] ?? m[5] ?? '')
    if (word.trim()) terms.push(word.trim().toLowerCase())
  }
  return { terms, filters, closed: /\s$/.test(q) }
}

interface Postings {
  docs: Int32Array
  tf: Float32Array
}

export interface LibraryIndex {
  items: LibraryItem[]
  taxonomy: LibraryTaxonomy
  /** every term, sorted, for prefix and fuzzy lookups */
  terms: string[]
  postings: Map<string, Postings>
  docLength: Float32Array
  avgLength: number
  /** each doc's family doc (itself for a family or an orphan) */
  familyOf: Int32Array
  /** non-hidden variants per family doc */
  variantCount: Int32Array
  /** lowercase id → doc */
  byId: Map<string, number>
}

function fieldTokens(item: LibraryItem): [number, string[]][] {
  return [
    [FIELD_WEIGHTS.id, idTokens(item.itemId)],
    [FIELD_WEIGHTS.label, tokenize(item.label)],
    [FIELD_WEIGHTS.tags, item.tags.flatMap(tokenize)],
    [FIELD_WEIGHTS.category, tokenize(item.category)],
    [FIELD_WEIGHTS.source, tokenize(item.source)],
    [FIELD_WEIGHTS.kind, tokenize(item.kind)],
    [FIELD_WEIGHTS.description, tokenize(item.description)],
    [FIELD_WEIGHTS.text, tokenize(item.searchText)],
  ]
}

/** Build the index of one library from its effective items. */
export function buildIndex(items: LibraryItem[], taxonomy: LibraryTaxonomy): LibraryIndex {
  const raw = new Map<string, { docs: number[]; tf: number[] }>()
  const docLength = new Float32Array(items.length)
  const byId = new Map<string, number>()
  items.forEach((item, doc) => {
    byId.set(item.itemId.toLowerCase(), doc)
    const weights = new Map<string, number>()
    let length = 0
    for (const [weight, tokens] of fieldTokens(item)) {
      for (const token of tokens) {
        weights.set(token, (weights.get(token) ?? 0) + weight)
        length += weight
      }
    }
    docLength[doc] = length
    for (const [token, tf] of weights) {
      let p = raw.get(token)
      if (!p) raw.set(token, (p = { docs: [], tf: [] }))
      p.docs.push(doc)
      p.tf.push(tf)
    }
  })
  const postings = new Map<string, Postings>()
  for (const [token, p] of raw) postings.set(token, { docs: Int32Array.from(p.docs), tf: Float32Array.from(p.tf) })
  const familyOf = new Int32Array(items.length)
  const variantCount = new Int32Array(items.length)
  items.forEach((item, doc) => {
    const parent = item.parentId ? byId.get(item.parentId.toLowerCase()) : undefined
    familyOf[doc] = parent ?? doc
    if (parent !== undefined && item.status !== 'hidden') variantCount[parent] = (variantCount[parent] ?? 0) + 1
  })
  const total = docLength.reduce((a, b) => a + b, 0)
  return {
    items,
    taxonomy,
    terms: [...postings.keys()].sort(),
    postings,
    docLength,
    avgLength: items.length ? total / items.length : 1,
    familyOf,
    variantCount,
    byId,
  }
}

/* ---- matching ---- */

/** the first index of a sorted list at or after `value` */
function lowerBound(list: string[], value: string): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function prefixTerms(index: LibraryIndex, prefix: string): string[] {
  const out: string[] = []
  for (let i = lowerBound(index.terms, prefix); i < index.terms.length; i++) {
    const term = index.terms[i]!
    if (!term.startsWith(prefix)) break
    if (term !== prefix) out.push(term)
  }
  return out
}

/** one edit (substitution, insertion, deletion or adjacent swap) apart */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

function fuzzyTerms(index: LibraryIndex, token: string): string[] {
  if (token.length < MIN_FUZZY) return []
  return index.terms.filter((t) => t.length >= MIN_FUZZY - 1 && oneEditApart(t, token))
}

/** A term to look up and how much a match counts. */
interface Lookup {
  term: string
  factor: number
}

/** One query word: alternatives (the word, its synonyms), each a list of
 *  tokens that must all match. */
type Clause = Lookup[][][]

function idf(index: LibraryIndex, df: number): number {
  const n = index.items.length
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/** Score every doc for one token's lookups into `into`; returns the docs hit. */
function scoreLookups(index: LibraryIndex, lookups: Lookup[], into: Float64Array): Set<number> {
  const hit = new Set<number>()
  for (const { term, factor } of lookups) {
    const p = index.postings.get(term)
    if (!p) continue
    const w = idf(index, p.docs.length) * factor
    for (let i = 0; i < p.docs.length; i++) {
      const doc = p.docs[i]!
      const tf = p.tf[i]!
      const norm = tf + K1 * (1 - B + (B * index.docLength[doc]!) / index.avgLength)
      const s = (w * (tf * (K1 + 1))) / norm
      if (s > into[doc]!) into[doc] = s
      hit.add(doc)
    }
  }
  return hit
}

function lookupsFor(index: LibraryIndex, token: string, prefix: boolean, fuzzy: boolean): Lookup[] {
  const out: Lookup[] = [{ term: token, factor: 1 }]
  if (prefix) for (const term of prefixTerms(index, token)) out.push({ term, factor: PREFIX_FACTOR })
  if (fuzzy && !index.postings.has(token)) {
    for (const term of fuzzyTerms(index, token)) out.push({ term, factor: FUZZY_FACTOR })
  }
  return out
}

function buildClauses(
  index: LibraryIndex,
  parsed: ParsedQuery,
  synonyms: Record<string, string[]>,
  fuzzy: boolean,
): Clause[] {
  const words = parsed.terms.flatMap((term) => tokenize(term))
  const reverse = new Map<string, string[]>()
  for (const [key, values] of Object.entries(synonyms)) {
    for (const v of values) {
      const toks = tokenize(v)
      if (toks.length === 1) reverse.set(toks[0]!, [...(reverse.get(toks[0]!) ?? []), key])
    }
  }
  return words.map((word, i) => {
    const last = i === words.length - 1
    const prefix = (last && !parsed.closed) || word.length >= MIN_PREFIX
    const alternatives: string[][] = [[word]]
    for (const s of synonyms[word] ?? []) alternatives.push(tokenize(s))
    for (const s of reverse.get(word) ?? []) alternatives.push(tokenize(s))
    /* the word itself first; a synonym counts for less, and a several-word
       one as much as one word, so it widens without outranking */
    return alternatives
      .filter((alt) => alt.length)
      .map((alt, a) => {
        const weight = a === 0 ? 1 : SYNONYM_WEIGHT / alt.length
        return alt.map((tok) =>
          lookupsFor(index, tok, prefix && tok === word, fuzzy).map((l) => ({ ...l, factor: l.factor * weight })),
        )
      })
  })
}

/** how much a synonym's match counts against the word's own */
const SYNONYM_WEIGHT = 0.6

/** The docs a clause matches, and their score for it. */
function evalClause(index: LibraryIndex, clause: Clause): Map<number, number> {
  const out = new Map<number, number>()
  for (const alternative of clause) {
    let docs = null as Set<number> | null
    const sum = new Map<number, number>()
    for (const lookups of alternative) {
      const scores = new Float64Array(index.items.length)
      const hit = scoreLookups(index, lookups, scores)
      docs = docs ? new Set([...docs].filter((d) => hit.has(d))) : hit
      for (const d of hit) sum.set(d, (sum.get(d) ?? 0) + scores[d]!)
    }
    for (const d of docs ?? []) out.set(d, Math.max(out.get(d) ?? 0, sum.get(d) ?? 0))
  }
  return out
}

function combine(results: Map<number, number>[], mode: 'and' | 'or'): Map<number, number> {
  if (!results.length) return new Map()
  const out = new Map<number, number>()
  if (mode === 'and') {
    const [first, ...rest] = [...results].sort((a, b) => a.size - b.size)
    for (const [doc, score] of first!) {
      let total = score
      let all = true
      for (const r of rest) {
        const s = r.get(doc)
        if (s === undefined) {
          all = false
          break
        }
        total += s
      }
      if (all) out.set(doc, total)
    }
    return out
  }
  for (const r of results) for (const [doc, s] of r) out.set(doc, (out.get(doc) ?? 0) + s)
  return out
}

/* ---- filters ---- */

const lower = (v: string) => v.toLowerCase()

function mergeFilters(a: QueryFilters, b: QueryFilters = {}): QueryFilters {
  const out: QueryFilters = {}
  for (const key of ['kind', 'category', 'tag', 'source', 'is'] as const) {
    const values = [...(a[key] ?? []), ...(b[key] ?? [])].filter(Boolean)
    if (values.length) out[key] = values
  }
  return out
}

function passes(item: LibraryItem, f: QueryFilters, includeDrafts: boolean): boolean {
  if (item.status === 'hidden') return false
  const is = (f.is ?? []).map(lower)
  if (item.status === 'draft' && !includeDrafts && !is.includes('draft')) return false
  if (f.kind && !f.kind.map(lower).includes(item.kind.toLowerCase())) return false
  if (f.source && !f.source.map(lower).includes(item.source.toLowerCase())) return false
  if (f.tag && !f.tag.map(lower).some((t) => item.tags.some((x) => x.toLowerCase() === t))) return false
  if (f.category) {
    const cat = item.category.toLowerCase()
    if (!f.category.map(lower).some((c) => cat === c || cat.startsWith(`${c}/`))) return false
  }
  for (const flag of is) {
    if (flag === 'scripted' && !item.scripted) return false
    if (flag === 'component' && item.mode !== 'component') return false
    if (flag === 'deprecated' && item.status !== 'deprecated') return false
    if (flag === 'draft' && item.status !== 'draft') return false
  }
  return true
}

/* ---- the search ---- */

export interface IndexHit {
  item: LibraryItem
  variants: LibraryItem[]
  variantCount: number
  score: number
}

export interface IndexResult {
  hits: IndexHit[]
  total: number
  facets: Record<LibraryFacetName, LibraryFacet[]>
  cursor?: string
}

export type LibrarySort = 'relevance' | 'used' | 'newest'

/** Common UI words people search by another name. Every library gets them;
 *  its own `search.synonyms` win key by key, and an empty list there drops
 *  a default ("login": [] stops "login" finding "sign in"). */
export const DEFAULT_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  login: ['sign in', 'signin', 'log in'],
  signup: ['sign up', 'register'],
  logout: ['sign out', 'log out'],
  modal: ['dialog', 'popup'],
  dialog: ['modal'],
  dropdown: ['select', 'menu'],
  toast: ['snackbar', 'notification'],
  tooltip: ['hint', 'popover'],
  navbar: ['navigation', 'header', 'nav'],
  sidebar: ['drawer', 'side nav'],
  avatar: ['profile picture'],
  otp: ['one time password', 'verification code', 'pin'],
  checkbox: ['check box', 'tick'],
  toggle: ['switch'],
  switch: ['toggle'],
  spinner: ['loader', 'loading'],
  card: ['tile'],
  tabs: ['segmented'],
  badge: ['chip', 'pill'],
  search: ['find', 'lookup'],
  pricing: ['plans', 'price'],
  cta: ['call to action'],
  footer: ['bottom bar'],
}

/** The defaults with a library's own groups over them. */
export function mergeSynonyms(own: Record<string, string[]> = {}): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(DEFAULT_SYNONYMS)) out[key] = [...values]
  for (const [key, values] of Object.entries(own)) {
    const k = key.toLowerCase().trim()
    if (values.length) out[k] = values
    else delete out[k]
  }
  return out
}

export interface SearchOptions {
  limit?: number
  cursor?: string
  includeDrafts?: boolean
  synonyms?: Record<string, string[]>
  /** filters given as request parameters, on top of the query's own */
  filters?: QueryFilters
  sort?: LibrarySort
}

function bonus(item: LibraryItem, rawTerms: string[], tokens: string[]): number {
  let b = 0
  const id = item.itemId.toLowerCase()
  if (rawTerms.includes(id) || rawTerms.join(' ') === id) b += BONUS.exactId
  const segments = new Set(tokenize(item.itemId))
  if (tokens.some((t) => segments.has(t))) b += BONUS.idSegment
  return b + standing(item)
}

/** what ranks an item apart from the text: family, use, deprecation */
function standing(item: LibraryItem): number {
  let b = 0
  if (!item.parentId) b += BONUS.family
  b += Math.log(1 + (item.useCount ?? 0)) * BONUS.usage
  if (item.status === 'deprecated') b += BONUS.deprecated
  return b
}

function facetsOf(index: LibraryIndex, families: number[]): Record<LibraryFacetName, LibraryFacet[]> {
  const counts: Record<LibraryFacetName, Map<string, number>> = {
    kind: new Map(),
    category: new Map(),
    source: new Map(),
    tag: new Map(),
  }
  const add = (name: LibraryFacetName, value: string) => {
    if (value) counts[name].set(value, (counts[name].get(value) ?? 0) + 1)
  }
  for (const doc of families) {
    const item = index.items[doc]!
    add('kind', item.kind)
    add('category', item.category.split('/')[0] ?? '')
    add('source', item.source)
    for (const tag of new Set(item.tags)) add('tag', tag)
  }
  const kindLabel = new Map(index.taxonomy.kinds.map((k) => [k.id, k.label]))
  const sourceLabel = new Map(index.taxonomy.sources.map((s) => [s.id, s.label]))
  const list = (name: LibraryFacetName, label: (v: string) => string) =>
    [...counts[name]]
      .map(([value, count]) => ({ value, label: label(value), count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  return {
    kind: list('kind', (v) => kindLabel.get(v) ?? v),
    category: list('category', (v) => v),
    source: list('source', (v) => sourceLabel.get(v) ?? v),
    tag: list('tag', (v) => v),
  }
}

/** Answer a query: families with their matched variants, facets over the
 *  whole match set, and a cursor for the next page. */
export function searchIndex(index: LibraryIndex, query: string, opts: SearchOptions = {}): IndexResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200))
  const offset = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0)
  const parsed = parseQuery(query)
  const filters = mergeFilters(parsed.filters, opts.filters)
  const includeDrafts = !!opts.includeDrafts
  const synonyms = mergeSynonyms(opts.synonyms)
  const tokens = parsed.terms.flatMap(tokenize)

  /* doc → text score; null means "browse": every doc that passes */
  let scored: Map<number, number> | null = null
  if (tokens.length) {
    const run = (fuzzy: boolean) => {
      const results = buildClauses(index, parsed, synonyms, fuzzy).map((c) => evalClause(index, c))
      const and = combine(results, 'and')
      return and.size || results.length < 2 ? and : combine(results, 'or')
    }
    scored = run(false)
    if (!scored.size) scored = run(true)
  }

  const groups = new Map<number, { score: number; variants: { doc: number; score: number }[]; self: boolean }>()
  const consider = (doc: number, text: number) => {
    const item = index.items[doc]!
    if (!passes(item, filters, includeDrafts)) return
    const score = text + (scored ? bonus(item, parsed.terms, tokens) : standing(item))
    let family = index.familyOf[doc]!
    /* a variant whose family is out of view stands alone */
    if (family !== doc && !passes(index.items[family]!, {}, includeDrafts)) family = doc
    let g = groups.get(family)
    if (!g) groups.set(family, (g = { score: -Infinity, variants: [], self: false }))
    if (family === doc) g.self = true
    else g.variants.push({ doc, score })
    g.score = Math.max(g.score, score)
  }
  if (scored) for (const [doc, text] of scored) consider(doc, text)
  else for (let doc = 0; doc < index.items.length; doc++) consider(doc, 0)

  const sort = opts.sort ?? 'relevance'
  const order = [...groups.entries()]
  order.sort(([a, ga], [b, gb]) => {
    const ia = index.items[a]!
    const ib = index.items[b]!
    if (sort === 'used') {
      const d = (ib.useCount ?? 0) - (ia.useCount ?? 0)
      if (d) return d
    } else if (sort === 'newest') {
      const d = ib.indexedAt - ia.indexedAt
      if (d) return d
    }
    if (scored || sort !== 'relevance') {
      const d = gb.score - ga.score
      if (d) return d
    }
    return a - b
  })

  const page = order.slice(offset, offset + limit).map(([family, g]): IndexHit => {
    const variants = g.variants
      .sort((x, y) => y.score - x.score || x.doc - y.doc)
      .slice(0, MAX_VARIANTS)
      .map((v) => index.items[v.doc]!)
    return {
      item: index.items[family]!,
      variants: scored ? variants : [],
      variantCount: index.variantCount[family] ?? 0,
      score: Number.isFinite(g.score) ? Math.round(g.score * 1000) / 1000 : 0,
    }
  })
  const next = offset + limit
  return {
    hits: page,
    total: order.length,
    facets: facetsOf(
      index,
      order.map(([family]) => family),
    ),
    ...(next < order.length ? { cursor: String(next) } : {}),
  }
}
