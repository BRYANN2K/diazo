import { useEffect, useState } from 'react'
import type { LibraryListEntry, LibrarySearchHit, LibrarySearchResult } from '../../../shared/library'
import { api } from '../../lib/api'
import { focusOfItem, isInsertable } from '../../lib/findLibrary'
import { insertLibraryItem, insertTarget, type InsertTarget } from '../../lib/findInsert'
import { useInsertedBox } from '../../lib/insertedBox'
import { navigate } from '../../lib/navigate'
import { canEditOpenCanvas, useStore } from '../../lib/store'
import { useT } from '../../lib/i18n'
import { PanelBody } from '../ui/panel'
import { Pressable } from '../ui/pressable'
import { SearchField } from '../ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { ToggleChipGroup, ToggleChipItem } from '../ui/toggle-chip'
import { useFindDrag } from '../FindDrag'
import { ItemThumb } from './ItemThumb'

/** The library the panel shows, per browser. */
export const PANEL_STORAGE_KEY = 'doop:library-panel'

function readPick(): string | null {
  try {
    return localStorage.getItem(PANEL_STORAGE_KEY)
  } catch {
    return null
  }
}

function savePick(id: string) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, id)
  } catch {
    /* private mode: the pick lasts the session */
  }
}

/**
 * The Layers panel's Library tab: pull from a library without leaving the
 * canvas. A library, a search, the top categories, and a two-column grid of
 * images (no iframe). Click inserts into the selected frame, a drag drops
 * between elements, ⇧ click opens the item.
 */
export function LibraryPanel() {
  const t = useT()
  const canEdit = useStore((s) => canEditOpenCanvas(s))
  const [libraries, setLibraries] = useState<LibraryListEntry[] | null>(null)
  const [picked, setPicked] = useState<string | null>(readPick)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [result, setResult] = useState<LibrarySearchResult | null>(null)
  const drag = useFindDrag()

  useEffect(() => {
    api
      .listLibraries()
      .then((r) => setLibraries(r.libraries))
      .catch(() => setLibraries([]))
  }, [])

  const libraryId = picked && libraries?.some((l) => l.id === picked) ? picked : (libraries?.[0]?.id ?? null)

  useEffect(() => {
    if (!libraryId) return
    let stale = false
    const timer = window.setTimeout(() => {
      api
        .libraryItems(libraryId, { q, ...(category ? { category: [category] } : {}), limit: 40 })
        .then((r) => {
          if (!stale) setResult(r)
        })
        .catch(() => {})
    }, 150)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [libraryId, q, category])

  async function insert(hit: LibrarySearchHit, target: InsertTarget) {
    const notice = useStore.getState().pushNotice
    const done = await insertLibraryItem({
      sourceFrameId: hit.item.frameId,
      focus: focusOfItem(hit.item),
      ref: hit.item.id,
      target,
      libraryId: hit.libraryId,
      rev: hit.item.rev,
    }).catch(() => null)
    if (!done) return notice(t('actions.findInsertFailed', { ref: hit.item.id }))
    notice(t('actions.findInserted', { ref: done.ref, frame: target.frame.name }))
    useInsertedBox.getState().open(done)
  }

  function open(hit: LibrarySearchHit) {
    const s = useStore.getState()
    const params = new URLSearchParams()
    if (s.canvas?.id) params.set('from', s.canvas.id)
    if (s.selectedId) params.set('frame', s.selectedId)
    navigate(`/l/${hit.libraryId}/i/${encodeURIComponent(hit.item.id)}?${params}`)
  }

  if (libraries && !libraries.length) {
    return (
      <PanelBody className="px-3 py-2">
        <p className="text-caption text-ink-faint">{t('library.noLibrary')}</p>
      </PanelBody>
    )
  }
  return (
    <PanelBody className="flex flex-col gap-2 px-2.5 pb-2" data-testid="library-panel">
      <Select
        value={libraryId ?? ''}
        onValueChange={(id) => {
          setPicked(id)
          savePick(id)
          setCategory('')
        }}
      >
        <SelectTrigger size="sm" className="w-full" aria-label={t('library.panelLibrary')}>
          <SelectValue placeholder={t('library.panelLibrary')} />
        </SelectTrigger>
        <SelectContent>
          {(libraries ?? []).map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SearchField
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('library.searchPlaceholder')}
        aria-label={t('library.searchPlaceholder')}
      />
      {(result?.facets.category.length ?? 0) > 1 && (
        <ToggleChipGroup
          className="gap-1"
          aria-label={t('library.categories')}
          value={category || 'all'}
          onValueChange={(next) => setCategory(next === 'all' ? '' : next)}
        >
          <ToggleChipItem size="sm" value="all">
            {t('library.allCategories')}
          </ToggleChipItem>
          {result!.facets.category.slice(0, 8).map((c) => (
            <ToggleChipItem key={c.value} size="sm" value={c.value}>
              {c.label}
            </ToggleChipItem>
          ))}
        </ToggleChipGroup>
      )}
      <div className="grid grid-cols-2 gap-2">
        {(result?.hits ?? []).map((hit) => (
          <Pressable
            key={hit.item.id}
            data-item-id={hit.item.id}
            className="flex flex-col overflow-hidden rounded-row bg-surface text-left shadow-ring"
            onPointerDown={(e) => {
              if (!canEdit || !isInsertable(hit.item)) return
              drag.start(e, hit.item.id, hit.item.frameId, (target) => void insert(hit, target))
            }}
            onClick={(e) => {
              if (drag.swallowClick()) return
              if (e.shiftKey) return open(hit)
              const target =
                canEdit && isInsertable(hit.item) ? insertTarget(useStore.getState(), hit.item.frameId) : null
              if (target) void insert(hit, target)
              else open(hit)
            }}
          >
            <span className="aspect-[4/3] overflow-hidden bg-sub">
              <ItemThumb item={hit.item} />
            </span>
            <span className="truncate px-1.5 py-1 font-mono text-micro text-ink-soft">{hit.item.id}</span>
          </Pressable>
        ))}
      </div>
      {drag.overlay}
    </PanelBody>
  )
}
