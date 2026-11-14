/**
 * ⌘F's insert: a library item found in the results lands, as a copy, in the
 * frame the person has selected. This module holds the rules (when a click
 * inserts rather than goes, which frame and where); the snapshot of the
 * item itself is taken inside the preview iframe.
 */
import type { Frame } from '../../shared/types'
import { isCanvasElement } from './drawing'
import { canEditOpenCanvas, pickedSelectors, useStore } from './store'

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
