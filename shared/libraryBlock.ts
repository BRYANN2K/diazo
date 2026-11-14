/**
 * The block an insert writes into a frame: the item's markup inside its
 * ancestors (as `display: contents` boxes, so its descendant selectors still
 * match), in a wrapper carrying where it came from, with its CSS scoped to
 * that wrapper and the SVG definitions it points at beside it. One function
 * for the browser insert (src/lib/findInsert.ts) and the server's
 * (server/librarySnapshot.ts), so the two cannot drift.
 */
import type { LibrarySnapshot } from './librarySnapshot.ts'

/** The attribute that keeps an inserted block's provenance (`cp.x`). */
export const REF_ATTR = 'data-doop-ref'
/** The library canvas the block came from. */
export const REF_LIB_ATTR = 'data-doop-ref-lib'
/** The item's revision when it was inserted: lower than the item's is stale. */
export const REF_REV_ATTR = 'data-doop-ref-rev'

/** A reference id safe inside an attribute selector. */
export function refId(id: string): string {
  return id.replace(/[^\w.-]/g, '-').slice(0, 120) || 'library-item'
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const attrsHtml = (attrs: [string, string][]) =>
  attrs
    .filter(([name]) => /^[a-z][\w:-]*$/i.test(name))
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('')

export interface BlockOptions {
  ref: string
  libraryId?: string
  rev?: number
  /** prepended to every id the definitions declare, so two inserts of the
   *  same item do not clash; a fresh one per insert */
  prefix?: string
}

/** The ids a set of definitions declares. */
function declaredIds(defs: string[]): string[] {
  const ids: string[] = []
  for (const def of defs) for (const m of def.matchAll(/\sid\s*=\s*["']([\w:.-]+)["']/g)) if (m[1]) ids.push(m[1])
  return [...new Set(ids)]
}

/** Point `href="#x"`, `xlink:href="#x"`, `url(#x)` and `id="x"` at the prefixed ids. */
function renameIds(text: string, ids: Set<string>, prefix: string): string {
  if (!ids.size) return text
  return text
    .replace(/((?:xlink:)?href\s*=\s*["']#)([\w:.-]+)(["'])/g, (whole, a: string, id: string, b: string) =>
      ids.has(id) ? `${a}${prefix}${id}${b}` : whole,
    )
    .replace(/(url\(\s*["']?#)([\w:.-]+)/g, (whole, a: string, id: string) =>
      ids.has(id) ? `${a}${prefix}${id}` : whole,
    )
    .replace(/(\sid\s*=\s*["'])([\w:.-]+)(["'])/g, (whole, a: string, id: string, b: string) =>
      ids.has(id) ? `${a}${prefix}${id}${b}` : whole,
    )
}

/** The block for `snap`, carrying its reference, library and revision. */
export function libraryBlock(snap: LibrarySnapshot, options: BlockOptions | string): string {
  const opts: BlockOptions = typeof options === 'string' ? { ref: options } : options
  const ref = opts.ref
  const scope = `[${REF_ATTR}="${ref}"]`
  const defs = snap.defs ?? []
  const ids = new Set(declaredIds(defs))
  const prefix = opts.prefix ?? ''
  const rename = (text: string) => (prefix ? renameIds(text, ids, prefix) : text)
  const own = [...snap.vars, ...snap.inherited].map(([p, v]) => `${p}: ${v};`).join(' ')
  const css = rename(
    [`@scope (${scope}) {`, own ? `:scope { ${own} }` : '', ...snap.rules, '}', ...snap.keyframes, ...snap.fontFaces]
      .filter(Boolean)
      .join('\n'),
  )
  let inner = rename(snap.html)
  for (const a of [...snap.ancestors].reverse()) {
    if (!/^[a-z][\w-]*$/i.test(a.tag)) continue
    inner = `<${a.tag}${attrsHtml(a.attrs)} style="display: contents">${inner}</${a.tag}>`
  }
  const classes = snap.rootClasses.filter((c) => /^[\w-]+$/.test(c)).join(' ')
  const wrapperAttrs: [string, string][] = [
    [REF_ATTR, ref],
    ...(opts.libraryId ? ([[REF_LIB_ATTR, opts.libraryId]] as [string, string][]) : []),
    ...(opts.rev !== undefined ? ([[REF_REV_ATTR, String(opts.rev)]] as [string, string][]) : []),
    ['data-doop-name', ref],
    ...(classes ? ([['class', classes]] as [string, string][]) : []),
    ...snap.rootAttrs.filter(([name]) => name !== REF_ATTR && !name.startsWith('data-doop-')),
  ]
  const defsSvg = defs.length
    ? `<svg width="0" height="0" aria-hidden="true" style="position: absolute">${rename(defs.join(''))}</svg>`
    : ''
  return `<div${attrsHtml(wrapperAttrs)}><style data-doop-ref-style>${css.replace(/<\/style/gi, '<\\/style')}</style>${defsSvg}${inner}</div>`
}
