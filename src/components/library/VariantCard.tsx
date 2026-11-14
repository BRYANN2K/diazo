import type { ReactNode } from 'react'
import type { LibraryItemSummary } from '../../../shared/library'
import { focusOfItem } from '../../lib/findLibrary'
import { useT } from '../../lib/i18n'
import { IconButton } from '../ui/icon-button'
import { CopyIcon } from '../ui/icons'
import { FindPreview } from '../FindPreview'
import { ItemThumb } from './ItemThumb'

/** At most this many live previews in one item view; the rest stay images. */
export const MAX_LIVE_VARIANTS = 12

/** Copy an item id to the clipboard; true when the copy was asked. */
export function copyItemId(id: string, notice?: (text: string) => void): boolean {
  navigator.clipboard
    ?.writeText(id)
    .then(() => notice?.(id))
    .catch(() => {})
  return true
}

/**
 * One variant side by side with its siblings: its image, or a live
 * preview while it is one of the twelve in view, its id, a copy button and
 * the actions the view hands it ("Use"). ⌘C on the focused card copies the id.
 */
export function VariantCard({
  item,
  live,
  scriptedNote,
  actions,
  onCopied,
}: {
  item: LibraryItemSummary
  live: boolean
  /** shown on a scripted variant: the copy is a still */
  scriptedNote?: string
  actions?: ReactNode
  onCopied?: (id: string) => void
}) {
  const t = useT()
  return (
    <div
      tabIndex={0}
      data-variant-id={item.id}
      className="flex flex-col overflow-hidden rounded-card bg-surface shadow-ring outline-none focus-visible:ring-2 focus-visible:ring-brand"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && e.currentTarget === e.target) {
          e.preventDefault()
          copyItemId(item.id, onCopied)
        }
      }}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-sub">
        {live ? <FindPreview frameId={item.frameId} focus={focusOfItem(item)} /> : <ItemThumb item={item} />}
        {scriptedNote && item.scripted && (
          <span className="absolute right-1.5 bottom-1.5 rounded-tag bg-surface/90 px-1.5 py-0.5 text-micro text-ink-soft shadow-ring">
            {scriptedNote}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink-soft">{item.id}</span>
        <IconButton size="sm" aria-label={t('library.copyId')} onClick={() => copyItemId(item.id, onCopied)}>
          <CopyIcon width={13} height={13} aria-hidden />
        </IconButton>
        {actions}
      </div>
    </div>
  )
}
