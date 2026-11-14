/**
 * The import pipeline, planned: what a library's rules do to frames
 * entering it, stage by stage, as a report a dry run returns and an apply
 * carries out. Pure over its arguments: no store, no database.
 * Spec: .context/specs/design-libraries.md, "Import rules".
 */
import type { ImportFrameReport, ImportReport, LibraryTaxonomy, RuleFinding } from '../shared/library.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import type { FrameLint } from '../shared/slopRules.ts'
import { applyTokenMatches, tokenMatches } from '../shared/libraryTokens.ts'
import { UNSORTED } from '../shared/library.ts'
import { assignItemId, isItemId, itemSlug, parseItemId, splitFrameName } from '../shared/libraryIds.ts'
import { isIgnoredName, sectionCategory, type LibraryRules } from '../shared/libraryRules.ts'
import { attr, bodyOf, findElement, parseHtml, walk, type Element } from './libraryDom.ts'
import { contentHash, extractFrameItems, findCells, pageCategory } from './libraryExtract.ts'

/** A frame offered to the library. */
export interface ImportFrame {
  frameId: string
  name: string
  html: string
  width: number
  height: number
  /** the page it comes from, for the page rule */
  pageName?: string
  /** the category the last section above it started, where it comes from */
  section?: string | null
}

/** The library as the plan needs it. */
export interface ImportLibrary {
  canvasId: string
  rules: LibraryRules
  taxonomy: LibraryTaxonomy
  pages: { id: string; name: string }[]
  /** where frames already sit, for the placement */
  frames: { pageId: string; x: number; y: number; width: number; height: number }[]
  /** the page placement 'current' uses */
  currentPageId?: string
}

/** An item the library already holds. */
export interface ExistingItem {
  itemId: string
  hash: string
  frameId: string
}

export interface PlanInput {
  library: ImportLibrary
  frames: ImportFrame[]
  existing: ExistingItem[]
  /** given by the person or the agent: wins over every rule */
  category?: string
  tags?: string[]
  /** the library canvas's design tokens, for the token stage */
  tokens?: readonly DesignToken[]
}

type Draft = ImportFrameReport & { html: string; name: string; source: ImportFrame }

const SVG_NS_DEFS = ['symbol', 'lineargradient', 'radialgradient', 'filter', 'clippath', 'mask', 'pattern', 'marker']

/* ---- stages ---- */

/** 1. Names that are not items are placed, and yield no item. */
export function stageIgnore(d: Draft, rules: LibraryRules): Draft {
  const section = sectionCategory(rules.detect.section, d.name)
  if (section || isIgnoredName(rules, d.name)) return { ...d, ignored: true }
  return d
}

/** 2. The id: from a marker or the name, else assigned; checked against the
 *  grammar and the ids taken. */
export function stageId(d: Draft, rules: LibraryRules, taken: Set<string>): Draft {
  if (d.ignored) return d
  const findings: RuleFinding[] = [...d.findings]
  const doc = parseHtml(d.html)
  const marker = findElement(doc, (el) => attr(el, 'data-doop-item') !== undefined)
  const markedId = marker ? (attr(marker, 'data-doop-item') ?? '') : ''
  const { id: named, label } = splitFrameName(d.name)
  let id = isItemId(markedId) ? markedId : named
  if (!id) {
    const pattern = rules.ids.pattern
    const kind = pattern === 'slug' ? '' : rules.ids.defaultKind
    if (pattern !== 'slug' && !kind) {
      findings.push({ kind: 'no-id', message: 'The frame has no id and the rules give no default kind to make one.' })
      return { ...d, findings, item: undefined }
    }
    const made = assignItemId({ kind, source: '', label }, [], 'suffix')
    if (!made.ok) {
      findings.push({ kind: 'no-id', message: 'No id can be made from this frame’s name.' })
      return { ...d, findings, item: undefined }
    }
    id = made.id
  }
  if (taken.has(id.toLowerCase())) {
    if (rules.ids.onCollision === 'reject') {
      findings.push({ kind: 'id-collision', message: `The id ${id} is already in the library.`, itemId: id })
      return { ...d, findings, item: undefined }
    }
    if (rules.ids.onCollision === 'suffix') {
      let n = 2
      while (taken.has(`${id}-${n}`.toLowerCase())) n++
      findings.push({ kind: 'id-collision', message: `The id ${id} was taken; this one is ${id}-${n}.`, itemId: id })
      id = `${id}-${n}`
    } else {
      findings.push({ kind: 'id-collision', message: `This frame replaces the item ${id}.`, itemId: id })
    }
  }
  taken.add(id.toLowerCase())
  const parsed = parseItemId(id) ?? { kind: '', source: '', slug: itemSlug(label) }
  return {
    ...d,
    findings,
    item: {
      itemId: id,
      label: label.replace(/\s*\(\d+\)\s*$/, '').trim() || id,
      kind: parsed.kind,
      source: parsed.source,
      category: UNSORTED,
      tags: [],
      status: 'active',
    },
  }
}

/** 3. The frame is named the way the library names its frames. */
export function stageNaming(d: Draft, rules: LibraryRules): Draft {
  if (!d.item) return d
  const name = rules.naming.frameName === '{id} — {label}' ? `${d.item.itemId} — ${d.item.label}` : d.item.label
  return name === d.name ? d : { ...d, name, changes: { ...d.changes, name } }
}

/** Write attributes into start tags by source offset, nothing else re-serialized. */
export function addAttributes(html: string, marks: { el: Element; attrs: [string, string][] }[]): string {
  const edits = marks
    .flatMap(({ el, attrs }) => {
      const loc = el.sourceCodeLocation?.startTag
      if (!loc) return []
      const missing = attrs.filter(([name]) => attr(el, name) === undefined)
      if (!missing.length) return []
      const end = html.lastIndexOf('/>', loc.endOffset) === loc.endOffset - 2 ? loc.endOffset - 2 : loc.endOffset - 1
      const text = missing.map(([name, value]) => ` ${name}="${value.replace(/"/g, '&quot;')}"`).join('')
      return [{ at: end, text }]
    })
    .sort((a, b) => b.at - a.at)
  let out = html
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at)
  return out
}

/** 4. Variants: found by the rules, and marked so they keep their ids. */
export function stageVariants(d: Draft, rules: LibraryRules, taxonomy: LibraryTaxonomy): Draft {
  if (!d.item) return d
  const doc = parseHtml(d.html)
  const cells = findCells(doc, rules, d.item.itemId)
  const extracted = extractFrameItems({
    frame: { id: d.frameId, name: d.name, html: d.html },
    pageName: d.source.pageName ?? '',
    sectionCategory: d.source.section ?? null,
    rules,
    taxonomy,
  })
  const variants = extracted.items.filter((i) => i.parentId).map((i) => i.itemId)
  const marks = cells.map((c) => ({ el: c.design, attrs: [['data-doop-variant', c.id]] as [string, string][] }))
  const body = bodyOf(doc)
  if (body && !findElement(doc, (el) => attr(el, 'data-doop-item') !== undefined)) {
    marks.push({ el: body, attrs: [['data-doop-item', d.item.itemId]] })
  }
  const html = addAttributes(d.html, marks)
  return { ...d, variants, html, changes: html !== d.source.html ? { ...d.changes, html } : d.changes }
}

function referencedIds(html: string): string[] {
  const ids: string[] = []
  for (const m of html.matchAll(/(?:href\s*=\s*["']#|url\(\s*["']?#)([\w:.-]+)/g)) if (m[1]) ids.push(m[1])
  return [...new Set(ids)]
}

function definedIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid\s*=\s*["']([\w:.-]+)["']/g)].map((m) => m[1]!))
}

/** 5. Definitions the frame points at but does not hold: copied in from a
 *  frame of the batch that has them, else reported. */
export function stageDependencies(d: Draft, all: ImportFrame[], rules: LibraryRules): Draft {
  if (d.ignored) return d
  const own = definedIds(d.html)
  const dangling = referencedIds(d.html).filter((id) => !own.has(id))
  if (!dangling.length) return d
  const copied: string[] = []
  const missing: string[] = []
  for (const id of dangling) {
    let found: string | null = null
    if (rules.css.inlineSymbols) {
      for (const other of all) {
        if (other.frameId === d.frameId || !definedIds(other.html).has(id)) continue
        const doc = parseHtml(other.html)
        const el = [...walk(doc)].find((e) => attr(e, 'id') === id && SVG_NS_DEFS.includes(e.tagName.toLowerCase()))
        const loc = el?.sourceCodeLocation
        if (el && loc) found = other.html.slice(loc.startOffset, loc.endOffset)
        if (found) break
      }
    }
    if (found) copied.push(found)
    else missing.push(id)
  }
  const findings = [...d.findings]
  if (missing.length) {
    findings.push({
      kind: 'missing-dependency',
      message: `This frame points at ${missing.map((id) => `#${id}`).join(', ')}, which nothing it brings defines.`,
      refs: missing,
    })
  }
  if (!copied.length) return { ...d, findings }
  const defs = `<svg width="0" height="0" aria-hidden="true" style="position: absolute" data-doop-defs>${copied.join('')}</svg>`
  const close = d.html.search(/<\/body>/i)
  const html = close >= 0 ? d.html.slice(0, close) + defs + d.html.slice(close) : d.html + defs
  return { ...d, html, findings, changes: { ...d.changes, html } }
}

/** 6. Tokens: literal values equal to a library token, listed or rewritten. */
export function stageTokens(d: Draft, tokens: readonly DesignToken[], mode: LibraryRules['tokens']['map']): Draft {
  if (d.ignored || mode === 'off' || !tokens.length) return d
  const matches = tokenMatches(d.html, tokens)
  if (!matches.length) return d
  const finding: RuleFinding = {
    kind: 'token-match',
    message: `${matches.length} literal value${matches.length === 1 ? '' : 's'} equal a token: ${matches
      .slice(0, 6)
      .map((m) => `${m.value} → var(${m.token})`)
      .join(', ')}${mode === 'apply' ? ' (rewritten)' : ''}.`,
  }
  if (mode === 'suggest') return { ...d, findings: [...d.findings, finding] }
  const html = applyTokenMatches(d.html, tokens)
  return { ...d, html, findings: [...d.findings, finding], changes: { ...d.changes, html } }
}

/** 7. The quality gate: the linter scores each frame as it would enter.
 *  `warn` notes a low score, `draft` also keeps the item out of search
 *  until a person accepts it. `off` never calls the linter. */
export async function stageLint(
  report: ImportReport,
  htmlOf: (frameId: string) => string,
  rules: LibraryRules,
  lint: (html: string, frameId: string) => Promise<FrameLint>,
): Promise<ImportReport> {
  const gate = rules.lint.gate
  if (gate === 'off') return report
  const ignored = new Set(rules.lint.ignoreRules)
  const frames: ImportFrameReport[] = []
  for (const f of report.frames) {
    if (!f.item) {
      frames.push(f)
      continue
    }
    const result = await lint(f.changes.html ?? htmlOf(f.frameId), f.frameId)
    const issues = result.issues.filter((i) => !ignored.has(i.ruleId))
    if (!issues.length || result.score >= rules.lint.minScore) {
      frames.push(f)
      continue
    }
    const finding: RuleFinding = {
      kind: 'lint',
      message: `Lint score ${result.score} is under ${rules.lint.minScore}: ${issues
        .slice(0, 4)
        .map((i) => i.ruleId)
        .join(', ')}.`,
      score: result.score,
    }
    frames.push({
      ...f,
      findings: [...f.findings, finding],
      item: gate === 'draft' ? { ...f.item, status: 'draft' } : f.item,
    })
  }
  return {
    frames,
    totals: { ...report.totals, drafts: frames.filter((r) => r.item?.status === 'draft').length },
  }
}

/** 8. Duplicates: an id the library holds follows the collision rule (stage
 *  2); content equal to another item's follows the duplicate rule. */
export function stageDedup(d: Draft, rules: LibraryRules, hashes: Map<string, string>): Draft {
  if (!d.item || !rules.dedup.by.includes('hash')) return d
  const hash = contentHash(d.html.replace(/\sdata-doop-(item|variant)="[^"]*"/g, ''))
  const other = hashes.get(hash)
  if (!other || other === d.item.itemId) {
    hashes.set(hash, d.item.itemId)
    return d
  }
  const findings: RuleFinding[] = [
    ...d.findings,
    { kind: 'duplicate', message: `Same content as ${other}.`, itemId: other },
  ]
  if (rules.dedup.onDuplicate === 'skip') return { ...d, findings, item: undefined, skipped: true }
  if (rules.dedup.onDuplicate === 'draft') return { ...d, findings, item: { ...d.item, status: 'draft' } }
  return { ...d, findings }
}

/** 9. The category: the first of the rules' sources that answers. */
export function stageCategorise(d: Draft, rules: LibraryRules, given?: string): Draft {
  if (!d.item) return d
  const doc = parseHtml(d.html)
  const marker = findElement(doc, (el) => attr(el, 'data-doop-category') !== undefined)
  const sources: Record<string, string | null> = {
    marker: marker ? (attr(marker, 'data-doop-category') ?? null) : null,
    section: d.source.section ?? null,
    page: d.source.pageName ? pageCategory(d.source.pageName) : null,
    kind: rules.categorise.kindMap[d.item.kind] ?? null,
  }
  let category = given?.trim() || null
  for (const by of rules.categorise.by) {
    if (category) break
    category = sources[by] ?? null
  }
  return { ...d, item: { ...d.item, category: category || rules.categorise.fallback || UNSORTED } }
}

/** 10. Where the frame goes: the page of its category (created when
 *  missing) or the current page, below the last frame there. */
export function stagePlacement(
  d: Draft,
  library: ImportLibrary,
  bottoms: Map<string, { x: number; y: number }>,
  newPages: Map<string, string>,
): Draft {
  const rules = library.rules
  const topCategory = (d.item?.category ?? '').split('/')[0]?.trim() ?? ''
  let pageId = library.currentPageId ?? library.pages[0]?.id ?? ''
  let newPage: string | undefined
  if (rules.placement.page === 'category' && topCategory) {
    const match = library.pages.find((p) => p.name === topCategory || pageCategory(p.name) === topCategory)
    if (match) pageId = match.id
    else {
      newPage = topCategory
      pageId = newPages.get(topCategory) ?? `new:${topCategory}`
      newPages.set(topCategory, pageId)
    }
  }
  if (!bottoms.has(pageId)) {
    const onPage = library.frames.filter((f) => f.pageId === pageId)
    const y = onPage.reduce((m, f) => Math.max(m, f.y + f.height), 0)
    const x = onPage.length ? Math.min(...onPage.map((f) => f.x)) : 0
    bottoms.set(pageId, { x, y: onPage.length ? y : -rules.placement.gap })
  }
  const at = bottoms.get(pageId)!
  const y = at.y + rules.placement.gap
  bottoms.set(pageId, { x: at.x, y: y + d.source.height })
  return { ...d, changes: { ...d.changes, pageId, ...(newPage ? { newPage } : {}), x: at.x, y } }
}

/* ---- the plan ---- */

/** Run every stage over the frames and report what an import would do. */
export function planImport(input: PlanInput): ImportReport {
  const { library, frames, existing } = input
  const rules = library.rules
  const taken = new Set(existing.map((e) => e.itemId.toLowerCase()))
  const hashes = new Map<string, string>()
  for (const e of existing) hashes.set(e.hash, e.itemId)
  const bottoms = new Map<string, { x: number; y: number }>()
  const newPages = new Map<string, string>()
  const reports: ImportFrameReport[] = []
  for (const source of frames) {
    let d: Draft = {
      frameId: source.frameId,
      ignored: false,
      variants: [],
      findings: [],
      changes: {},
      html: source.html,
      name: source.name,
      source,
    }
    d = stageIgnore(d, rules)
    d = stageId(d, rules, taken)
    d = stageNaming(d, rules)
    d = stageVariants(d, rules, library.taxonomy)
    d = stageDependencies(d, frames, rules)
    d = stageTokens(d, input.tokens ?? [], rules.tokens.map)
    d = stageDedup(d, rules, hashes)
    d = stageCategorise(d, rules, input.category)
    if (d.item && input.tags?.length) d = { ...d, item: { ...d.item, tags: input.tags.slice(0, 12) } }
    if (!d.skipped) d = stagePlacement(d, library, bottoms, newPages)
    const { html: _html, name: _name, source: _source, ...report } = d
    reports.push(report)
  }
  return {
    frames: reports,
    totals: {
      frames: reports.length,
      items: reports.filter((r) => r.item).length,
      variants: reports.reduce((n, r) => n + r.variants.length, 0),
      ignored: reports.filter((r) => r.ignored).length,
      drafts: reports.filter((r) => r.item?.status === 'draft').length,
      findings: reports.reduce((n, r) => n + r.findings.length, 0),
    },
  }
}

/** Mark a frame's item a draft (the import's gate): the index reads it back. */
export function markDraft(html: string): string {
  const doc = parseHtml(html)
  const marked = findElement(doc, (el) => attr(el, 'data-doop-item') !== undefined) ?? bodyOf(doc)
  return marked ? addAttributes(html, [{ el: marked, attrs: [['data-doop-status', 'draft']] }]) : html
}

/** A category asked for at import, written where the indexer reads it
 *  (`data-doop-category` on the item, else the body): without it the page
 *  rule would give the item its top category only. A marker already there
 *  is replaced. */
export function markCategory(html: string, category: string): string {
  const doc = parseHtml(html)
  const marked = findElement(doc, (el) => attr(el, 'data-doop-item') !== undefined) ?? bodyOf(doc)
  if (!marked) return html
  const current = attr(marked, 'data-doop-category')
  if (current === category) return html
  if (current !== undefined) {
    return html.replace(
      /(\sdata-doop-category=")[^"]*(")/,
      (_m, a: string, b: string) => `${a}${escapeAttr(category)}${b}`,
    )
  }
  return addAttributes(html, [{ el: marked, attrs: [['data-doop-category', category]] }])
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Give a frame an item id of its own (`data-doop-item` on the body):
 *  an import as a variant names it after the family it joins. */
export function markItemId(html: string, itemId: string): string {
  const doc = parseHtml(html)
  const body = bodyOf(doc)
  if (!body) return html
  if (attr(body, 'data-doop-item') !== undefined) {
    return html.replace(/(\sdata-doop-item=")[^"]*(")/, (_m, a: string, b: string) => `${a}${escapeAttr(itemId)}${b}`)
  }
  return addAttributes(html, [{ el: body, attrs: [['data-doop-item', itemId]] }])
}
