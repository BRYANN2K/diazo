/**
 * The parse5 helpers the library extractor and import share: walking a
 * document without recursion, reading text and attributes, and a small
 * selector engine for the selectors a library's rules carry (tag, `*`,
 * `#id`, `.class`, `[attr]`, `[attr="v"]`, descendant and `>` combinators,
 * comma lists). Rules hold untrusted selectors: anything outside that
 * grammar compiles to null and matches nothing.
 */
import { parse, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { MAX_SELECTOR } from '../shared/libraryRules.ts'

export type Element = Tree.Element
export type Node = Tree.ChildNode
export type ParentNode = Tree.ParentNode
export type Document = Tree.Document

export function parseHtml(html: string): Document {
  return parse(html, { sourceCodeLocationInfo: true })
}

export function isElement(node: Node | ParentNode): node is Element {
  return 'tagName' in node
}

export function elementChildren(node: ParentNode): Element[] {
  return node.childNodes.filter(isElement)
}

export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

export function classes(el: Element): string[] {
  return (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean)
}

/** Every element below `node`, in document order, without recursion. */
export function* walk(node: ParentNode): Generator<Element> {
  const stack: Element[] = elementChildren(node).reverse()
  for (let next = stack.pop(); next; next = stack.pop()) {
    yield next
    const kids = next.tagName === 'template' ? [] : elementChildren(next)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
  }
}

export function findElement(node: ParentNode, test: (el: Element) => boolean): Element | undefined {
  for (const el of walk(node)) if (test(el)) return el
  return undefined
}

export function bodyOf(doc: Document): Element | undefined {
  return findElement(doc, (el) => el.tagName === 'body')
}

const SKIP_TEXT = new Set(['script', 'style', 'template', 'noscript'])

/** The text a person reads in `node`, whitespace squashed. Iterative. */
export function itemText(node: ParentNode, skip?: (el: Element) => boolean): string {
  const parts: string[] = []
  const stack: Node[] = [...node.childNodes].reverse()
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next.nodeName === '#text') {
      parts.push((next as Tree.TextNode).value)
      continue
    }
    if (!isElement(next)) continue
    if (SKIP_TEXT.has(next.tagName) || skip?.(next)) continue
    parts.push(' ')
    for (let i = next.childNodes.length - 1; i >= 0; i--) stack.push(next.childNodes[i]!)
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

export function outerHtml(el: Element): string {
  return serializeOuter(el)
}

export function contains(ancestor: Element, el: Element): boolean {
  for (let p: ParentNode | null = el; p; p = isElement(p) ? p.parentNode : null) if (p === ancestor) return true
  return false
}

/* ---- selectors ---- */

interface Compound {
  tag: string | null
  id: string | null
  classes: string[]
  attrs: { name: string; value: string | null }[]
}

interface Complex {
  /** right to left: the subject first */
  parts: Compound[]
  /** combinator between parts[i] and parts[i + 1] */
  combinators: ('>' | ' ')[]
}

export type Selector = Complex[]

const IDENT = '[A-Za-z_-][\\w-]*'
const COMPOUND = new RegExp(
  `^(\\*|${IDENT})?((?:#${IDENT}|\\.${IDENT}|\\[${IDENT}(?:=(?:"[^"]*"|'[^']*'|[\\w-]+))?\\])*)$`,
)
const SIMPLE = new RegExp(`#(${IDENT})|\\.(${IDENT})|\\[(${IDENT})(?:=(?:"([^"]*)"|'([^']*)'|([\\w-]+)))?\\]`, 'g')

function compileCompound(text: string): Compound | null {
  const m = COMPOUND.exec(text)
  if (!m || !text) return null
  const compound: Compound = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] }
  for (const s of (m[2] ?? '').matchAll(SIMPLE)) {
    if (s[1]) compound.id = s[1]
    else if (s[2]) compound.classes.push(s[2])
    else if (s[3]) compound.attrs.push({ name: s[3].toLowerCase(), value: s[4] ?? s[5] ?? s[6] ?? null })
  }
  return compound
}

/** Compile a rule's selector, or null when it is outside the grammar. */
export function compileSelector(selector: string): Selector | null {
  if (!selector.trim() || selector.length > MAX_SELECTOR) return null
  const out: Selector = []
  for (const piece of selector.split(',')) {
    const tokens = piece
      .trim()
      .replace(/\s*>\s*/g, ' > ')
      .split(/\s+/)
      .filter(Boolean)
    const parts: Compound[] = []
    const combinators: ('>' | ' ')[] = []
    let pending: '>' | ' ' = ' '
    for (const token of tokens) {
      if (token === '>') {
        if (!parts.length || pending === '>') return null
        pending = '>'
        continue
      }
      const compound = compileCompound(token)
      if (!compound) return null
      if (parts.length) combinators.push(pending)
      parts.push(compound)
      pending = ' '
    }
    if (!parts.length || pending === '>') return null
    out.push({ parts: parts.reverse(), combinators: combinators.reverse() })
  }
  return out
}

function matchesCompound(el: Element, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false
  if (c.id && attr(el, 'id') !== c.id) return false
  if (c.classes.length) {
    const own = classes(el)
    if (!c.classes.every((cls) => own.includes(cls))) return false
  }
  for (const a of c.attrs) {
    const v = attr(el, a.name)
    if (v === undefined || (a.value !== null && v !== a.value)) return false
  }
  return true
}

function parentElement(el: Element, within?: Element): Element | null {
  if (el === within) return null
  const p = el.parentNode
  return p && isElement(p) ? p : null
}

function matchesComplex(el: Element, sel: Complex, within?: Element): boolean {
  if (!matchesCompound(el, sel.parts[0]!)) return false
  let current: Element | null = el
  for (let i = 1; i < sel.parts.length; i++) {
    const comb = sel.combinators[i - 1]
    const part = sel.parts[i]!
    if (comb === '>') {
      current = current ? parentElement(current, within) : null
      if (!current || !matchesCompound(current, part)) return false
    } else {
      let up: Element | null = current ? parentElement(current, within) : null
      while (up && !matchesCompound(up, part)) up = parentElement(up, within)
      if (!up) return false
      current = up
    }
  }
  return true
}

export function matches(el: Element, selector: Selector, within?: Element): boolean {
  return selector.some((complex) => matchesComplex(el, complex, within))
}

/** The elements under `root` matching `selector`, in document order. A
 *  selector is matched as if `root` were the top: `.m b` inside a cell does
 *  not see the cell's ancestors. */
export function selectAll(root: ParentNode, selector: Selector | null): Element[] {
  if (!selector) return []
  const within = isElement(root) ? root : undefined
  const out: Element[] = []
  for (const el of walk(root)) if (matches(el, selector, within)) out.push(el)
  return out
}

export function selectOne(root: ParentNode, selector: Selector | null): Element | undefined {
  return selectAll(root, selector)[0]
}
