import { create } from 'zustand'
import type { InsertedItem } from './findInsert'

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
