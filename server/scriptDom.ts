/**
 * server/scriptDom.ts — the pure-HTML half of the diazo SDK. Everything here
 * takes a frame's document in and returns data or a new document out; nothing
 * touches the store, the room or the clock. The dispatcher (scriptSdk.ts)
 * owns the writes these helpers prepare.
 */
import {
  attr,
  bodyOf,
  compileSelector,
  elementChildren,
  findElement,
  isElement,
  outerHtml,
  parseHtml,
  selectAll,
  walk,
  type Document,
  type Element,
} from './libraryDom.ts'
import type { DesignToken } from '../shared/designTokens.ts'

/* ---- the contract shapes (shared/scriptSdk.d.ts) ---- */

export interface OutlineNode {
  id?: string
  tag: string
  name?: string
  text?: string
  children?: OutlineNode[]
}

export interface FindHit {
  elementId?: string
  snippet: string
  offset: number
}

export type EditOp =
  | { op: 'replace'; find: string; replace: string }
  | { op: 'style'; element: string; property: string; value: string | null }
  | { op: 'attr'; element: string; name: string; value: string | null }
  | { op: 'text'; element: string; text: string }
  | { op: 'insert'; element: string; html: string; before?: string }
  | { op: 'remove'; element: string }

export interface EditOutcome {
  html: string
  applied: number
  failed: { index: number; reason: string }[]
}

export interface StyleBucket {
  value: string
  count: number
  token?: string
}

export interface StyleInventory {
  colors: StyleBucket[]
  radii: StyleBucket[]
  spacing: StyleBucket[]
  fontFamilies: StyleBucket[]
  fontSizes: StyleBucket[]
  tokenCoverage: number
}

export interface ReplaceOutcome {
  html: string
  count: number
  unmapped: { value: string; kind: string }[]
}

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript'])

/* ------------------------------------------------------------------ */
/* outline                                                             */
/* ------------------------------------------------------------------ */

function ownText(el: Element): string {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeName === '#text') text += (node as { value: string }).value
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function outlineNode(el: Element): OutlineNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null
  const node: OutlineNode = { tag: el.tagName }
  const id = attr(el, 'data-doop-id')
  if (id) node.id = id
  const role = attr(el, 'role') ?? attr(el, 'aria-label')
  if (role) node.name = role
  const text = ownText(el)
  if (text) node.text = text
  const children = elementChildren(el)
    .map(outlineNode)
    .filter((n): n is OutlineNode => n !== null)
  if (children.length) node.children = children
  return node
}

/** The element tree of a document, minus script/style noise. */
export function outline(html: string): OutlineNode {
  const doc = parseHtml(html)
  const body = bodyOf(doc)
  if (!body) return { tag: 'body' }
  return outlineNode(body) ?? { tag: 'body' }
}

/* ------------------------------------------------------------------ */
/* find                                                                */
/* ------------------------------------------------------------------ */

const SNIPPET = 120
const MAX_FIND_HITS = 40

function elementIdAt(doc: Document, offset: number): string | undefined {
  /* the smallest element whose source range covers the offset, then its
     nearest data-doop-id (self or ancestor) */
  let best: Element | undefined
  let bestSpan = Infinity
  for (const el of walk(doc)) {
    const loc = el.sourceCodeLocation
    if (!loc || loc.startOffset > offset || loc.endOffset <= offset) continue
    const span = loc.endOffset - loc.startOffset
    if (span < bestSpan) {
      best = el
      bestSpan = span
    }
  }
  for (let el = best; el;) {
    const id = attr(el, 'data-doop-id')
    if (id) return id
    const parent = el.parentNode
    el = parent && isElement(parent) ? parent : undefined
  }
  return undefined
}

/** The serialized element covering `offset` — the smallest one whose source
 *  range holds it. Null when nothing covers it. */
export function outerHtmlAt(html: string, offset: number): string | null {
  const doc = parseHtml(html)
  let best: Element | undefined
  let bestSpan = Infinity
  for (const el of walk(doc)) {
    const loc = el.sourceCodeLocation
    if (!loc || loc.startOffset > offset || loc.endOffset <= offset) continue
    const span = loc.endOffset - loc.startOffset
    if (span < bestSpan) {
      best = el
      bestSpan = span
    }
  }
  return best ? outerHtml(best) : null
}

/** Literal matches first; a `css:` prefix or selector-looking query runs the
 *  element selector engine instead. */
export function findInHtml(html: string, query: string): FindHit[] {
  const doc = parseHtml(html)
  const hits: FindHit[] = []
  const selectorQuery = query.startsWith('css:') ? query.slice(4) : null
  const selector = selectorQuery !== null ? compileSelector(selectorQuery) : null
  if (selector) {
    for (const el of selectAll(doc, selector).slice(0, MAX_FIND_HITS)) {
      hits.push({
        ...(attr(el, 'data-doop-id') ? { elementId: attr(el, 'data-doop-id')! } : {}),
        snippet: outerHtml(el).slice(0, SNIPPET),
        offset: el.sourceCodeLocation?.startOffset ?? 0,
      })
    }
    return hits
  }
  let at = 0
  while (hits.length < MAX_FIND_HITS) {
    const offset = html.indexOf(query, at)
    if (offset < 0) break
    hits.push({
      ...(elementIdAt(doc, offset) ? { elementId: elementIdAt(doc, offset)! } : {}),
      snippet: html
        .slice(Math.max(0, offset - 60), offset + query.length + 60)
        .replace(/\s+/g, ' ')
        .trim(),
      offset,
    })
    at = offset + query.length
  }
  return hits
}

/* ------------------------------------------------------------------ */
/* edit ops                                                            */
/* ------------------------------------------------------------------ */

function byDoopId(doc: Document, id: string): Element | undefined {
  return findElement(doc, (el) => attr(el, 'data-doop-id') === id)
}

/** Split a declaration list on its real `;` boundaries — semicolons inside
 *  `url(...)` (data URLs carry `;base64`) and quoted strings do not split. */
export function splitDecls(style: string): string[] {
  const decls: string[] = []
  let cur = ''
  let depth = 0
  let quote = ''
  for (const ch of style) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) {
      if (cur.trim()) decls.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) decls.push(cur.trim())
  return decls
}

function styleSet(el: Element, property: string, value: string | null): void {
  const name = property.trim().toLowerCase()
  if (!/^[-a-z]+$/.test(name)) throw new Error(`invalid property “${property}”`)
  const decls = splitDecls(attr(el, 'style') ?? '').filter((d) => !d.toLowerCase().startsWith(name + ':'))
  if (value !== null) decls.push(`${name}: ${value.trim().replace(/[;{}]/g, '')}`)
  setAttr(el, 'style', decls.length ? decls.join('; ') : null)
}

function setAttr(el: Element, name: string, value: string | null): void {
  const i = el.attrs.findIndex((a) => a.name === name)
  if (value === null) {
    if (i >= 0) el.attrs.splice(i, 1)
  } else if (i >= 0) el.attrs[i]!.value = value
  else el.attrs.push({ name, value })
}

/** Apply source splices in order. Untouched markup stays byte-identical. */
export function applyEditOps(source: string, ops: EditOp[]): EditOutcome {
  let html = source
  let applied = 0
  const failed: { index: number; reason: string }[] = []
  const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  for (const [index, op] of ops.entries()) {
    try {
      let start: number, end: number, replacement: string
      if (op.op === 'replace') {
        if (!op.find || html.indexOf(op.find) < 0 || html.indexOf(op.find, html.indexOf(op.find) + 1) >= 0)
          throw new Error('find must occur exactly once')
        start = html.indexOf(op.find)
        end = start + op.find.length
        replacement = op.replace
      } else {
        const doc = parseHtml(html)
        const el = op.element === '' && op.op === 'insert' ? bodyOf(doc) : byDoopId(doc, op.element)
        const loc = el?.sourceCodeLocation
        if (!el || !loc?.startTag) throw new Error(`no source element with data-doop-id “${op.element}”`)
        if (op.op === 'style' || op.op === 'attr') {
          const name = op.op === 'style' ? 'style' : op.name.toLowerCase()
          if (!/^[a-z_:][-a-z0-9_:.]*$/.test(name) || name.startsWith('data-doop-'))
            throw new Error('invalid or managed attribute')
          if (op.op === 'style') styleSet(el, op.property, op.value)
          else setAttr(el, name, op.value)
          const value = attr(el, name)
          const old = loc.attrs?.[name]
          if (!old) {
            /* a start tag that ends `/>` takes the new attribute before the
               slash — splicing between `/` and `>` corrupts it */
            const tagEnd = loc.startTag.endOffset
            start = end = html[tagEnd - 2] === '/' && html[tagEnd - 1] === '>' ? tagEnd - 2 : tagEnd - 1
          } else {
            start = old.startOffset
            end = old.endOffset
          }
          replacement = value === undefined || value === null ? '' : `${old ? '' : ' '}${name}="${escape(value)}"`
        } else if (op.op === 'text') {
          if (['script', 'style'].includes(el.tagName) || !loc.endTag) throw new Error('element does not take text')
          start = loc.startTag.endOffset
          end = loc.endTag.startOffset
          replacement = escape(op.text)
        } else if (op.op === 'remove') {
          start = loc.startOffset
          end = loc.endOffset
          replacement = ''
        } else {
          const before =
            op.before === undefined
              ? undefined
              : elementChildren(el).find((child) => attr(child, 'data-doop-id') === op.before)
          if (op.before !== undefined && !before) throw new Error('no matching child before insertion')
          const at = before?.sourceCodeLocation?.startOffset ?? loc.endTag?.startOffset
          if (at === undefined) throw new Error('element cannot contain markup')
          start = at
          end = at
          replacement = op.html
        }
      }
      html = html.slice(0, start) + replacement + html.slice(end)
      applied++
    } catch (error) {
      failed.push({ index, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { html, applied, failed }
}

/* ------------------------------------------------------------------ */
/* style inventory + token rewrite                                     */
/* ------------------------------------------------------------------ */

/* Values are inventoried inside style contexts only: style="" attributes,
   <style> bodies and SVG presentation attributes. Scanning the raw document
   reads &#8212; entities and href="#..." fragment ids as hex colours. */
const STYLE_CTX_RE = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'|<style[^>]*>([\s\S]*?)<\/style\s*>/gi
const PRESENTATION_RE = /\b(?:fill|stroke|color|stop-color|flood-color|lighting-color)\s*=\s*"([^"]*)"/gi

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g
const RADIUS_RE = /border(?:-top|-bottom|-left|-right)?(?:-start|-end)?-radius\s*:\s*([^;}]+)/g
const SPACING_RE =
  /(?:margin|padding|gap|inset|top|left|right|bottom|row-gap|column-gap)\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em|%)?)/g
const FAMILY_RE = /font-family\s*:\s*([^;}]+)/g
const SIZE_RE = /font-size\s*:\s*([^;}]+)/g
const VAR_RE = /var\(\s*(--[\w-]+)/g

function styleBodies(html: string): string[] {
  const bodies: string[] = []
  for (const m of html.matchAll(STYLE_CTX_RE)) bodies.push(m[1] ?? m[2] ?? m[3]!)
  for (const m of html.matchAll(PRESENTATION_RE)) bodies.push(m[1]!)
  return bodies
}

/** Colour literals inside one style body; `url(#id)` gradient refs are not. */
function colorLiterals(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(COLOR_RE)) {
    if (m[0].startsWith('#') && body[m.index! - 1] === '(') continue
    out.push(m[0].trim())
  }
  return out
}

function bucket(literals: string[], tokens: Map<string, string>): StyleBucket[] {
  const counts = new Map<string, number>()
  for (const lit of literals) counts.set(lit, (counts.get(lit) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([value, count]) => ({ value, count, ...(tokens.has(value) ? { token: tokens.get(value)! } : {}) }))
}

function tokenByValue(tokens: readonly DesignToken[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const token of tokens) if (!out.has(token.value)) out.set(token.value, token.name)
  return out
}

/** Literal design values in a document, with the token each maps to. */
export function styleInventory(html: string, tokens: readonly DesignToken[]): StyleInventory {
  const byValue = tokenByValue(tokens)
  const bodies = styleBodies(html)
  const pick = (re: RegExp) => bodies.flatMap((body) => [...body.matchAll(re)].map((m) => m[1]!.trim()))
  const colors = bodies.flatMap(colorLiterals)
  const radii = pick(RADIUS_RE)
  const spacing = pick(SPACING_RE)
  const fontFamilies = pick(FAMILY_RE)
  const fontSizes = pick(SIZE_RE)
  const varCount = bodies.reduce((n, body) => n + (body.match(VAR_RE) ?? []).length, 0)
  /* var() uses and literals of every kind, so both sides count the same thing */
  const literalCount = colors.length + radii.length + spacing.length + fontFamilies.length + fontSizes.length
  return {
    colors: bucket(colors, byValue),
    radii: bucket(radii, byValue),
    spacing: bucket(spacing, byValue),
    fontFamilies: bucket(fontFamilies, byValue),
    fontSizes: bucket(fontSizes, byValue),
    tokenCoverage: literalCount === 0 ? 1 : Math.max(0, Math.min(1, varCount / (varCount + literalCount))),
  }
}

/** The share of style literals already written as var(--x). */
export function tokenCoverage(html: string): number {
  return styleInventory(html, []).tokenCoverage
}

function rgbOf(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim())
  if (hex) {
    const h = hex[1]!
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value.trim())
  if (rgb) {
    const parts = rgb[1]!.split(',').map((p) => parseFloat(p))
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n)))
      return [parts[0]!, parts[1]!, parts[2]!]
  }
  return null
}

const COLOR_DISTANCE_MAX = 24 * 24 * 3

/** Which token type each `kinds` entry maps onto — a literal only ever
 *  resolves to a token of its own type, so a '16px' radius token never
 *  claims a font-size declaration. */
const KIND_TOKEN_TYPE: Record<string, DesignToken['type']> = {
  color: 'color',
  radius: 'radius',
  spacing: 'spacing',
  font: 'fontFamily',
  fontSize: 'fontSize',
}

/** Swap literal values for var(--token) wherever they appear in CSS
 *  declarations (style attributes and <style> blocks). */
export function replaceValues(
  html: string,
  tokens: readonly DesignToken[],
  input: { kinds: string[]; match?: 'exact' | 'nearest'; to?: string[] },
): ReplaceOutcome {
  const allowed = input.to?.length ? new Set(input.to) : null
  const pool = tokens.filter((t) => !allowed || allowed.has(t.name))
  let count = 0
  const unmapped = new Map<string, string>()
  const swap = (value: string, kind: string): string => {
    if (value.startsWith('var(') || value.includes(' URL')) return value
    const typed = pool.filter((t) => t.type === KIND_TOKEN_TYPE[kind])
    const exact = typed.find((t) => t.value === value)
    let name = exact?.name
    if (!name && input.match === 'nearest' && kind === 'color') {
      const rgb = rgbOf(value)
      if (rgb) {
        let best: { name: string; d: number } | null = null
        for (const token of typed) {
          const trgb = rgbOf(token.value)
          if (!trgb) continue
          const d = trgb.reduce((sum, c, i) => sum + (c - rgb[i]!) ** 2, 0)
          if (d <= COLOR_DISTANCE_MAX && (!best || d < best.d)) best = { name: token.name, d }
        }
        name = best?.name
      }
    }
    if (!name) {
      unmapped.set(value, kind)
      return value
    }
    count++
    return `var(--${name.replace(/^--/, '')})`
  }
  /* url(...) contents are opaque to value matching — a data URL's inner
     markup is not a declaration value and must never be rewritten */
  const swapCss = (css: string) => {
    const urls: string[] = []
    let out = css.replace(/url\([^)]*\)/gi, (m) => {
      urls.push(m)
      return ` URL${urls.length - 1} `
    })
    const unmask = (s: string) => s.replace(/ URL(\d+) /g, (_m, i: string) => urls[Number(i)]!)
    if (input.kinds.includes('color')) {
      out = out.replace(
        /((?:color|background|border|fill|stroke|outline|box-shadow|text-shadow)\s*:\s*)([^;}]+)/g,
        (_m, decl: string, value: string) => decl + value.replace(COLOR_RE, (lit) => swap(lit.trim(), 'color')),
      )
    }
    if (input.kinds.includes('radius')) {
      out = out.replace(RADIUS_RE, (m, value: string) => m.replace(value, swap(value, 'radius')))
    }
    if (input.kinds.includes('spacing')) {
      out = out.replace(SPACING_RE, (m, value: string) => m.replace(value, swap(value, 'spacing')))
    }
    if (input.kinds.includes('font')) {
      out = out.replace(FAMILY_RE, (m, value: string) => m.replace(value, swap(value, 'font')))
    }
    if (input.kinds.includes('fontSize')) {
      out = out.replace(SIZE_RE, (m, value: string) => m.replace(value, swap(value, 'fontSize')))
    }
    return unmask(out)
  }
  const out = html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a: string, css: string, b: string) => a + swapCss(css) + b)
    .replace(
      /(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi,
      (_m, prefix: string, quote: string, css: string) => prefix + quote + swapCss(css) + quote,
    )
  return { html: out, count, unmapped: [...unmapped.entries()].map(([value, kind]) => ({ value, kind })) }
}

/* ------------------------------------------------------------------ */
/* stream sections                                                     */
/* ------------------------------------------------------------------ */

/** Split a whole document into streamable chunks: everything up to the
 *  body's first element (head, styles, the body tag itself) first, then one
 *  top-level element each, then the tail. The chunks concatenate back to
 *  the source exactly, and each boundary is a whole section. */
export function streamSections(html: string): string[] {
  const doc = parseHtml(html)
  const body = bodyOf(doc)
  if (!body?.sourceCodeLocation) return [html]
  const chunks: string[] = []
  const top = elementChildren(body)
  let at = 0
  for (const el of top) {
    const loc = el.sourceCodeLocation
    if (!loc) continue
    if (loc.startOffset > at) chunks.push(html.slice(at, loc.startOffset))
    chunks.push(html.slice(loc.startOffset, loc.endOffset))
    at = loc.endOffset
  }
  if (at < html.length) chunks.push(html.slice(at))
  const merged: string[] = []
  for (const chunk of chunks) {
    if (
      merged.length &&
      merged[merged.length - 1]!.length + chunk.length < 4096 &&
      !/^<(section|header|footer|main|nav|article|aside)/i.test(chunk.trim())
    ) {
      merged[merged.length - 1] = merged[merged.length - 1]! + chunk
    } else {
      merged.push(chunk)
    }
  }
  return merged.filter((c) => c.trim().length > 0)
}
