import { useState } from 'react'
import type { ItemBox, LibraryItemSummary } from '../../../shared/library'
import { cn } from '@/lib/utils'
import { FramePreview } from '../FramePreview'

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

/**
 * A library item's image: its own thumbnail when the server has one, else
 * the frame's preview cropped to the item's box with CSS, else the frame's
 * preview as it is (FramePreview's empty and failed states included). Never
 * an iframe.
 */
export function ItemThumb({ item, className }: { item: LibraryItemSummary; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const own = item.thumb && !item.thumb.startsWith('/i/') && failed !== item.thumb
  if (own) {
    return (
      <img
        src={item.thumb}
        alt=""
        loading="lazy"
        className={cn('h-full w-full object-contain', className)}
        onError={() => setFailed(item.thumb)}
      />
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
