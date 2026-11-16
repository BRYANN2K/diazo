import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Frame } from '../../shared/types'
import { cn } from '@/lib/utils'
import { framePreviews, previewWidth, type FramePreviewCache, type PreviewExt } from '@/lib/framePreviews'
import { CAMERA_SETTLE_MS } from '@/lib/layoutZoom'
import { useStore } from '@/lib/store'

/** How long a preview over a live frame takes to fade once its document shows. */
const UNCOVER_MS = 160

function useFramePreview(cache: FramePreviewCache, id: string) {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(id, listener), [cache, id])
  const snapshot = useCallback(() => cache.snapshot(id), [cache, id])
  return useSyncExternalStore(subscribe, snapshot)
}

/**
 * A frame drawn as a picture instead of a document (frameLod.ts): the
 * server's render of its design at about its on-screen width, from the
 * shared preview cache. While none has arrived a page shows a neutral well
 * (never the white of an empty document); a picture of an older version
 * stays up while the new one loads. `fetch` false only shows what the cache
 * already holds: frames off screen, and a live frame whose document is still
 * loading (`covering`, which fades the picture out once it has).
 * The frame's HTML is never read, so a deferred frame stays deferred.
 */
export function FrameImage({
  frame,
  ext,
  fetch = true,
  covering,
  cache = framePreviews,
}: {
  frame: Pick<Frame, 'id' | 'width' | 'updatedAt'>
  /** png keeps a standalone shape's transparency; pages go as jpeg */
  ext: PreviewExt
  fetch?: boolean
  /** over a live document: true until it shows, then the picture fades */
  covering?: boolean
  cache?: FramePreviewCache
}) {
  const { entry, status } = useFramePreview(cache, frame.id)
  /* the step only changes at a few zoom thresholds, so this re-renders
     rarely, and never for a frame that does not fetch (off screen, under a
     live document); the request waits for the camera to settle */
  const width = useStore((s) => (fetch ? previewWidth(frame.width, s.viewport.zoom, window.devicePixelRatio || 1) : 0))
  useEffect(() => {
    if (!fetch || !width) return
    let release = () => {}
    const timer = window.setTimeout(() => {
      release = cache.request({ id: frame.id, version: frame.updatedAt, width, ext })
    }, CAMERA_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      release()
    }
  }, [cache, fetch, frame.id, frame.updatedAt, width, ext])

  /* uncovered: keep the picture a moment for the fade, then let it go */
  const [gone, setGone] = useState(false)
  const [wasCovering, setWasCovering] = useState(covering)
  if (covering !== wasCovering) {
    setWasCovering(covering)
    setGone(false)
  }
  useEffect(() => {
    if (covering !== false) return
    const timer = window.setTimeout(() => setGone(true), UNCOVER_MS)
    return () => window.clearTimeout(timer)
  }, [covering])

  if (covering !== undefined && (gone || !entry)) return null
  return (
    <div
      data-frame-image={entry ? 'ready' : status}
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden',
        /* the well a page waits in; a shape is see-through, so it waits unseen */
        !entry && ext === 'jpg' && 'bg-paper-deep',
        covering === false && 'opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
      )}
    >
      {entry && (
        /* a new version swaps the src in place: it is decoded already, and
           a fresh element would fade in over the frame's white */
        <img
          src={entry.src}
          alt=""
          decoding="async"
          draggable={false}
          className={cn(
            'block w-full select-none',
            covering === undefined && 'animate-in fade-in-0 duration-150 motion-reduce:animate-none',
          )}
        />
      )}
    </div>
  )
}
