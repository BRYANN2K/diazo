/**
 * ⌘F's insert: a library item found in the results lands, as a copy, in the
 * frame the person has selected. This module holds the rules (when a click
 * inserts rather than goes, which frame and where); the snapshot of the
 * item itself is taken inside the preview iframe.
 */
import type { Frame } from '../../shared/types'
import { isCanvasElement } from './drawing'
import { canEditOpenCanvas, pickedSelectors, useStore } from './store'
import { freshElementId, insertElements } from './layers'
import { ELEMENT_ID_ATTR } from '../../shared/elementId'
import type { LibrarySnapshot } from './findPreviewRuntime'
import { snapshotLibraryItem } from './findSnapshot'
import { saveFrameHtml } from './layerEdits'

type StoreState = ReturnType<typeof useStore.getState>

/** Library ids are `cp.*` (copied components) and `ui.*` (UI kits). */
const LIBRARY_ID = /^(cp|ui)\.[\w.-]+$/i
const LIBRARY_CANVAS = /design library/i

/** Is this result a library item, which a click copies in? */
export function isLibraryItem(id: string | null | undefined, canvasName: string | null | undefined): boolean {
  return (!!id && LIBRARY_ID.test(id)) || (!!canvasName && LIBRARY_CANVAS.test(canvasName))
}

/** Where an insert lands: the selected frame, after the picked element
 *  (null: at the end of the body). */
export interface InsertTarget {
  frame: Frame
  after: string | null
}

/** The frame a click would insert into: the selected one on the open
 *  canvas, editable, unlocked, a real frame (not a standalone shape), and
 *  not the frame the item comes from. */
export function insertTarget(s: StoreState, sourceFrameId?: string): InsertTarget | null {
  if (!s.canvas || !canEditOpenCanvas(s)) return null
  const frameId = s.selectedElement?.frameId ?? s.selectedId
  if (!frameId || frameId === sourceFrameId) return null
  const frame = s.canvas.frames.find((f) => f.id === frameId)
  if (!frame || frame.locked || frame.htmlDeferred || isCanvasElement(frame.html)) return null
  const picked = s.selectedElement?.frameId === frame.id ? pickedSelectors(s) : []
  return { frame, after: picked.at(-1) ?? null }
}

/** What a click on a result row does. */
export type RowAction = { kind: 'insert'; target: InsertTarget } | { kind: 'go' }

/** Click inserts only for a library item while a frame is selected; ⇧ (or
 *  anything else) goes to the item. */
export function rowAction(
  s: StoreState,
  item: { id: string | null; canvasName?: string | null; frameId: string },
  shift: boolean,
): RowAction {
  if (shift || !isLibraryItem(item.id, item.canvasName ?? s.canvas?.name)) return { kind: 'go' }
  const target = insertTarget(s, item.frameId)
  return target ? { kind: 'insert', target } : { kind: 'go' }
}

/** The footer line under the results. */
export type FooterHint = { kind: 'insert'; frameName: string } | { kind: 'select' } | { kind: 'go' } | { kind: 'none' }

export function footerHint(
  s: StoreState,
  item: { id: string | null; canvasName?: string | null; frameId: string } | null,
): FooterHint {
  if (!item) return { kind: 'none' }
  if (!isLibraryItem(item.id, item.canvasName ?? s.canvas?.name)) return { kind: 'go' }
  const target = insertTarget(s, item.frameId)
  return target ? { kind: 'insert', frameName: target.frame.name } : { kind: 'select' }
}

/* ---- the copy ---- */

/** The attribute that keeps an inserted block's provenance (`cp.x`). */
export const REF_ATTR = 'data-doop-ref'

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

/** The block an insert writes: the item's markup inside its ancestors (as
 *  `display: contents` boxes, so its descendant selectors still match), in a
 *  wrapper carrying the reference, with the CSS scoped to that wrapper so
 *  it neither leaks into the frame nor loses its own variables and text
 *  styles. */
export function libraryBlock(snap: LibrarySnapshot, ref: string): string {
  const scope = `[${REF_ATTR}="${ref}"]`
  const own = [...snap.vars, ...snap.inherited].map(([p, v]) => `${p}: ${v};`).join(' ')
  const css = [
    `@scope (${scope}) {`,
    own ? `:scope { ${own} }` : '',
    ...snap.rules,
    '}',
    ...snap.keyframes,
    ...snap.fontFaces,
  ]
    .filter(Boolean)
    .join('\n')
  let inner = snap.html
  for (const a of [...snap.ancestors].reverse()) {
    if (!/^[a-z][\w-]*$/i.test(a.tag)) continue
    inner = `<${a.tag}${attrsHtml(a.attrs)} style="display: contents">${inner}</${a.tag}>`
  }
  const classes = snap.rootClasses.filter((c) => /^[\w-]+$/.test(c)).join(' ')
  const wrapperAttrs: [string, string][] = [
    [REF_ATTR, ref],
    ['data-doop-name', ref],
    ...(classes ? ([['class', classes]] as [string, string][]) : []),
    ...snap.rootAttrs.filter(([name]) => name !== REF_ATTR && !name.startsWith('data-doop-')),
  ]
  return `<div${attrsHtml(wrapperAttrs)}><style data-doop-ref-style>${css.replace(/<\/style/gi, '<\\/style')}</style>${inner}</div>`
}

/* what the library's own editor state says about an element does not hold
   in the frame it lands in: comments, links, locks, prototype wiring,
   component instances */
const KEPT_DOOP_ATTRS = new Set([REF_ATTR, 'data-doop-name', 'data-doop-ref-style'])

/** Insert the block after `after` (else at the end of the body), give every
 *  element in it a fresh `data-doop-id`, and return the new HTML with the
 *  block's selector. An anchor that cannot take a block (a `<p>`) falls back
 *  to the end of the body. */
export function insertLibraryBlock(
  html: string,
  after: string | null,
  block: string,
): { html: string; selector: string } | null {
  const inserted = insertElements(html, after, block) ?? (after ? insertElements(html, null, block) : null)
  const selector = inserted?.selectors[0]
  if (!inserted || !selector) return null
  const doc = new DOMParser().parseFromString(inserted.html, 'text/html')
  const root = doc.querySelector(selector)
  if (!root) return null
  let taken = inserted.html
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const { name } of [...el.attributes]) {
      if (name.startsWith('data-doop-') && !KEPT_DOOP_ATTRS.has(name)) el.removeAttribute(name)
    }
    if (el.tagName === 'STYLE') continue
    const id = freshElementId(taken)
    el.setAttribute(ELEMENT_ID_ATTR, id)
    taken += ` ${ELEMENT_ID_ATTR}="${id}"`
  }
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, selector }
}

/** What an insert did, for the notice and the box that follows it. */
export interface InsertedItem {
  frameId: string
  selector: string
  ref: string
  /** false: the item was not found in its sheet and the whole document was copied */
  found: boolean
  /** the item's sheet runs scripts: the copy is a still of what they rendered */
  scripted: boolean
  /** the frame was signed off as ready for dev: the edit withdrew it */
  approvalWithdrawn: boolean
  /** the frame's HTML before the insert */
  before: string
}

/** Copy the item `focus` names, in `sourceFrameId`, into the target frame
 *  as one undo step, and pick the inserted block. */
export async function insertLibraryItem(opts: {
  sourceFrameId: string
  focus: string
  ref: string
  target: InsertTarget
}): Promise<InsertedItem | null> {
  const snap = await snapshotLibraryItem(opts.sourceFrameId, opts.focus)
  if (!snap) return null
  const s = useStore.getState()
  /* the frame as it stands now: it may have changed while the item rendered */
  const frame = s.canvas?.frames.find((f) => f.id === opts.target.frame.id)
  if (!frame || frame.locked || frame.htmlDeferred) return null
  const ref = refId(opts.ref)
  const done = insertLibraryBlock(frame.html, opts.target.after, libraryBlock(snap, ref))
  if (!done) return null
  saveFrameHtml(frame, done.html)
  s.select(frame.id)
  s.pickElement({ frameId: frame.id, selector: done.selector }, true)
  return {
    frameId: frame.id,
    selector: done.selector,
    ref,
    found: snap.found,
    scripted: snap.scripted,
    approvalWithdrawn: frame.approval?.status === 'ready_for_dev',
    before: frame.html,
  }
}
