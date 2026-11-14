/**
 * ⌘F's insert: a library item found in the results lands, as a copy, in the
 * frame the person has selected. This module holds the rules (when a click
 * inserts rather than goes, which frame and where); the snapshot of the
 * item itself is taken inside the preview iframe.
 */
import type { Frame } from '../../shared/types'
import { isCanvasElement } from './drawing'
import { canEditOpenCanvas, pickedSelectors, useStore } from './store'
import { freshElementId, insertElements, placeElement, removeElements, type DropTarget } from './layers'
import { ELEMENT_ID_ATTR, elementIdSelector } from '../../shared/elementId'
import type { ItemFocus } from './findPreviewRuntime'
import { libraryBlock, REF_ATTR, REF_LIB_ATTR, REF_REV_ATTR, refId } from '../../shared/libraryBlock'
import { snapshotLibraryItem } from './findSnapshot'
import { saveFrameHtml } from './layerEdits'
import type { LibraryItemSummary } from '../../shared/library'
import { isInsertable } from './findLibrary'

type StoreState = ReturnType<typeof useStore.getState>

/** A result row as an insert sees it: the library item it stands for (none
 *  for a text hit) and the frame it lives in. */
export interface InsertSource {
  item: LibraryItemSummary | null
  frameId: string
}

/** Is this result a library item a click copies in? Only rows the library
 *  index answered carry an item, and only insertable kinds are copied. */
export function isLibraryItem(source: InsertSource | null | undefined): boolean {
  return isInsertable(source?.item)
}

/** Where an insert lands: a frame, and in it a slot (a drop between
 *  elements), the picked element to follow, or null for the end of the body. */
export interface InsertTarget {
  frame: Frame
  at: DropTarget | string | null
}

/** May a library item be copied into this frame? */
export function canInsertInto(s: StoreState, frame: Frame | undefined, sourceFrameId?: string): frame is Frame {
  if (!frame || !s.canvas || !canEditOpenCanvas(s)) return false
  return frame.id !== sourceFrameId && !frame.locked && !frame.htmlDeferred && !isCanvasElement(frame.html)
}

/** The frame a click would insert into: the selected one on the open
 *  canvas, editable, unlocked, a real frame (not a standalone shape), and
 *  not the frame the item comes from. */
export function insertTarget(s: StoreState, sourceFrameId?: string): InsertTarget | null {
  const frameId = s.selectedElement?.frameId ?? s.selectedId
  const frame = frameId ? s.canvas?.frames.find((f) => f.id === frameId) : undefined
  if (!canInsertInto(s, frame, sourceFrameId)) return null
  const picked = s.selectedElement?.frameId === frame.id ? pickedSelectors(s) : []
  return { frame, at: picked.at(-1) ?? null }
}

/** What a click on a result row does. */
export type RowAction = { kind: 'insert'; target: InsertTarget } | { kind: 'go' }

/** Click inserts only for a library item while a frame is selected; ⇧ (or
 *  anything else) goes to the item. */
export function rowAction(s: StoreState, source: InsertSource, shift: boolean): RowAction {
  if (shift || !isLibraryItem(source)) return { kind: 'go' }
  const target = insertTarget(s, source.frameId)
  return target ? { kind: 'insert', target } : { kind: 'go' }
}

/** The footer line under the results. */
export type FooterHint = { kind: 'insert'; frameName: string } | { kind: 'select' } | { kind: 'go' } | { kind: 'none' }

export function footerHint(s: StoreState, source: InsertSource | null): FooterHint {
  if (!source) return { kind: 'none' }
  if (!isLibraryItem(source)) return { kind: 'go' }
  const target = insertTarget(s, source.frameId)
  return target ? { kind: 'insert', frameName: target.frame.name } : { kind: 'select' }
}

/* ---- the copy ---- */

export { REF_ATTR, refId, libraryBlock }

/* what the library's own editor state says about an element does not hold
   in the frame it lands in: comments, links, locks, prototype wiring,
   component instances */
const KEPT_DOOP_ATTRS = new Set([REF_ATTR, REF_LIB_ATTR, REF_REV_ATTR, 'data-doop-name', 'data-doop-ref-style'])

function placeBlock(html: string, at: DropTarget | string | null, block: string) {
  if (at && typeof at !== 'string') return placeElement(html, at, block)
  const inserted = insertElements(html, at, block)
  const selector = inserted?.selectors[0]
  return inserted && selector ? { html: inserted.html, selector } : null
}

/** Insert the block at `at` (a drop slot, after a selector, else at the end
 *  of the body), give every element in it a fresh `data-doop-id`, and
 *  return the new HTML with the block's selector. A slot that cannot take a
 *  block (inside a `<p>`) falls back to the end of the body. */
export function insertLibraryBlock(
  html: string,
  at: DropTarget | string | null,
  block: string,
): { html: string; selector: string; elementId: string } | null {
  const inserted = placeBlock(html, at, block) ?? (at ? placeBlock(html, null, block) : null)
  if (!inserted) return null
  const selector = inserted.selector
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
  return {
    html: '<!doctype html>\n' + doc.documentElement.outerHTML,
    selector,
    elementId: root.getAttribute(ELEMENT_ID_ATTR) ?? '',
  }
}

/** What an insert did, for the notice and the box that follows it. */
export interface InsertedItem {
  frameId: string
  selector: string
  /** the block's own `data-doop-id`, which finds it after later edits */
  elementId: string
  ref: string
  /** the library canvas and the item's revision, when the index gave the item */
  libraryId?: string
  rev?: number
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
  focus: ItemFocus
  ref: string
  target: InsertTarget
  libraryId?: string
  rev?: number
}): Promise<InsertedItem | null> {
  const snap = await snapshotLibraryItem(opts.sourceFrameId, opts.focus)
  if (!snap) return null
  const s = useStore.getState()
  /* the frame as it stands now: it may have changed while the item rendered */
  const frame = s.canvas?.frames.find((f) => f.id === opts.target.frame.id)
  if (!frame || frame.locked || frame.htmlDeferred) return null
  const ref = refId(opts.ref)
  const block = libraryBlock(snap, {
    ref,
    ...(opts.libraryId ? { libraryId: opts.libraryId } : {}),
    ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
    prefix: `${ref}-${Math.random().toString(36).slice(2, 7)}-`,
  })
  const done = insertLibraryBlock(frame.html, opts.target.at, block)
  if (!done) return null
  saveFrameHtml(frame, done.html)
  s.select(frame.id)
  s.pickElement({ frameId: frame.id, selector: done.selector }, true)
  return {
    frameId: frame.id,
    selector: done.selector,
    elementId: done.elementId,
    ref,
    ...(opts.libraryId ? { libraryId: opts.libraryId } : {}),
    ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
    found: snap.found,
    scripted: snap.scripted,
    approvalWithdrawn: frame.approval?.status === 'ready_for_dev',
    before: frame.html,
  }
}

/** Take an inserted block out again (the box's Undo), found by its own id so
 *  edits made since keep their place. One undo step, like the insert. */
export function removeInsertedBlock(item: Pick<InsertedItem, 'frameId' | 'elementId'>): boolean {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === item.frameId)
  if (!frame || frame.locked || !item.elementId) return false
  const html = removeElements(frame.html, [elementIdSelector(item.elementId)])
  if (!html) return false
  saveFrameHtml(frame, html)
  useStore.getState().pickElement(null)
  return true
}

/** The chat line Adapter sends: the block named by its reference and its
 *  element link, the instruction, and the structure to keep. */
export function adaptRequest(
  item: Pick<InsertedItem, 'ref' | 'frameId' | 'elementId'>,
  opts: { canvasId: string; frameName: string; instruction: string; fallback: string },
): string {
  const instruction = opts.instruction.trim() || opts.fallback
  const link = `/c/${opts.canvasId}?frame=${item.frameId}&element=${item.elementId}`
  return `Adapt [${REF_ATTR}=${item.ref}] in the frame “${opts.frameName}” (${link}): ${instruction}; keep the structure.`
}
