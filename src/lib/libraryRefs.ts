/**
 * Blocks inserted from a library carry where they came from
 * (`data-doop-ref`, `-ref-lib`, `-ref-rev`). These helpers read them from a
 * frame and tell which are behind their item. A block without a revision
 * (one inserted before revisions existed) is never stale.
 */

export interface LibraryRef {
  /** the block's own data-doop-id */
  elementId: string
  /** the item id */
  ref: string
  libraryId: string
  rev: number | null
}

const ATTR = (name: string, tag: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return m ? m[1]! : null
}

/** Every library block in a frame's html, nested ones included. */
export function refsIn(html: string): LibraryRef[] {
  const out: LibraryRef[] = []
  for (const m of html.matchAll(/<[a-z][^>]*\sdata-doop-ref-lib\s*=\s*"[^"]*"[^>]*>/gi)) {
    const tag = m[0]
    const ref = ATTR('data-doop-ref', tag)
    const libraryId = ATTR('data-doop-ref-lib', tag)
    if (!ref || !libraryId) continue
    const rev = ATTR('data-doop-ref-rev', tag)
    out.push({
      elementId: ATTR('data-doop-id', tag) ?? '',
      ref,
      libraryId,
      rev: rev !== null && /^\d+$/.test(rev) ? Number(rev) : null,
    })
  }
  return out
}

export const revKey = (libraryId: string, itemId: string) => `${libraryId}\n${itemId}`

/** The blocks whose item has moved on since they were inserted. */
export function staleRefs(refs: LibraryRef[], revs: ReadonlyMap<string, number>): LibraryRef[] {
  return refs.filter((r) => {
    if (r.rev === null) return false
    const current = revs.get(revKey(r.libraryId, r.ref))
    return current !== undefined && current > r.rev
  })
}

/** Put `block` in place of the element carrying `elementId`, keeping its
 *  place and the block's id; null when the element is gone. */
export function replaceBlock(html: string, elementId: string, block: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const el = doc.querySelector(`[data-doop-id="${CSS.escape(elementId)}"]`)
  if (!el) return null
  const tpl = doc.createElement('template')
  tpl.innerHTML = block
  const fresh = tpl.content.firstElementChild
  if (!fresh) return null
  fresh.setAttribute('data-doop-id', elementId)
  el.replaceWith(fresh)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}
