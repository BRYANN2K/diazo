/**
 * Library item ids: `kind.source-slug`, `kind.slug` or a bare `slug`, made
 * of lowercase `[a-z0-9]` segments joined by `.` then `-`, at most 120
 * characters. Upper-case ids such as `AS-IMG-02` are accepted as legacy and
 * compared without case.
 */

export const MAX_ITEM_ID = 120

/** The grammar: an optional `kind.` then hyphen-joined segments. */
export const ITEM_ID_RE = /^(?:[a-z0-9]+\.)?[a-z0-9]+(?:-[a-z0-9]+)*$/

const LEGACY_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/

export function isLegacyItemId(id: string): boolean {
  return id.length <= MAX_ITEM_ID && LEGACY_ID_RE.test(id)
}

export function isItemId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ITEM_ID && (ITEM_ID_RE.test(id) || LEGACY_ID_RE.test(id))
}

export interface ParsedItemId {
  kind: string
  source: string
  slug: string
}

/** Split an id into kind, source and slug. A source is the first segment
 *  after the kind when the rest has more than one; with `sources` given,
 *  only a known one counts. Null for what is not an id. */
export function parseItemId(id: string, sources?: Iterable<string>): ParsedItemId | null {
  if (!isItemId(id)) return null
  if (isLegacyItemId(id)) {
    const [kind = '', ...rest] = id.toLowerCase().split('-')
    return { kind, source: '', slug: rest.join('-') }
  }
  const dot = id.indexOf('.')
  if (dot < 0) return { kind: '', source: '', slug: id }
  const kind = id.slice(0, dot)
  const segments = id.slice(dot + 1).split('-')
  const known = sources ? new Set(sources) : null
  const first = segments[0] ?? ''
  const isSource = segments.length > 1 && (!known || known.has(first))
  return isSource
    ? { kind, source: first, slug: segments.slice(1).join('-') }
    : { kind, source: '', slug: segments.join('-') }
}

/** A frame named `<id> — <label>` gives its id and label; any other name is
 *  a label alone. */
export function splitFrameName(name: string): { id: string | null; label: string } {
  const at = name.indexOf(' — ')
  if (at > 0) {
    const id = name.slice(0, at).trim()
    if (isItemId(id)) return { id, label: name.slice(at + 3).trim() }
  }
  return { id: null, label: name }
}

/** A label as id segments: lowercase, accents folded, anything else a hyphen. */
export function itemSlug(label: string, max = 60): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '')
}

export type OnCollision = 'suffix' | 'reject' | 'replace'

export type AssignedId =
  { ok: true; id: string; replaces: boolean } | { ok: false; id: string; reason: 'collision' | 'empty' }

/** An id for a new item from its kind, source and label, checked against
 *  the ids already taken under the library's collision rule. */
export function assignItemId(
  parts: { kind: string; source: string; label: string },
  taken: Iterable<string>,
  onCollision: OnCollision,
): AssignedId {
  const prefix = (parts.kind ? `${parts.kind}.` : '') + (parts.source ? `${parts.source}-` : '')
  const slug = itemSlug(parts.label, MAX_ITEM_ID - prefix.length - 4).replace(/-+$/, '')
  const base = prefix + slug
  if (!slug) return { ok: false, id: base, reason: 'empty' }
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  if (!used.has(base)) return { ok: true, id: base, replaces: false }
  if (onCollision === 'reject') return { ok: false, id: base, reason: 'collision' }
  if (onCollision === 'replace') return { ok: true, id: base, replaces: true }
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  return { ok: true, id: `${base}-${n}`, replaces: false }
}

/** The family an id belongs to: the longest family id it extends with `-`. */
export function parentIdOf(id: string, familyIds: Iterable<string>): string | null {
  const lower = id.toLowerCase()
  let best: string | null = null
  for (const family of familyIds) {
    const f = family.toLowerCase()
    if (f === lower || !lower.startsWith(f + '-')) continue
    if (!best || family.length > best.length) best = family
  }
  return best
}
