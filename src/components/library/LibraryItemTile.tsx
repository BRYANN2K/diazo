import { useEffect, useRef } from 'react'
import type { LibraryItemSummary } from '../../../shared/library'
import { focusOfItem } from '../../lib/findLibrary'
import { useT } from '../../lib/i18n'
import { Badge } from '../ui/badge'
import { Pressable } from '../ui/pressable'
import { Tile, TileBody, TileCover } from '../ui/tile'
import { FindPreview } from '../FindPreview'
import { ItemThumb } from './ItemThumb'
import { sharedExpand } from '../../lib/sharedExpand'

/** How long the pointer rests on a tile before its live preview loads. */
export const LIVE_HOVER_MS = 400

/**
 * One family in the gallery: its image (a live preview only while it is the
 * one hovered), its id, label, variant count and, for curators, its status.
 */
export function LibraryItemTile({
  item,
  variantCount,
  curator,
  live,
  onHover,
  onOpen,
  onPointerDown,
}: {
  item: LibraryItemSummary
  variantCount: number
  /** may curate: draft and hidden items show their badge */
  curator: boolean
  /** this tile shows the gallery's one live preview */
  live: boolean
  /** the pointer rested on the tile (the item id), or left it (null) */
  onHover: (itemId: string | null) => void
  onOpen: (e: React.MouseEvent) => void
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void
}) {
  const t = useT()
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const showStatus = item.status === 'deprecated' || (curator && (item.status === 'draft' || item.status === 'hidden'))
  return (
    <Tile
      data-item-id={item.id}
      onMouseEnter={() => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => onHover(item.id), LIVE_HOVER_MS)
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current)
        onHover(null)
      }}
    >
      <Pressable
        onClick={(e) => {
          /* a plain click grows the cover into the item view; a modified
             click (new tab, new window) opens as before */
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return onOpen(e)
          sharedExpand(e.currentTarget.querySelector('[data-slot=tile-cover]'), () => onOpen(e))
        }}
        onPointerDown={onPointerDown}
        aria-label={item.label}
      >
        <TileCover aspect="4/3">
          {live ? <FindPreview frameId={item.frameId} focus={focusOfItem(item)} /> : <ItemThumb item={item} />}
        </TileCover>
        <TileBody>
          <div className="truncate text-body font-medium text-ink">{item.label}</div>
          <div className="truncate font-mono text-micro text-ink-3">{item.id}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {variantCount > 0 && <Badge>{t('library.countVariants', { count: variantCount })}</Badge>}
            {showStatus && <Badge tone="outline">{t(`library.status_${item.status}`)}</Badge>}
          </div>
        </TileBody>
      </Pressable>
    </Tile>
  )
}
