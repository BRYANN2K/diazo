/**
 * Where a library item came from, and how an import knows "we already have
 * it". Provenance lives in the frame HTML, so the rebuildable index can read
 * it back: the page a website import captured (its `doop-import-source`
 * meta, or an explicit `data-doop-source-url`), and the frame a copy was
 * taken from (`data-doop-origin="<canvasId>:<frameId>"`, written by every
 * import and curation copy, the first one kept along a chain of copies).
 * Spec: .workflow/specs/design-libraries.md, "Duplicates on import".
 */

export const ORIGIN_ATTR = 'data-doop-origin'
export const SOURCE_URL_ATTR = 'data-doop-source-url'

/** Why an import was stopped: the same page, the same design, or one very like it. */
export type DuplicateReason = 'same-url' | 'same-content' | 'similar'

/** An item an import would duplicate, in any library the person can use. */
export interface DuplicateMatch {
  libraryId: string
  libraryName: string
  itemId: string
  name: string
  category: string
  reason: DuplicateReason
  /** 1 for an exact match; the text similarity (0.8 to 1) for `similar` */
  score: number
  /** the item's page in the gallery */
  url: string
}

/** Query parameters that only say where a visitor came from. */
const TRACKING =
  /^(utm_[a-z_]+|gclid|dclid|fbclid|msclkid|mc_[a-z]+|_ga|_gl|igshid|si|ref|ref_src|source|yclid|twclid)$/i

/**
 * A page address reduced to what names the page: host (lowercase, no
 * `www.`) and path (no trailing slash), with the query parameters that are
 * not tracking kept in order, and no scheme or fragment. http and https
 * of one page are the same page. Null when it is not an http(s) URL.
 */
export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : ''
  const path = url.pathname.replace(/\/+$/, '').replace(/\/{2,}/g, '/') || ''
  const kept = [...url.searchParams].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b))
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : ''
  return `${host}${port}${path}${query}`
}

/** The page a website import captured, from its meta tag. */
export function importSourceOf(html: string): string | null {
  const encoded = /<meta\s+name=["']doop-import-source["']\s+content=["']([^"']+)["']/i.exec(html)?.[1]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function attrOnBody(html: string, name: string): string | null {
  const body = /<body\b[^>]*>/i.exec(html)?.[0] ?? ''
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(body)
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null
}

/** The normalised page a frame was captured from, if it says. */
export function sourceKeyOf(html: string): string | null {
  return normalizeSourceUrl(attrOnBody(html, SOURCE_URL_ATTR) ?? importSourceOf(html))
}

/** The frame a copy was first taken from, if it says. */
export function originOf(html: string): string | null {
  const origin = attrOnBody(html, ORIGIN_ATTR)
  return origin && /^[\w-]+:[\w-]+$/.test(origin) ? origin : null
}

/** Mark a copy with where it came from (an existing mark is kept: the first origin wins). */
export function withOrigin(html: string, origin: string): string {
  if (originOf(html)) return html
  if (!/<body\b/i.test(html)) return html
  return html.replace(/<body\b/i, `<body ${ORIGIN_ATTR}="${origin.replace(/"/g, '')}"`)
}

/* ---- near duplicates ---- */

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'your', 'you', 'is', 'it'])

/** The words of a name and its text a near duplicate shares. */
export function wordsOf(name: string, text: string): Set<string> {
  return new Set(
    `${name} ${text.slice(0, 600)}`
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !STOP.has(w)),
  )
}

/** How alike two word sets are (Jaccard), 0 to 1; 0 when either is too
 *  short to say (fewer than six words). */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size < 6 || b.size < 6) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

/** At or above this, two items are `similar`. */
export const SIMILAR_AT = 0.8
