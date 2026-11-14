/**
 * The gallery's view as a URL (`/l/<id>?q=&kind=&in=&tag=&sort=`), so a view
 * can be linked, and a guard that drops a response older than the newest
 * request.
 */

export type GallerySort = 'relevance' | 'used' | 'newest'

export interface GalleryQuery {
  q: string
  kind: string
  /** a category path */
  in: string
  tag: string
  sort: GallerySort
}

export const EMPTY_QUERY: GalleryQuery = { q: '', kind: '', in: '', tag: '', sort: 'relevance' }

const SORTS: GallerySort[] = ['relevance', 'used', 'newest']

export function parseGalleryQuery(search: string): GalleryQuery {
  const p = new URLSearchParams(search)
  const sort = p.get('sort') as GallerySort | null
  return {
    q: p.get('q') ?? '',
    kind: p.get('kind') ?? '',
    in: p.get('in') ?? '',
    tag: p.get('tag') ?? '',
    sort: sort && SORTS.includes(sort) ? sort : 'relevance',
  }
}

/** The query string of a view; empty fields and the default sort left out. */
export function galleryQueryString(query: GalleryQuery, extra: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams()
  if (query.q) p.set('q', query.q)
  if (query.kind) p.set('kind', query.kind)
  if (query.in) p.set('in', query.in)
  if (query.tag) p.set('tag', query.tag)
  if (query.sort !== 'relevance') p.set('sort', query.sort)
  for (const [key, value] of Object.entries(extra)) if (value) p.set(key, value)
  const text = p.toString()
  return text ? `?${text}` : ''
}

/** Numbers each request; only the newest one's answer is current. */
export function staleGuard() {
  let latest = 0
  return {
    next: () => ++latest,
    isCurrent: (token: number) => token === latest,
  }
}
