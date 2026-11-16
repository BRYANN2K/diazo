import { create } from 'zustand'
import type { Composition } from '../../../shared/motion'

/** a collaborator's playhead on a page's film (presence, like a cursor) */
export interface PeerPlayhead {
  clientId: string
  pageId: string
  t: number
  playing: boolean
  at: number
}

interface MotionState {
  /** each page's timeline, as the room last told it (null: the page has none) */
  compositions: Record<string, Composition | null>
  /** whether the room has said anything yet — before it does, the timeline
   *  asks REST */
  seeded: boolean
  playheads: Record<string, PeerPlayhead>
  seed(compositions: readonly Composition[]): void
  setComposition(pageId: string, composition: Composition | null): void
  setPlayhead(playhead: Omit<PeerPlayhead, 'at'>): void
  reset(): void
}

/**
 * Motion Studio's slice of the room: `init.canvas.compositions`, then every
 * `composition` and `composition:playhead` message (src/lib/ws.ts), so every
 * open timeline follows the others live.
 */
export const useMotionStore = create<MotionState>((set) => ({
  compositions: {},
  seeded: false,
  playheads: {},
  seed: (compositions) =>
    set({
      seeded: true,
      playheads: {},
      compositions: Object.fromEntries(compositions.map((comp) => [comp.pageId, comp])),
    }),
  setComposition: (pageId, composition) =>
    set((s) => {
      const current = s.compositions[pageId]
      /* never step back to an older revision a slow REST answer brings */
      if (composition && current && current.id === composition.id && current.revision > composition.revision) return s
      return { compositions: { ...s.compositions, [pageId]: composition } }
    }),
  setPlayhead: (playhead) =>
    set((s) => ({ playheads: { ...s.playheads, [playhead.clientId]: { ...playhead, at: Date.now() } } })),
  reset: () => set({ compositions: {}, seeded: false, playheads: {} }),
}))
