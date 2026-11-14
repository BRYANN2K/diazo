import { useEffect, useState } from 'react'
import type { LibraryItemSummary, LibraryListEntry } from '../../../shared/library'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Pressable } from '../ui/pressable'
import { MetaLine, Tile, TileBody, TileCover } from '../ui/tile'
import { ItemThumb } from './ItemThumb'

/** One library on the Libraries page: four of its items as the cover, its
 *  name, and how many families and variants it holds. */
export function LibraryTile({
  library,
  onOpen,
  covers,
}: {
  library: LibraryListEntry
  onOpen: () => void
  /** the cover items; fetched when left out */
  covers?: LibraryItemSummary[]
}) {
  const t = useT()
  const [fetched, setFetched] = useState<LibraryItemSummary[] | null>(null)
  useEffect(() => {
    if (covers) return
    let stale = false
    api
      .libraryItems(library.id, { limit: 4 })
      .then((r) => {
        if (!stale) setFetched(r.hits.map((h) => h.item))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [library.id, covers])
  const items = covers ?? fetched ?? []
  return (
    <Tile data-library-id={library.id}>
      <Pressable onClick={onOpen} aria-label={library.name}>
        <TileCover aspect="16/10" className="grid-cols-2 grid-rows-2 gap-px p-px">
          {items.slice(0, 4).map((item) => (
            <span key={item.id} className="h-full w-full overflow-hidden bg-surface">
              <ItemThumb item={item} />
            </span>
          ))}
        </TileCover>
        <TileBody>
          <div className="truncate font-display text-copy font-semibold">{library.name}</div>
          <MetaLine className="mt-[7px]">
            <span>{t('library.countFamilies', { count: library.library.items })}</span>
            <span>{t('library.countVariants', { count: library.library.variants })}</span>
            <span>{t(`library.role_${library.role}`)}</span>
          </MetaLine>
        </TileBody>
      </Pressable>
    </Tile>
  )
}
