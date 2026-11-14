import { useEffect, useState, type RefObject } from 'react'

/** The slice of a long list or grid worth rendering: the rows in view plus
 *  a few on each side, with the space the rest would take above and below. */
export interface WindowedSlice {
  /** first index to render */
  start: number
  /** one past the last index to render */
  end: number
  /** px of the rows above, kept as padding so the scrollbar stays true */
  before: number
  /** px of the rows below */
  after: number
}

/** Which rows of `rows` rows of `rowHeight` px are in a viewport. Pure. */
export function windowSlice(
  count: number,
  view: { top: number; height: number },
  opts: { rowHeight: number; columns?: number; overscan?: number },
): WindowedSlice {
  const columns = Math.max(1, opts.columns ?? 1)
  const overscan = opts.overscan ?? 4
  const rows = Math.ceil(count / columns)
  const first = Math.max(0, Math.floor(view.top / opts.rowHeight) - overscan)
  const last = Math.min(rows, Math.ceil((view.top + view.height) / opts.rowHeight) + overscan)
  return {
    start: first * columns,
    end: Math.min(count, last * columns),
    before: first * opts.rowHeight,
    after: Math.max(0, rows - last) * opts.rowHeight,
  }
}

/**
 * A windowed list or grid over the element `scrollRef` scrolls: only what is
 * near the viewport is rendered. No dependency, rows of one fixed height.
 */
export function useWindowedGrid(
  count: number,
  scrollRef: RefObject<HTMLElement | null>,
  opts: { rowHeight: number; columns?: number; overscan?: number; enabled?: boolean },
): WindowedSlice {
  const [view, setView] = useState({ top: 0, height: 600 })
  const enabled = opts.enabled ?? true
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight || 600 })
    el.addEventListener('scroll', read, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro?.disconnect()
    }
  }, [scrollRef, enabled])
  if (!enabled) return { start: 0, end: count, before: 0, after: 0 }
  return windowSlice(count, view, opts)
}
