/**
 * The static extractor: one frame's HTML and its library's rules in, the
 * items it holds out (a family and its variants, or one whole-frame item).
 * No browser and no store: pure over its arguments. A scripted sheet only
 * yields its family here; its variants come from the rendered pass.
 * Spec: .context/specs/design-libraries.md, "How frames map to items".
 */
import { createHash } from 'node:crypto'
import type { LibraryItem, LibraryTaxonomy, RuleFinding } from '../shared/library.ts'
import { UNSORTED } from '../shared/library.ts'
import { assignItemId, isItemId, itemSlug, parseItemId, splitFrameName } from '../shared/libraryIds.ts'
import {
  isIgnoredName,
  sectionCategory as readSection,
  tidyCategoryPart,
  type LibraryRules,
} from '../shared/libraryRules.ts'
import type { Frame } from '../shared/types.ts'
import { ELEMENT_ID_ATTR } from '../shared/elementId.ts'
import {
  attr,
  bodyOf,
  classes,
  compileSelector,
  contains,
  elementChildren,
  findElement,
  isElement,
  itemText,
  outerHtml,
  parseHtml,
  selectAll,
  selectOne,
  walk,
  type Document,
  type Element,
} from './libraryDom.ts'

/** What the extractor knows of an item; the indexer adds the library's
 *  canvas, the revision and the time. */
export type ExtractedItem = Omit<LibraryItem, 'canvasId' | 'rev' | 'indexedAt' | 'useCount'>

export interface ExtractResult {
  items: ExtractedItem[]
  /** the frame runs scripts: what they build is read by the rendered pass */
  scripted: boolean
  /** the name says this frame is not an item */
  ignored: boolean
  /** a section frame: the category it starts for the frames below it */
  section?: string
}

export interface ExtractInput {
  frame: Pick<Frame, 'id' | 'name' | 'html'> & { pageId?: string }
  pageName: string
  /** the category the last section frame above this one started */
  sectionCategory: string | null
  rules: LibraryRules
  taxonomy: LibraryTaxonomy
}

const MAX_TEXT = 2000
const MAX_TAGS = 12

export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** `shadcnblocks · Login (4)` → `shadcnblocks · Login`: the count is not the name. */
function cleanLabel(label: string): string {
  return label.replace(/\s*\(\d+\)\s*$/, '').trim()
}

/** `013 Inputs & forms · Checkboxes… — title` → `Inputs & forms`;
 *  `00 · Index` → `Index`; `01 Heroes · AI products · A–L` → `Heroes`. */
export function pageCategory(pageName: string): string | null {
  const name = pageName
    .replace(/\s+—\s+title$/i, '')
    .replace(/^\d+[\s.·-]*/, '')
    .split(' · ')
    .map(tidyCategoryPart)
    .find(Boolean)
  return name || null
}

function tagsOf(el: Element | undefined): string[] | null {
  const raw = el && attr(el, 'data-doop-tags')
  if (raw === undefined || raw === null) return null
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS)
}

const LICENSE =
  /^(mit|apache[- ]?2(\.0)?|bsd[\w-]*|isc|mpl[\w.-]*|gpl[\w.-]*|lgpl[\w.-]*|cc[\w. -]*|unlicense|proprietary|paid|commercial)$/i
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)$/i

/** A sheet's source line (`3 items · tuffui.com/r · MIT`): its URL and licence. */
export function sourceLine(doc: Document): { sourceUrl: string | null; license: string | null } {
  const header = findElement(doc, (el) => el.tagName === 'header' || classes(el).includes('hd'))
  const scope = header ?? bodyOf(doc)
  if (!scope) return { sourceUrl: null, license: null }
  for (const el of walk(scope)) {
    if (elementChildren(el).length) continue
    const text = itemText(el)
    if (!text.includes(' · ') || text.length > 200) continue
    const parts = text.split(' · ').map((p) => p.trim())
    const at = parts.findIndex((p) => DOMAIN.test(p))
    if (at < 0) continue
    const host = DOMAIN.exec(parts[at]!)![1]!
    const next = parts[at + 1]
    return { sourceUrl: `https://${host}`, license: next && LICENSE.test(next) ? next : null }
  }
  return { sourceUrl: null, license: null }
}

/** A cell of a sheet: the box that is one variant. */
interface Cell {
  cell: Element
  id: string
  label: string
  design: Element
}

/** The elements whose whole text is one item id (with a kind): `<b>cp.x</b>`.
 *  Read from the text nodes, so the element is the innermost one. */
function idElements(doc: Document, familyId: string | null): { el: Element; id: string }[] {
  const out: { el: Element; id: string }[] = []
  const body = bodyOf(doc)
  if (!body) return out
  for (const el of walk(body)) {
    if (SKIP_IDS.has(el.tagName)) continue
    for (const node of el.childNodes) {
      if (node.nodeName !== '#text') continue
      const text = (node as { value: string }).value.trim()
      if (!text || text.length > 120 || !text.includes('.') || !isItemId(text)) continue
      if (familyId && text.toLowerCase() === familyId.toLowerCase()) continue
      if (itemText(el) !== text) continue
      out.push({ el, id: text })
    }
  }
  return out
}

const SKIP_IDS = new Set(['script', 'style', 'svg', 'template'])

function idLabel(holder: Element | null | undefined, id: string): string {
  if (!holder) return ''
  return itemText(holder)
    .replace(id, '')
    .replace(/^[\s·—–:-]+|[\s·—–:-]+$/g, '')
    .trim()
}

/** The largest child of a cell that does not hold its id: the design. */
function designOf(cell: Element, idEl: Element): Element {
  const candidates = elementChildren(cell).filter((child) => !contains(child, idEl))
  if (!candidates.length) return cell
  return candidates.reduce((best, el) => (outerHtml(el).length > outerHtml(best).length ? el : best))
}

/** `auto`: repeated sibling blocks that each hold exactly one id. */
export function autoCells(doc: Document, familyId: string | null): Cell[] {
  const found = idElements(doc, familyId)
  /* how many ids each ancestor holds */
  const held = new Map<Element, number>()
  const parentOf = (el: Element) => (el.parentNode && isElement(el.parentNode) ? el.parentNode : null)
  for (const { el } of found) {
    for (let p: Element | null = el; p; p = parentOf(p)) held.set(p, (held.get(p) ?? 0) + 1)
  }
  const cells: Cell[] = []
  const seen = new Set<Element>()
  for (const { el, id } of found) {
    /* the lowest ancestor holding another id is the grid; the cell is its child on the way */
    let child: Element = el
    let parent = parentOf(el)
    while (parent && (held.get(parent) ?? 0) < 2) {
      child = parent
      parent = parentOf(parent)
    }
    if (!parent || parent.tagName === 'html' || seen.has(child) || held.get(child) !== 1) continue
    seen.add(child)
    cells.push({ cell: child, id, label: idLabel(parentOf(el) ?? el, id), design: designOf(child, el) })
  }
  return cells
}

/** `selectors`: the cells, ids, labels and designs the rules name. */
export function findCells(doc: Document, rules: LibraryRules, familyId: string | null): Cell[] {
  const v = rules.detect.variants
  if (v.mode === 'none') return []
  if (v.mode === 'auto') return autoCells(doc, familyId)
  const cellSel = compileSelector(v.cell ?? '')
  const idSel = compileSelector(v.id ?? '')
  const labelSel = v.label ? compileSelector(v.label) : null
  const designSel = v.design ? compileSelector(v.design) : null
  const cells: Cell[] = []
  for (const cell of selectAll(doc, cellSel)) {
    const idEl = selectOne(cell, idSel)
    const id = idEl ? itemText(idEl) : ''
    if (!idEl || !isItemId(id)) continue
    const labelEl = labelSel ? selectOne(cell, labelSel) : null
    const label = labelEl
      ? itemText(labelEl)
      : idLabel(idEl.parentNode && isElement(idEl.parentNode) ? idEl.parentNode : idEl, id)
    cells.push({ cell, id, label, design: (designSel && selectOne(cell, designSel)) || designOf(cell, idEl) })
  }
  return cells
}

function hasScripts(doc: Document): boolean {
  return !!findElement(
    doc,
    (el) => el.tagName === 'script' && (!!attr(el, 'src') || itemText(el) !== '' || el.childNodes.length > 0),
  )
}

function locatorOf(el: Element, id: string): ExtractedItem['locator'] {
  const elementId = attr(el, ELEMENT_ID_ATTR)
  return elementId ? { elementId } : { anchor: id }
}

/** Categories in the order the rules ask; the first that answers wins. */
function categorise(
  rules: LibraryRules,
  input: { marker: string | null; section: string | null; page: string | null; kind: string },
): string {
  for (const by of rules.categorise.by) {
    const value =
      by === 'marker'
        ? input.marker
        : by === 'section'
          ? input.section
          : by === 'page'
            ? input.page
            : (rules.categorise.kindMap[input.kind] ?? null)
    if (value) return value.slice(0, 200)
  }
  return rules.categorise.fallback || UNSORTED
}

/** The frame's id, from a marker, the name, or one assigned from the label. */
function familyIdOf(
  input: ExtractInput,
  marker: string | undefined,
  findings: RuleFinding[],
): { id: string | null; label: string } {
  const { id: named, label } = splitFrameName(input.frame.name)
  if (marker && isItemId(marker)) return { id: marker, label: cleanLabel(label) }
  if (named) return { id: named, label: cleanLabel(label) }
  const pattern = input.rules.ids.pattern
  const kind = pattern === 'slug' ? '' : input.rules.ids.defaultKind
  if (pattern !== 'slug' && !kind) {
    findings.push({ kind: 'no-id', message: 'The frame name carries no id and the rules give no default kind.' })
  }
  const assigned = assignItemId({ kind, source: '', label }, [], 'suffix')
  return { id: assigned.ok ? assigned.id : null, label: cleanLabel(label) }
}

/** Serialize `root` with each cell's design swapped for its id, then put
 *  the designs back: a variant's change never moves its family's hash. */
function withoutDesigns(root: Element, cells: Cell[]): string {
  const swaps = cells.flatMap((c) => {
    const parent = c.design.parentNode
    if (!parent || c.design === root) return []
    const at = parent.childNodes.indexOf(c.design)
    const stub = { nodeName: '#text', value: `[${c.id}]`, parentNode: parent } as unknown as Element
    parent.childNodes[at] = stub
    return [{ parent, at, design: c.design }]
  })
  try {
    return outerHtml(root)
  } finally {
    for (const { parent, at, design } of swaps) parent.childNodes[at] = design
  }
}

/** Extract the items one frame holds. */
export function extractFrameItems(input: ExtractInput): ExtractResult {
  const { frame, rules, taxonomy } = input
  const section = readSection(rules.detect.section, frame.name)
  if (section) return { items: [], scripted: false, ignored: true, section }
  if (isIgnoredName(rules, frame.name)) return { items: [], scripted: false, ignored: true }

  const doc = parseHtml(frame.html || '')
  const scripted = hasScripts(doc)
  const body = bodyOf(doc)
  const markedFamily = findElement(doc, (el) => attr(el, 'data-doop-item') !== undefined)
  const findings: RuleFinding[] = []
  const { id: familyId, label } = familyIdOf(input, markedFamily && attr(markedFamily, 'data-doop-item'), findings)
  if (!familyId) return { items: [], scripted, ignored: false }

  const sources = taxonomy.sources.length ? taxonomy.sources.map((s) => s.id) : undefined
  const parsed = parseItemId(familyId, sources) ?? { kind: '', source: '', slug: itemSlug(label) }
  const component = !!findElement(doc, (el) => attr(el, 'data-doop-component') !== undefined)
  const { sourceUrl, license } = sourceLine(doc)
  const pageCat = pageCategory(input.pageName)
  const familyRoot =
    markedFamily && markedFamily.tagName !== 'body' && markedFamily.tagName !== 'html' ? markedFamily : body
  const familyMarker =
    (markedFamily && attr(markedFamily, 'data-doop-category')) || (body && attr(body, 'data-doop-category')) || null
  const familyCategory = categorise(rules, {
    marker: familyMarker,
    section: input.sectionCategory,
    page: pageCat,
    kind: parsed.kind,
  })
  const familyTags = tagsOf(markedFamily) ?? tagsOf(body) ?? []

  /* explicit variant markers win over detection */
  const marked = [...walk(doc)].filter((el) => attr(el, 'data-doop-variant') !== undefined)
  const cells: Cell[] = marked.length
    ? marked.flatMap((el) => {
        const id = attr(el, 'data-doop-variant') ?? ''
        if (!isItemId(id)) return []
        return [{ cell: el, id, label: attr(el, 'data-doop-name') ?? '', design: el }]
      })
    : component
      ? []
      : findCells(doc, rules, familyId)

  /* an exploded card: its bar is chrome, its wrap the design */
  const libbar = findElement(doc, (el) => classes(el).includes('libbar'))
  const itemwrap = findElement(doc, (el) => classes(el).includes('itemwrap'))
  const chrome = new Set<Element>([...(libbar ? [libbar] : []), ...cells.map((c) => c.cell)])
  const skipChrome = (el: Element) => chrome.has(el)

  const variants: ExtractedItem[] = cells.map((c, position) => {
    const vp = parseItemId(c.id, sources) ?? parsed
    const marker = attr(c.cell, 'data-doop-category') ?? attr(c.design, 'data-doop-category') ?? null
    const designHtml = outerHtml(c.design)
    return {
      itemId: c.id,
      parentId: familyId,
      frameId: frame.id,
      pageId: frame.pageId ?? '',
      position,
      label: c.label || c.id,
      description: '',
      kind: vp.kind || parsed.kind,
      source: vp.source || parsed.source,
      category: marker ? categorise(rules, { marker, section: null, page: null, kind: vp.kind }) : familyCategory,
      tags: tagsOf(c.cell) ?? tagsOf(c.design) ?? familyTags,
      mode: 'snapshot',
      locator: locatorOf(c.design, c.id),
      box: null,
      scripted,
      status: 'active',
      findings: [],
      hash: contentHash(designHtml),
      searchText: `${c.label} ${itemText(c.design)}`.trim().slice(0, MAX_TEXT),
      sourceUrl,
      license,
    }
  })

  /* the family's own content: the frame with each variant's design left out */
  const familyContent = withoutDesigns(familyRoot ?? doc.childNodes.find(isElement)!, cells)
  const description = (() => {
    const header = findElement(doc, (el) => el.tagName === 'header' || classes(el).includes('hd'))
    const p = header && findElement(header, (el) => el.tagName === 'p')
    return p ? itemText(p).slice(0, 500) : ''
  })()
  const textRoot = itemwrap ?? familyRoot
  const family: ExtractedItem = {
    itemId: familyId,
    parentId: null,
    frameId: frame.id,
    pageId: frame.pageId ?? '',
    position: 0,
    label: label || familyId,
    description,
    kind: parsed.kind,
    source: parsed.source,
    category: familyCategory,
    tags: familyTags,
    mode: component ? 'component' : 'snapshot',
    locator: markedFamily && familyRoot === markedFamily ? locatorOf(markedFamily, familyId) : { whole: true },
    box: null,
    scripted,
    status:
      (markedFamily && attr(markedFamily, 'data-doop-status') === 'draft') ||
      (body && attr(body, 'data-doop-status') === 'draft')
        ? 'draft'
        : 'active',
    findings,
    hash: contentHash(familyContent),
    searchText: `${label} ${textRoot ? itemText(textRoot, skipChrome) : ''}`.trim().slice(0, MAX_TEXT),
    sourceUrl,
    license,
  }
  return { items: [family, ...variants], scripted, ignored: false }
}

/** For tests and the import: parse once, extract many. */
export { parseHtml }
