/**
 * server/scriptDom.ts — the pure-HTML half of the diazo SDK. Everything here
 * takes a frame's document in and returns data or a new document out; nothing
 * touches the store, the room or the clock. The dispatcher (scriptSdk.ts)
 * owns the writes these helpers prepare.
 */
import { serialize } from 'parse5'
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

function styleSet(el: Element, property: string, value: string | null): void {
  const name = property.trim().toLowerCase()
  if (!/^[-a-z]+$/.test(name)) throw new Error(`invalid property “${property}”`)
  const decls = (attr(el, 'style') ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => !d.toLowerCase().startsWith(name + ':'))
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

const NO_TEXT = new Set(['script', 'style'])

function applyOpsOnDoc(doc: Document, html: string, ops: EditOp[]): EditOutcome {
  const failed: { index: number; reason: string }[] = []
  let applied = 0
  let dirty = false
  ops.forEach((op, index) => {
    try {
      if (op.op === 'replace') {
        const first = html.indexOf(op.find)
        if (first < 0 || html.indexOf(op.find, first + 1) >= 0) {
          failed.push({ index, reason: 'find must occur exactly once' })
          return
        }
        html = html.slice(0, first) + op.replace + html.slice(first + op.find.length)
        applied++
        return
      }
      /* an empty element id targets <body> — insert's append shortcut */
      const el = op.element === '' && op.op === 'insert' ? bodyOf(doc) : byDoopId(doc, op.element)
      if (!el) {
        failed.push({ index, reason: `no element with data-doop-id “${op.element}”` })
        return
      }
      switch (op.op) {
        case 'style':
          styleSet(el, op.property, op.value)
          break
        case 'attr':
          if (op.name.startsWith('data-doop-')) {
            failed.push({ index, reason: 'data-doop-* attributes are managed by the canvas' })
            return
          }
          setAttr(el, op.name, op.value)
          break
        case 'text':
          if (NO_TEXT.has(el.tagName)) {
            failed.push({ index, reason: `<${el.tagName}> does not take text` })
            return
          }
          el.childNodes = [{ nodeName: '#text', value: op.text, parentNode: el } as never]
          break
        case 'insert': {
          const frag = parseHtml(`<body>${op.html}</body>`)
          const pieces = elementChildren(bodyOf(frag)!)
          if (!pieces.length) {
            failed.push({ index, reason: 'the markup holds no element' })
            return
          }
          let at = el.childNodes.length
          if (op.before !== undefined) {
            const idx = el.childNodes.findIndex((n) => isElement(n) && attr(n, 'data-doop-id') === op.before)
            if (idx < 0) {
              failed.push({ index, reason: `no child with data-doop-id “${op.before}”` })
              return
            }
            at = idx
          }
          for (const piece of pieces) (piece as unknown as { parentNode: Element }).parentNode = el
          el.childNodes.splice(at, 0, ...pieces)
          break
        }
        case 'remove': {
          const parent = el.parentNode
          if (!parent || !('childNodes' in parent)) {
            failed.push({ index, reason: 'the element has no parent' })
            return
          }
          const i = parent.childNodes.indexOf(el)
          if (i >= 0) parent.childNodes.splice(i, 1)
          break
        }
      }
      dirty = true
      applied++
    } catch (error) {
      failed.push({ index, reason: error instanceof Error ? error.message : String(error) })
    }
  })
  return { html: dirty ? serialize(doc) : html, applied, failed }
}

/** A batched frame edit. A `replace` op re-parses the document for the
 *  element ops that follow it. */
export function applyEditOps(source: string, ops: EditOp[]): EditOutcome {
  let html = source
  let doc = parseHtml(source)
  let applied = 0
  const failed: { index: number; reason: string }[] = []
  /* run the batch in order; a string replace invalidates the parsed tree */
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.op === 'replace') {
      const one = applyOpsOnDoc(doc, html, [op])
      html = one.html
      applied += one.applied
      failed.push(...one.failed.map((f) => ({ index: i, reason: f.reason })))
      if (one.applied) doc = parseHtml(html)
      continue
    }
    /* run the longest run of element ops on the same parse */
    const batch: EditOp[] = []
    while (i < ops.length && ops[i]!.op !== 'replace') {
      batch.push(ops[i]!)
      i++
    }
    i--
    const result = applyOpsOnDoc(doc, html, batch)
    html = result.html
    applied += result.applied
    failed.push(...result.failed.map((f) => ({ index: ops.indexOf(batch[f.index]!), reason: f.reason })))
    if (result.applied) doc = parseHtml(html)
  }
  return { html, applied, failed: failed.sort((a, b) => a.index - b.index) }
}

/* ------------------------------------------------------------------ */
/* style inventory + token rewrite                                     */
/* ------------------------------------------------------------------ */

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g
const RADIUS_RE = /border(?:-top|-bottom|-left|-right)?(?:-start|-end)?-radius\s*:\s*([^;}]+)/g
const SPACING_RE =
  /(?:margin|padding|gap|inset|top|left|right|bottom|row-gap|column-gap)\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em|%)?)/g
const FAMILY_RE = /font-family\s*:\s*([^;}]+)/g
const SIZE_RE = /font-size\s*:\s*([^;}]+)/g
const VAR_RE = /var\(\s*(--[\w-]+)/g

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
  const colors = (html.match(COLOR_RE) ?? []).map((m) => m.trim())
  const pick = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]!.trim())
  const varCount = (html.match(VAR_RE) ?? []).length
  const literalCount = colors.length
  return {
    colors: bucket(colors, byValue),
    radii: bucket(pick(RADIUS_RE), byValue),
    spacing: bucket(pick(SPACING_RE), byValue),
    fontFamilies: bucket(pick(FAMILY_RE), byValue),
    fontSizes: bucket(pick(SIZE_RE), byValue),
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
    if (value.startsWith('var(')) return value
    const exact = pool.find((t) => t.value === value)
    let name = exact?.name
    if (!name && input.match === 'nearest' && kind === 'color') {
      const rgb = rgbOf(value)
      if (rgb) {
        let best: { name: string; d: number } | null = null
        for (const token of pool) {
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
  let out = html
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
