import { useEffect, useRef, useState } from 'react'
import type { ItemBox, LibraryItemSummary } from '../../../shared/library'
import { cn } from '@/lib/utils'
import { loadThumb, MAX_TRIES, retryDelay } from '@/lib/thumbLoader'
import { FramePreview } from '../FramePreview'
import { Skeleton } from '../ui/skeleton'

/** How to show `box` of a frame `frame` wide and high from the frame's
 *  preview image: the image's size and offset, in percent of the box. */
export function cropStyle(box: ItemBox, frame: { w: number; h: number }) {
  const w = Math.max(1, box.w)
  const h = Math.max(1, box.h)
  return {
    width: `${(frame.w / w) * 100}%`,
    height: `${(frame.h / h) * 100}%`,
    left: `${(-box.x / w) * 100}%`,
    top: `${(-box.y / h) * 100}%`,
  }
}

/** How far outside the viewport a tile starts loading. */
const NEAR = '200px'

interface ThumbState {
  url: string | null
  /** an object URL of the loaded picture */
  src: string | null
  status: 'loading' | 'ready' | 'failed'
  /** tries made so far (the first one included once it answered busy) */
  attempt: number
}

const fresh = (url: string | null): ThumbState => ({ url, src: null, status: 'loading', attempt: 0 })

/** Whether `el` is on (or near) the screen; always true where the browser
 *  cannot tell. */
function useNearScreen(el: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = el.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: NEAR,
    })
    io.observe(node)
    return () => io.disconnect()
  }, [el])
  return near
}

/**
 * The item's own thumbnail: loaded while the tile is on screen, a skeleton
 * until then; a busy server (503) is asked again after its Retry-After,
 * with backoff, a few times; a real failure (404, 500) or too many busy
 * answers settle on `failed`.
 */
function useOwnThumb(url: string | null, near: boolean): ThumbState {
  const [state, setState] = useState<ThumbState>(() => fresh(url))
  let current = state
  if (state.url !== url) {
    current = fresh(url)
    setState(current)
  }
  const { status, attempt, src } = current

  useEffect(() => {
    if (!url || !near || status !== 'loading') return
    const ctl = new AbortController()
    let timer: number | undefined
    loadThumb(url, ctl.signal).then(
      (load) => {
        if (ctl.signal.aborted) return
        if (load.kind === 'ok') {
          const next = URL.createObjectURL(load.blob)
          setState((s) => (s.url === url ? { ...s, src: next, status: 'ready' } : s))
        } else if (load.kind === 'busy' && attempt + 1 < MAX_TRIES) {
          timer = window.setTimeout(
            () => setState((s) => (s.url === url ? { ...s, attempt: attempt + 1 } : s)),
            retryDelay(attempt + 1, load.retryAfterMs),
          )
        } else setState((s) => (s.url === url ? { ...s, status: 'failed' } : s))
      },
      () => {
        /* aborted: off screen or unmounted; asked again once back */
      },
    )
    return () => {
      ctl.abort()
      window.clearTimeout(timer)
    }
  }, [url, near, status, attempt])

  useEffect(() => (src ? () => URL.revokeObjectURL(src) : undefined), [src])
  return current
}

/**
 * A library item's image: its own thumbnail (a skeleton while it loads or
 * the server draws it), else, when that really fails, the frame's preview
 * cropped to the item's box with CSS, else the frame's preview as it is
 * (FramePreview's empty and failed states included). Never an iframe.
 */
export function ItemThumb({ item, className }: { item: LibraryItemSummary; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const near = useNearScreen(ref)
  const url = item.thumb && !item.thumb.startsWith('/i/') ? item.thumb : null
  const own = useOwnThumb(url, near)
  if (url && own.status !== 'failed') {
    return (
      <span ref={ref} className={cn('relative block h-full w-full', className)} data-thumb={own.status}>
        {own.src ? (
          <img src={own.src} alt="" className="h-full w-full object-contain" />
        ) : (
          <Skeleton aria-hidden className="absolute inset-0 rounded-none" />
        )}
      </span>
    )
  }
  if (item.box && item.frameSize) {
    const style = cropStyle(item.box, item.frameSize)
    return (
      <span className={cn('relative block h-full w-full overflow-hidden', className)} data-crop="frame">
        <img
          src={`/i/${item.frameId}.jpg?preview`}
          alt=""
          loading="lazy"
          className="absolute max-w-none"
          style={style}
        />
      </span>
    )
  }
  return <FramePreview frameId={item.frameId} empty={null} className={className} />
}
