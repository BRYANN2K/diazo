import { create } from 'zustand'
import type { InsertedItem } from './findInsert'
import { useStore } from './store'
import { elementIdSelector } from '../../shared/elementId'

/** The block ⌘F just inserted, while its Adapt box is open. Lives outside
 *  the find bar, so closing ⌘F keeps the box on the canvas. */
export const useInsertedBox = create<{
  item: InsertedItem | null
  open(item: InsertedItem): void
  close(): void
}>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}))

/** A block the server inserted (the gallery's "Use"): pick it on the open
 *  canvas and open its box, as an insert from ⌘F does. */
export function pickInsertedBlock(link: { frameId: string; elementId: string; ref: string }): void {
  const s = useStore.getState()
  const frame = s.canvas?.frames.find((f) => f.id === link.frameId)
  if (!frame) return
  const selector = elementIdSelector(link.elementId)
  s.select(frame.id)
  s.pickElement({ frameId: frame.id, selector }, true)
  s.requestFlyTo(frame.id)
  useInsertedBox.getState().open({
    frameId: frame.id,
    selector,
    elementId: link.elementId,
    ref: link.ref,
    found: true,
    scripted: false,
    approvalWithdrawn: false,
    before: '',
  })
}
