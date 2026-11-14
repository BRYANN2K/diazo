import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryDetail, LibrarySearchHit, LibrarySearchResult } from '../../shared/library'
import { api } from '../lib/api'
import { navigate } from '../lib/navigate'
import { useT } from '../lib/i18n'
import {
  EMPTY_QUERY,
  galleryQueryString,
  parseGalleryQuery,
  staleGuard,
  type GalleryQuery,
  type GallerySort,
} from '../lib/libraryQuery'
import { AppRail, railLayout } from '../components/AppRail'
import { LibraryFacets } from '../components/library/LibraryFacets'
import { LibraryGrid } from '../components/library/LibraryGrid'
import { LibraryItemTile } from '../components/library/LibraryItemTile'
import { LibraryItemView } from '../components/library/LibraryItemView'
import { UseItemButton, type GalleryOrigin } from '../components/library/UseItemButton'
import { Button } from '../components/ui/button'
import { MenuButton } from '../components/ui/menu-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet'
import { LibrarySettings } from '../components/library/LibrarySettings'
import { LibraryInbox } from '../components/library/LibraryInbox'
import { Badge } from '../components/ui/badge'
import { Kbd } from '../components/ui/kbd'
import { SearchField } from '../components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { DashContent, DashHeader, DashLayout, DashMain, DashTitle } from '../components/ui/dash'

const PAGE = 60

/** Where the gallery was opened from: a canvas and its selected frame. */
export function galleryOrigin(search: string): GalleryOrigin | null {
  const p = new URLSearchParams(search)
  const from = p.get('from')
  return from ? { from, frame: p.get('frame'), frameName: p.get('fname') } : null
}

/**
 * One library's gallery (`/l/<id>`): its families, filtered by kind,
 * category and search, 60 at a time in a windowed grid. Images only; one
 * live preview for the tile the pointer rests on. The view lives in the URL.
 */
export function LibraryPage({ libraryId, itemId }: { libraryId: string; itemId: string | null }) {
  const t = useT()
  const [detail, setDetail] = useState<LibraryDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState<GalleryQuery>(() => ({ ...EMPTY_QUERY, ...parseGalleryQuery(location.search) }))
  const [result, setResult] = useState<{
    hits: LibrarySearchHit[]
    facets: LibrarySearchResult['facets']
    total: number
    cursor?: string
  } | null>(null)
  const [live, setLive] = useState<string | null>(null)
  const [panel, setPanel] = useState<'settings' | 'inbox' | null>(null)
  const [drafts, setDrafts] = useState(0)
  const guard = useRef(staleGuard())
  const asked = useRef(new Set<string>())
  const searchRef = useRef<HTMLInputElement>(null)
  const origin = galleryOrigin(location.search)

  useEffect(() => {
    api
      .getLibraryDetail(libraryId)
      .then(setDetail)
      .catch(() => setMissing(true))
  }, [libraryId])

  /* the view in the URL, without a history entry per keystroke */
  const from = origin?.from ?? null
  const fromFrame = origin?.frame ?? null
  const fromName = origin?.frameName ?? null
  useEffect(() => {
    history.replaceState(
      null,
      '',
      `${location.pathname}${galleryQueryString(query, { from, frame: fromFrame, fname: fromName })}`,
    )
  }, [query, from, fromFrame, fromName])

  const fetchPage = useCallback(
    (cursor?: string) => {
      const token = guard.current.next()
      return api
        .libraryItems(libraryId, {
          q: query.q,
          ...(query.kind ? { kind: [query.kind] } : {}),
          ...(query.in ? { category: [query.in] } : {}),
          ...(query.tag ? { tag: [query.tag] } : {}),
          ...(query.sort !== 'relevance' ? { sort: query.sort } : {}),
          ...(detail && detail.role !== 'read' ? { status: 'draft' as const } : {}),
          limit: PAGE,
          ...(cursor ? { cursor } : {}),
        })
        .then((r) => {
          if (!guard.current.isCurrent(token)) return
          setResult((prev) =>
            cursor && prev
              ? { hits: [...prev.hits, ...r.hits], facets: prev.facets, total: r.total, cursor: r.cursor }
              : { hits: r.hits, facets: r.facets, total: r.total, cursor: r.cursor },
          )
        })
    },
    [libraryId, query, detail],
  )

  useEffect(() => {
    /* the role decides whether drafts are asked for: wait for it */
    if (!detail) return
    asked.current = new Set()
    const timer = window.setTimeout(() => void fetchPage().catch(() => {}), query.q ? 150 : 0)
    return () => window.clearTimeout(timer)
  }, [fetchPage, query.q, detail])

  const loadMore = useCallback(() => {
    const cursor = result?.cursor
    if (!cursor || asked.current.has(cursor)) return
    asked.current.add(cursor)
    void fetchPage(cursor).catch(() => asked.current.delete(cursor))
  }, [result?.cursor, fetchPage])

  /* ⌘F focuses the gallery's own search */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const set = (patch: Partial<GalleryQuery>) => setQuery((q) => ({ ...q, ...patch }))
  const curator = !!detail && detail.role !== 'read'
  useEffect(() => {
    if (!curator) return
    let stale = false
    api
      .libraryInbox(libraryId)
      .then((r) => {
        if (!stale) setDrafts(r.drafts)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [curator, libraryId, panel])
  const itemPath = (id: string) => `/l/${libraryId}/i/${encodeURIComponent(id)}${location.search}`

  return (
    <DashLayout className={railLayout}>
      <AppRail active="libraries" />
      <DashMain className="flex min-h-0 flex-col [background:var(--paper)]">
        <DashHeader variant="bare">
          <SearchField
            ref={searchRef}
            size="header"
            value={query.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder={t('library.searchPlaceholder')}
            aria-label={t('library.searchPlaceholder')}
            trailing={<Kbd>⌘F</Kbd>}
          />
          <span className="flex-1" />
          <Select value={query.sort} onValueChange={(sort) => set({ sort: sort as GallerySort })}>
            <SelectTrigger size="sm" className="w-36" aria-label={t('library.sort')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">{t('library.sortRelevance')}</SelectItem>
              <SelectItem value="used">{t('library.sortUsed')}</SelectItem>
              <SelectItem value="newest">{t('library.sortNewest')}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="bar" onClick={() => navigate(`/c/${libraryId}`)}>
            {t('library.openCanvas')}
          </Button>
          {curator && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MenuButton aria-label={t('library.menu')}>
                  {t('library.menu')}
                  {drafts > 0 && (
                    <Badge tone="accent" data-testid="inbox-badge">
                      {drafts}
                    </Badge>
                  )}
                </MenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent width="md" align="end">
                {detail?.role === 'manage' && (
                  <DropdownMenuItem onSelect={() => setPanel('settings')}>{t('library.settings')}</DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setPanel('inbox')}>
                  {drafts ? t('library.inboxCount', { count: drafts }) : t('library.inbox')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void api.reindexLibrary(libraryId)}>
                  {t('library.reindex')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </DashHeader>
        <DashContent className="flex min-h-0 flex-1 flex-col pt-2 md:pt-3">
          <DashTitle className="mb-4">{detail?.name ?? (missing ? t('library.notFound') : '')}</DashTitle>
          <div className="flex min-h-0 flex-1 gap-6">
            <LibraryFacets
              kinds={result?.facets.kind ?? []}
              categories={result?.facets.category ?? []}
              kind={query.kind}
              category={query.in}
              onKind={(kind) => set({ kind })}
              onCategory={(category) => set({ in: category })}
            />
            <LibraryGrid
              items={result?.hits ?? []}
              hasMore={!!result?.cursor}
              onEnd={loadMore}
              render={(hit) => (
                <LibraryItemTile
                  key={hit.item.id}
                  item={hit.item}
                  variantCount={hit.variantCount}
                  curator={curator}
                  live={live === hit.item.id}
                  onHover={setLive}
                  onOpen={() => navigate(itemPath(hit.item.id))}
                />
              )}
            />
          </div>
          {panel && detail && (
            <Sheet open onOpenChange={(open) => !open && setPanel(null)}>
              <SheetContent side="right" className="w-[min(1100px,100vw)] overflow-y-auto p-5 sm:max-w-none">
                <SheetTitle>{panel === 'settings' ? t('library.settings') : t('library.inbox')}</SheetTitle>
                {panel === 'settings' ? (
                  <LibrarySettings detail={detail} onChanged={() => void fetchPage().catch(() => {})} />
                ) : (
                  <LibraryInbox libraryId={libraryId} onChanged={() => void fetchPage().catch(() => {})} />
                )}
              </SheetContent>
            </Sheet>
          )}
          {itemId && (
            <LibraryItemView
              libraryId={libraryId}
              itemId={itemId}
              curator={curator}
              onClose={() => navigate(`/l/${libraryId}${location.search}`)}
              renderUse={(item) => <UseItemButton libraryId={libraryId} item={item} origin={origin} />}
            />
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
