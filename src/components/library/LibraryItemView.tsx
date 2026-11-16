import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SHARED_EXPAND } from '../../lib/sharedExpand'
import type { LibraryItemDetail, LibraryItemPatch, LibraryItemSummary } from '../../../shared/library'
import { api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Pressable } from '../ui/pressable'
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ItemDetails, ItemFindings } from './ItemDetails'
import { copyItemId, MAX_LIVE_VARIANTS, VariantCard } from './VariantCard'

/** Which of `ids` may show a live preview: the first twelve in view (all
 *  in view when the browser cannot tell). */
function useLiveVariants(ids: string[], root: React.RefObject<HTMLElement | null>): Set<string> {
  const [inView, setInView] = useState<Set<string> | null>(null)
  useEffect(() => {
    const el = root.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const seen = new Set<string>()
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.variantId
        if (!id) continue
        if (entry.isIntersecting) seen.add(id)
        else seen.delete(id)
      }
      setInView(new Set(seen))
    })
    for (const card of el.querySelectorAll('[data-variant-id]')) io.observe(card)
    return () => io.disconnect()
  }, [ids, root])
  const candidates = inView ? ids.filter((id) => inView.has(id)) : ids
  return new Set(candidates.slice(0, MAX_LIVE_VARIANTS))
}

/**
 * One item with every variant side by side: its head (id, label, kind,
 * status, source and licence, category), the variants as live previews (at
 * most twelve), its details (editable by curators) and its findings.
 */
export function LibraryItemView({
  libraryId,
  itemId,
  curator,
  onClose,
  renderUse,
}: {
  libraryId: string
  itemId: string
  curator: boolean
  /** a Sheet over the gallery when set; a page otherwise */
  onClose?: () => void
  /** the "Use" control for an item, when the view can insert */
  renderUse?: (item: LibraryItemSummary) => ReactNode
}) {
  const t = useT()
  const [detail, setDetail] = useState<LibraryItemDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stale = false
    api
      .libraryItem(libraryId, itemId)
      .then((d) => {
        if (!stale) setDetail(d)
      })
      .catch(() => {
        if (!stale) setMissing(true)
      })
    return () => {
      stale = true
    }
  }, [libraryId, itemId])

  const variants = detail?.variants ?? []
  const live = useLiveVariants(
    variants.map((v) => v.id),
    grid,
  )

  async function save(patch: LibraryItemPatch) {
    const next = await api.setLibraryItemMeta(libraryId, itemId, patch)
    if (next) setDetail(next)
  }

  const item = detail?.item
  const body = !item ? (
    <p className="text-copy text-ink-faint">{missing ? t('library.itemNotFound') : t('library.loading')}</p>
  ) : (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <Pressable
          className="self-start font-mono text-caption text-ink-faint"
          aria-label={t('library.copyId')}
          onClick={() => copyItemId(item.id, setCopied)}
        >
          {item.id}
        </Pressable>
        <SheetTitleOrHeading sheet={!!onClose}>{item.label}</SheetTitleOrHeading>
        <div className="flex flex-wrap items-center gap-1.5 text-caption text-ink-faint">
          {item.kind && <Badge>{item.kind}</Badge>}
          {item.status !== 'active' && <Badge tone="outline">{t(`library.status_${item.status}`)}</Badge>}
          <span>{item.category.split('/').join(' › ')}</span>
          {item.sourceUrl && (
            <a className="underline-offset-2 hover:underline" href={item.sourceUrl} target="_blank" rel="noreferrer">
              {new URL(item.sourceUrl).host}
            </a>
          )}
          {item.license && <span>{item.license}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          {renderUse?.(item)}
          <Button size="sm" onClick={() => navigate(`/c/${libraryId}?frame=${item.frameId}`)}>
            {t('library.openInCanvas')}
          </Button>
          {curator && item.mode !== 'component' && (
            <Button
              size="sm"
              onClick={() =>
                void api
                  .promoteLibraryItem(libraryId, item.id)
                  .then(() => setCopied(null))
                  .then(() => api.libraryItem(libraryId, itemId).then(setDetail))
                  .catch(() => {})
              }
            >
              {t('library.promote')}
            </Button>
          )}
        </div>
        {copied && <p className="text-caption text-ink-faint">{t('library.copiedId', { id: copied })}</p>}
      </header>
      <Tabs defaultValue="variants" className="min-h-0">
        <TabsList>
          <TabsTrigger value="variants">{t('library.tabVariants', { count: variants.length })}</TabsTrigger>
          <TabsTrigger value="details">{t('library.tabDetails')}</TabsTrigger>
          <TabsTrigger value="findings">{t('library.tabFindings')}</TabsTrigger>
          <TabsTrigger value="used">{t('library.tabUsed')}</TabsTrigger>
        </TabsList>
        <TabsContent value="variants" forceMount className="mt-3 data-[state=inactive]:hidden">
          <div
            ref={grid}
            className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
            style={{ viewTransitionName: SHARED_EXPAND }}
          >
            {(variants.length ? variants : [item]).map((v) => (
              <VariantCard
                key={v.id}
                item={v}
                live={live.has(v.id)}
                scriptedNote={t('library.staticOnceInserted')}
                onCopied={setCopied}
                actions={renderUse?.(v)}
              />
            ))}
          </div>
        </TabsContent>
        <TabsContent value="details" className="mt-3">
          <ItemDetails key={item.id} item={item} curator={curator} onSave={save} />
        </TabsContent>
        <TabsContent value="findings" className="mt-3">
          <ItemFindings item={item} />
        </TabsContent>
        <TabsContent value="used" className="mt-3 text-copy text-ink-soft">
          {t('library.usedCount', { count: item.useCount })}
        </TabsContent>
      </Tabs>
    </div>
  )

  if (!onClose) return <div data-testid="library-item-view">{body}</div>
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[min(960px,100vw)] overflow-y-auto p-5 sm:max-w-none">
        <div data-testid="library-item-view">{body}</div>
      </SheetContent>
    </Sheet>
  )
}

function SheetTitleOrHeading({ sheet, children }: { sheet: boolean; children: ReactNode }) {
  if (sheet) return <SheetTitle className="text-heading font-semibold text-ink">{children}</SheetTitle>
  return <h2 className="text-heading font-semibold text-ink">{children}</h2>
}
