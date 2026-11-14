/**
 * Insert a library item without a browser tab: for the gallery's "Use" and
 * for agents. The item is snapshotted in the headless browser with the same
 * script the ⌘F preview runs (shared/findPreviewRuntime.ts and
 * shared/librarySnapshot.ts), so the server's copy and the browser's differ
 * only in generated ids. Without a renderer (or when it is busy) the static
 * fallback reads the element by parse5 and keeps the frame's `<style>`
 * blocks whole under the scope (`fidelity: 'static'`).
 */
import { parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import type { Actor, Frame } from '../shared/types.ts'
import type { LibraryItem, LibraryItemMeta } from '../shared/library.ts'
import { libraryBlock, REF_ATTR, REF_LIB_ATTR, REF_REV_ATTR, refId } from '../shared/libraryBlock.ts'
import type { LibrarySnapshot } from '../shared/librarySnapshot.ts'
import { withFindPreviewScript, type ItemFocus } from '../shared/findPreviewRuntime.ts'
import { ELEMENT_ID_ATTR, newElementId } from '../shared/elementId.ts'
import { NON_INSERTABLE_KINDS } from '../shared/libraryRules.ts'
import * as actions from './actions.ts'
import { store } from './store.ts'
import { loadFramePage, rendererAvailable } from './screenshot.ts'
import { getLibrary } from './libraries.ts'
import { itemMeta, saveMeta } from './libraryIndex.ts'
import { findCells } from './libraryExtract.ts'
import { addAttributes } from './libraryImportPlan.ts'
import {
  ComponentError,
  createComponentFromElement,
  findComponent,
  importComponent,
  insertInstance,
} from './componentActions.ts'
import {
  attr,
  bodyOf,
  classes,
  elementChildren,
  findElement,
  isElement,
  outerHtml,
  parseHtml,
  walk,
  type Document,
  type Element,
} from './libraryDom.ts'

export type Fidelity = 'rendered' | 'static'

export interface ItemSnapshot {
  snap: LibrarySnapshot
  fidelity: Fidelity
}

/** What the server snapshots with (swapped in tests). */
export interface SnapshotRenderer {
  available(): boolean
  snapshot(frame: Frame, focus: ItemFocus): Promise<LibrarySnapshot | null>
}

const TOKEN = 'doop-server-snapshot'
/* the runtime and the snapshot are serialized from transpiled code, which
   may call tsx's __name helper: the page gets a stand-in first */
const NAME_SHIM = '<script data-doop-find>window.__name=window.__name||function(t){return t}</script>'

const serverRenderer: SnapshotRenderer = {
  available: () => rendererAvailable(),
  async snapshot(frame, focus) {
    const html = withFindPreviewScript(frame.html || '<!doctype html><html><body></body></html>', TOKEN).replace(
      '<script data-doop-find>',
      `${NAME_SHIM}<script data-doop-find>`,
    )
    const loaded = await loadFramePage({ ...frame, html })
    try {
      const expression = `new Promise(function (resolve) {
        var asked = false
        function ask() { if (asked) return; asked = true; window.postMessage({ doopFindPreview: ${JSON.stringify(TOKEN)}, snapshot: 's' }, '*') }
        var fallback = setTimeout(ask, 2000)
        var giveUp = setTimeout(function () { resolve(null) }, 6000)
        window.addEventListener('message', function (e) {
          var d = e.data
          if (!d || d.doopFindPreview !== ${JSON.stringify(TOKEN)}) return
          if (d.type === 'box' && (d.box || ${JSON.stringify(!focus.text && !focus.selector)})) ask()
          if (d.type === 'snapshot') { clearTimeout(fallback); clearTimeout(giveUp); resolve(d.snapshot) }
        })
        window.postMessage({ doopFindPreview: ${JSON.stringify(TOKEN)}, focus: ${JSON.stringify(focus.key)}, find: ${JSON.stringify(focus)} }, '*')
      })`
      return (await loaded.page.evaluate(expression)) as LibrarySnapshot | null
    } finally {
      await loaded.close()
    }
  },
}

let renderer: SnapshotRenderer = serverRenderer

/** For tests: snapshot with something else than the headless browser. */
export function setSnapshotRenderer(next: SnapshotRenderer | null): void {
  renderer = next ?? serverRenderer
}

/** The focus the runtime looks for, from the item's locator. */
export function focusOf(item: Pick<LibraryItem, 'itemId' | 'locator'>): ItemFocus {
  const loc = item.locator
  if ('elementId' in loc) {
    return { key: item.itemId, text: item.itemId, selector: `[data-doop-id="${loc.elementId.replace(/["\\]/g, '')}"]` }
  }
  if ('anchor' in loc) return { key: item.itemId, text: loc.anchor, anchor: true }
  return { key: item.itemId, text: '' }
}

/* ---- the static fallback ---- */

const UNSAFE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'frame', 'frameset'])
const DEF_TAGS = new Set([
  'symbol',
  'lineargradient',
  'radialgradient',
  'filter',
  'clippath',
  'mask',
  'pattern',
  'marker',
])

/** Drop what would run: unsafe elements, on* handlers, script URLs. */
function makeInert(root: Element) {
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    el.attrs = el.attrs.filter((a) => {
      const name = a.name.toLowerCase()
      let url = ''
      for (const ch of a.value) if (ch.charCodeAt(0) > 32) url += ch.toLowerCase()
      return !name.startsWith('on') && !/^(javascript|vbscript):/.test(url)
    })
    el.childNodes = el.childNodes.filter((child) => !(isElement(child) && UNSAFE_TAGS.has(child.tagName)))
    for (const child of elementChildren(el)) stack.push(child)
  }
}

/** Split a stylesheet at its top-level blocks. */
export function splitCss(css: string): { rules: string[]; keyframes: string[]; fontFaces: string[] } {
  const out = { rules: [] as string[], keyframes: [] as string[], fontFaces: [] as string[] }
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const block = text.slice(start, i + 1).trim()
        start = i + 1
        if (/^@(-\w+-)?keyframes\b/i.test(block)) out.keyframes.push(block)
        else if (/^@font-face\b/i.test(block)) out.fontFaces.push(block)
        else if (/^@import\b/i.test(block)) continue
        else if (block) out.rules.push(block)
      }
    } else if (c === ';' && depth === 0) start = i + 1
  }
  return out
}

function referencedIds(text: string): string[] {
  const ids: string[] = []
  for (const m of text.matchAll(/(?:href\s*=\s*["']#|url\(\s*["']?#)([\w:.-]+)/g)) if (m[1]) ids.push(m[1])
  return [...new Set(ids)]
}

function locate(doc: Document, item: LibraryItem): Element | null {
  const loc = item.locator
  if ('elementId' in loc) return findElement(doc, (el) => attr(el, ELEMENT_ID_ATTR) === loc.elementId) ?? null
  if ('anchor' in loc) {
    const marked = findElement(doc, (el) => attr(el, 'data-doop-variant') === item.itemId)
    if (marked) return marked
    const rules = getLibrary(item.canvasId)?.rules
    if (!rules) return null
    const auto = { ...rules, detect: { ...rules.detect, variants: { mode: 'auto' as const } } }
    const cells = findCells(doc, rules.detect.variants.mode === 'none' ? auto : rules, item.parentId)
    return cells.find((c) => c.id === item.itemId)?.design ?? null
  }
  return null
}

/** The item read from the frame's HTML alone. */
export function staticSnapshot(frame: Frame, item: LibraryItem): LibrarySnapshot {
  const doc = parseHtml(frame.html || '')
  const target = locate(doc, item)
  const body = bodyOf(doc)
  const root = target ?? body
  const css = [...walk(doc)].filter((el) => el.tagName === 'style').map((el) => serialize(el))
  const { rules, keyframes, fontFaces } = splitCss(css.join('\n'))
  const scripted = !!findElement(doc, (el) => el.tagName === 'script')
  const copy = parseFragment(root ? outerHtml(root) : '<div></div>')
  const top = copy.childNodes.find(isElement)
  if (top) makeInert(top)
  let html = top ? serialize(copy) : '<div></div>'
  if (!target && top) html = `<div>${serialize(top)}</div>`
  const defs: string[] = []
  for (const id of referencedIds(html)) {
    const def = findElement(doc, (el) => attr(el, 'id') === id)
    if (!def || (root && isInside(def, root))) continue
    if (!DEF_TAGS.has(def.tagName.toLowerCase())) continue
    const frag = parseFragment(outerHtml(def))
    const el = frag.childNodes.find(isElement)
    if (el) makeInert(el)
    defs.push(serialize(frag))
  }
  const htmlEl = findElement(doc, (el) => el.tagName === 'html')
  const rootClasses = [...(htmlEl ? classes(htmlEl) : []), ...(body ? classes(body) : [])]
  const rootAttrs: [string, string][] = [htmlEl, body]
    .flatMap((el) => el?.attrs ?? [])
    .filter((a) => a.name.startsWith('data-') && !a.name.startsWith('data-doop-'))
    .map((a) => [a.name, a.value])
  return {
    html,
    ancestors: [],
    rootClasses,
    rootAttrs,
    rules,
    keyframes,
    fontFaces,
    vars: [],
    inherited: [],
    defs,
    found: !!target || 'whole' in item.locator,
    scripted,
  }
}

function isInside(el: Element, root: Element): boolean {
  for (let p: Tree.ParentNode | null = el; p; p = isElement(p) ? p.parentNode : null) if (p === root) return true
  return false
}

/** The item's snapshot: rendered when a browser is there, else static. */
export async function snapshotItem(item: LibraryItem): Promise<ItemSnapshot | null> {
  const frame = await store.renderableFrame(item.frameId)
  if (!frame) return null
  if (renderer.available()) {
    try {
      const snap = await renderer.snapshot(frame, focusOf(item))
      if (snap) return { snap, fidelity: 'rendered' }
    } catch (error) {
      console.warn('[library-snapshot] rendered snapshot failed, reading the html', item.itemId, error)
    }
  }
  return { snap: staticSnapshot(frame, item), fidelity: 'static' }
}

/* ---- the insert ---- */

export class InsertError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

const KEPT_DOOP_ATTRS = new Set([REF_ATTR, REF_LIB_ATTR, REF_REV_ATTR, 'data-doop-name', 'data-doop-ref-style'])

/** Give every element of the block a fresh `data-doop-id` and drop the
 *  library's own editor state; returns the markup and the block's id. */
export function freshBlock(block: string, taken: string): { html: string; elementId: string } {
  const frag = parseFragment(block)
  const top = frag.childNodes.find(isElement)
  let elementId = ''
  const used = new Set<string>()
  const fresh = () => {
    let id = newElementId()
    while (used.has(id) || taken.includes(`"${id}"`)) id = newElementId()
    used.add(id)
    return id
  }
  const stack: Element[] = top ? [top] : []
  for (let el = stack.pop(); el; el = stack.pop()) {
    el.attrs = el.attrs.filter((a) => !a.name.startsWith('data-doop-') || KEPT_DOOP_ATTRS.has(a.name))
    if (el.tagName !== 'style') {
      const id = fresh()
      el.attrs.push({ name: ELEMENT_ID_ATTR, value: id })
      if (el === top) elementId = id
    }
    for (const child of elementChildren(el)) stack.push(child)
  }
  return { html: serialize(frag), elementId }
}

/** Where the block goes: right after the named element, else before </body>. */
export function placeBlock(html: string, block: string, afterElementId?: string): string | null {
  const doc = parseHtml(html)
  if (afterElementId) {
    const el = findElement(doc, (e) => attr(e, ELEMENT_ID_ATTR) === afterElementId)
    const end = el?.sourceCodeLocation?.endOffset
    if (el && end !== undefined) return html.slice(0, end) + block + html.slice(end)
    throw new InsertError(`no element ${afterElementId} in this frame`, 404)
  }
  const body = bodyOf(doc)
  const close = body?.sourceCodeLocation?.endTag?.startOffset
  if (close !== undefined) return html.slice(0, close) + block + html.slice(close)
  return html + block
}

export interface InsertResult {
  elementId: string
  fidelity: Fidelity
  frame: Frame
  approvalWithdrawn: boolean
}

/** Count a use of an item (an insert, here or in the browser). */
export async function countUse(item: LibraryItem, by: string): Promise<void> {
  const current = await itemMeta(item.canvasId, item.itemId)
  const meta: LibraryItemMeta = {
    canvasId: item.canvasId,
    itemId: item.itemId,
    label: null,
    description: null,
    category: null,
    tags: null,
    status: null,
    ...current,
    useCount: (current?.useCount ?? 0) + 1,
    lastUsedAt: Date.now(),
    updatedAt: current?.updatedAt ?? Date.now(),
    updatedBy: current?.updatedBy ?? by,
  }
  await saveMeta(meta)
}

/** The component a component item's frame holds (its main's id). */
async function componentOf(item: LibraryItem): Promise<string | null> {
  const frame = await store.renderableFrame(item.frameId)
  const doc = parseHtml(frame?.html ?? '')
  const main = findElement(doc, (el) => attr(el, 'data-doop-component') !== undefined)
  return main ? (attr(main, 'data-doop-component') ?? null) : null
}

/** A component item goes in as a linked instance: its component is
 *  imported into the target canvas (once; a second insert reuses it), then
 *  an instance is placed where a copy would go. */
async function insertComponentItem(input: {
  item: LibraryItem
  frameId: string
  afterElementId?: string
  actor: Actor
}): Promise<InsertResult> {
  const { item, actor } = input
  const target = store.getFrame(input.frameId)
  if (!target) throw new InsertError('frame not found', 404)
  const componentId = await componentOf(item)
  if (!componentId) throw new InsertError(`${item.itemId} has no component main in its frame`)
  return store.withCanvas(target.canvasId, async () => {
    const current = store.getFrame(input.frameId)
    if (!current || current.locked) throw new InsertError('this frame is locked', 409)
    const approvalWithdrawn = current.approval?.status === 'ready_for_dev'
    try {
      const def =
        target.canvasId === item.canvasId
          ? findComponent(item.canvasId, componentId)
          : importComponent(target.canvasId, item.canvasId, componentId, actor)
      if (!def) throw new InsertError('the component is gone', 404)
      const placed = insertInstance(
        target.canvasId,
        {
          frameId: current.id,
          component: def.id,
          ...(input.afterElementId ? { target: input.afterElementId, position: 'after' as const } : {}),
        },
        actor,
      )
      await countUse(item, actor.name)
      return { elementId: placed.instanceId, fidelity: 'rendered', frame: placed.frame, approvalWithdrawn }
    } catch (error) {
      if (error instanceof ComponentError) throw new InsertError(error.message)
      throw error
    }
  })
}

/** "Promote to component": the item's element becomes a component main on
 *  its library canvas, under the item's label, so the item reindexes as a
 *  component with the same id. */
export async function promoteItem(item: LibraryItem, actor: Actor): Promise<{ componentId: string }> {
  if (item.mode === 'component') throw new InsertError(`${item.itemId} is already a component`)
  return store.withCanvas(item.canvasId, async () => {
    const frame = store.getFrame(item.frameId)
    if (!frame) throw new InsertError('frame not found', 404)
    const doc = parseHtml(frame.html)
    const body = bodyOf(doc)
    const el =
      locate(doc, item) ?? (body ? elementChildren(body).find((c) => c.tagName !== 'script') : undefined) ?? null
    if (!el) throw new InsertError('no element to make a component of')
    let elementId = attr(el, ELEMENT_ID_ATTR)
    if (!elementId) {
      elementId = newElementId()
      actions.annotateFrame(frame.id, addAttributes(frame.html, [{ el, attrs: [[ELEMENT_ID_ATTR, elementId]] }]), actor)
    }
    try {
      const created = createComponentFromElement(
        item.canvasId,
        { name: item.label.slice(0, 80) || item.itemId, frameId: frame.id, element: elementId },
        actor,
      )
      return { componentId: created.component.id }
    } catch (error) {
      if (error instanceof ComponentError) throw new InsertError(error.message)
      throw error
    }
  })
}

/** Insert `item` into `frameId`: a scoped copy, placed after an element or at
 *  the end of the body, written as an ordinary design write (one version,
 *  sign-off withdrawn). */
export async function insertItem(input: {
  item: LibraryItem
  frameId: string
  afterElementId?: string
  actor: Actor
}): Promise<InsertResult> {
  const { item, actor } = input
  if (NON_INSERTABLE_KINDS.has(item.kind))
    throw new InsertError(`${item.itemId} is a reference, not a design to insert`)
  if (item.mode === 'component') return insertComponentItem(input)
  const targetMeta = store.getFrame(input.frameId)
  if (!targetMeta) throw new InsertError('frame not found', 404)
  return store.withCanvas(targetMeta.canvasId, async () => {
    const target = store.getFrame(input.frameId)
    if (!target) throw new InsertError('frame not found', 404)
    if (target.locked) throw new InsertError('this frame is locked', 409)
    if (actions.isFrameStreaming(target.id))
      throw new InsertError('this frame is being written right now; try again when it is done', 409)
    const shot = await snapshotItem(item)
    if (!shot) throw new InsertError('the item is gone', 404)
    const ref = refId(item.itemId)
    const block = libraryBlock(shot.snap, {
      ref,
      libraryId: item.canvasId,
      rev: item.rev,
      prefix: `${ref}-${newElementId()}-`,
    })
    const current = store.getFrame(input.frameId)
    if (!current || current.locked) throw new InsertError('this frame is locked', 409)
    const fresh = freshBlock(block, current.html)
    const html = placeBlock(current.html, fresh.html, input.afterElementId)
    if (html === null) throw new InsertError('could not place the block')
    const approvalWithdrawn = current.approval?.status === 'ready_for_dev'
    const frame = actions.updateFrame(current.id, { html }, actor)
    if (!frame) throw new InsertError('frame not found', 404)
    await countUse(item, actor.name)
    return { elementId: fresh.elementId, fidelity: shot.fidelity, frame, approvalWithdrawn }
  })
}
