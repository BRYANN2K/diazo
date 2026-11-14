import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useWindowedGrid } from '../../hooks/use-windowed-grid'

/** A tile's column width and row height in the gallery grid. */
export const TILE_MIN_WIDTH = 220
export const TILE_ROW_PX = 268
const GAP = 16

/**
 * The gallery's grid, windowed: only the rows near the viewport are in the
 * document, whatever the number of items. Asks for more once the last
 * rows come into view.
 */
export function LibraryGrid<T>({
  items,
  render,
  hasMore,
  onEnd,
}: {
  items: T[]
  render: (item: T) => ReactNode
  hasMore: boolean
  onEnd: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(960)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 960))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const columns = Math.max(1, Math.floor((width + GAP) / (TILE_MIN_WIDTH + GAP)))
  const slice = useWindowedGrid(items.length, scrollRef, { rowHeight: TILE_ROW_PX + GAP, columns, overscan: 2 })
  const nearEnd = slice.end >= items.length - columns
  useEffect(() => {
    if (nearEnd && hasMore) onEnd()
  }, [nearEnd, hasMore, onEnd])
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="library-grid">
      <div style={{ height: slice.before }} aria-hidden />
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: TILE_ROW_PX }}
      >
        {items.slice(slice.start, slice.end).map(render)}
      </div>
      <div style={{ height: slice.after }} aria-hidden />
    </div>
  )
}
