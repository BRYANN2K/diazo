import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Frame } from '../../shared/types'
import { readingOrder } from '../../shared/frameOrder'
import { useT } from '../lib/i18n'
import { usePageCanvas } from '../lib/pages'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { saveFrameHtml } from '../lib/layerEdits'
import { findInHtml, replaceInHtml } from '../lib/actions/findText'
import { saveFramesHtml } from '../lib/actions/edits'
import { api } from '../lib/api'
import { navigate } from '../lib/navigate'
import {
  footerHint,
  insertLibraryItem,
  isLibraryItem,
  rowAction,
  type InsertSource,
  type InsertTarget,
} from '../lib/findInsert'
import type { CanvasFindHit } from '../../shared/canvasFind'
import type { LibraryItemSummary, LibrarySearchResult } from '../../shared/library'
import {
  bySection,
  focusOf,
  groupByFrame,
  groupKey,
  resultRows,
  rowDomId,
  rowItem,
  rowKey,
  type ResultRow,
} from '../lib/findRows'
import {
  itemCanvasUrl,
  libraryFocus,
  libraryRows,
  personHasLibraries,
  resetHasLibrariesForTest,
} from '../lib/findLibrary'
import { textFocus } from '../lib/findPreviewRuntime'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Skeleton } from './ui/skeleton'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { SearchField } from './ui/search-field'
import { FindResultList } from './find/FindResultList'
import { FindPreviewPane } from './find/FindPreviewPane'
import { FindTextList, type TextHit as Hit } from './find/FindTextList'
import { useFindDrag } from './FindDrag'
import { useInsertedBox } from '../lib/insertedBox'
import { useIsMobile } from '../hooks/use-mobile'

/** Where ⌘F looks: the open page (find and replace, on the HTML the client
 *  holds), every page of the canvas or every canvas (find only, answered by
 *  the server), or the design libraries (answered by their index). */
type Scope = 'page' | 'canvas' | 'all' | 'library'

/** remote scopes are answered by the server, grouped by frame */
const isRemote = (scope: Scope) => scope !== 'page'

/** The three places the segmented control offers; "This canvas" is the page
 *  or every page, picked under it when the canvas has several. */
type Place = 'canvas' | 'library' | 'all'

const placeOf = (scope: Scope): Place => (scope === 'library' ? 'library' : scope === 'all' ? 'all' : 'canvas')

const PLACES = [
  {
    place: 'canvas',
    label: 'actions.findScopeCanvas',
    title: 'actions.findAllPages',
    start: 'actions.findStartCanvas',
  },
  { place: 'library', label: 'actions.findScopeLibrary', title: 'library.scope', start: 'actions.findStartLibrary' },
  { place: 'all', label: 'actions.findScopeAll', title: 'actions.findEverywhere', start: 'actions.findStartAll' },
] as const

/** How long typing settles before the library index is asked. */
const LIBRARY_FIND_DEBOUNCE_MS = 120

/** For tests: forget whether this person has libraries. */
export const resetFindLibrariesForTest = resetHasLibrariesForTest

/** How long the pointer rests on a row before the preview follows it, so
 *  sweeping across the list does not flicker the preview. */
const HOVER_INTENT_MS = 70

/** How long typing settles before an all-pages search asks the server. */
const CANVAS_FIND_DEBOUNCE_MS = 220

/* After an all-pages hit flies to another page, that page's HTML arrives a
   moment later; the match inside the frame is picked once it is there. */
function pickWhenLoaded(frameId: string, query: string, n: number, matchCase: boolean) {
  const deadline = Date.now() + 4000
  const tryPick = () => {
    const s = useStore.getState()
    const frame = s.canvas?.frames.find((f) => f.id === frameId)
    if (frame?.html) {
      const match = findInHtml(frame.html, query, { matchCase })[n]
      if (match) s.pickElement({ frameId, selector: match.selector }, true)
      return
    }
    if (Date.now() < deadline) window.setTimeout(tryPick, 150)
  }
  tryPick()
}

/**
 * ⌘F: find text across the page's frames, step through the matches (↩ /
 * ⇧↩), each one picked and flown to; ⌥⌘F opens it with a replace line,
 * replacing one match or all of them as one undo step.
 */
export function FindBar({
  mode,
  step,
  onClose,
}: {
  mode: 'find' | 'replace'
  /** a step asked for from outside (the Edit menu's Find next/previous) */
  step: { dir: 1 | -1; at: number } | null
  onClose: () => void
}) {
  const t = useT()
  const mobile = useIsMobile()
  const page = usePageCanvas()
  const canEdit = useStore((s) => canEditOpenCanvas(s))
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [showReplace, setShowReplace] = useState(mode === 'replace')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasId = useStore((s) => s.canvas?.id)
  const pageCount = useStore((s) => s.canvas?.pages?.length ?? 1)
  const isLibraryCanvas = useStore((s) => !!s.canvas?.library)
  /* a library canvas, or a person with a library, searches the libraries;
     else a canvas of several pages is searched whole, a one-page project
     everywhere */
  const [scope, setScope] = useState<Scope>(
    mode === 'replace' ? 'page' : isLibraryCanvas ? 'library' : pageCount > 1 ? 'canvas' : 'all',
  )
  /* a scope picked by hand (or the replace line, which needs the page) is kept */
  const scopeTouched = useRef(mode === 'replace')
  /* what "This canvas" goes back to: the page, or every page */
  const canvasScope = useRef<'page' | 'canvas'>(pageCount > 1 ? 'canvas' : 'page')
  const [hasLibrary, setHasLibrary] = useState(false)
  useEffect(() => {
    if (isLibraryCanvas) return
    let stale = false
    void personHasLibraries().then((has) => {
      if (stale) return
      setHasLibrary(has)
      if (has && !scopeTouched.current) setScope('library')
    })
    return () => {
      stale = true
    }
  }, [isLibraryCanvas])

  function pickScope(next: Scope) {
    scopeTouched.current = true
    if (next === 'page' || next === 'canvas') canvasScope.current = next
    setScope(next)
    setCursor(0)
    setPointed(null)
  }
  const [remote, setRemote] = useState<{ q: string; hits: CanvasFindHit[]; total: number; frames: number } | null>(null)
  const [searching, setSearching] = useState(false)
  const [kind, setKind] = useState('')
  const [libraryResult, setLibraryResult] = useState<{ q: string; kind: string; result: LibrarySearchResult } | null>(
    null,
  )

  useEffect(() => {
    if (scope !== 'library') return
    const q = query.trim()
    if (!q) return
    let stale = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      api
        .searchLibraries({ q, ...(kind ? { kind: [kind] } : {}), limit: 30 })
        .then((result) => {
          if (!stale) setLibraryResult({ q, kind, result })
        })
        .catch(() => {
          if (!stale) setLibraryResult({ q, kind, result: { hits: [], total: 0, facets: emptyFacets() } })
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, LIBRARY_FIND_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [scope, query, kind])

  useEffect(() => {
    if (!isRemote(scope) || scope === 'library' || (scope === 'canvas' && !canvasId)) return
    const q = query.trim()
    if (!q) return
    let stale = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      ;(scope === 'all' ? api.findEverywhere(q, matchCase) : api.findInCanvas(canvasId!, q, matchCase))
        .then((r) => {
          if (!stale) setRemote({ q, ...r })
        })
        .catch(() => {
          if (!stale) setRemote({ q, hits: [], total: 0, frames: 0 })
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, CANVAS_FIND_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [scope, canvasId, query, matchCase])

  /* ⌘F again (or ⌥⌘F) while open puts the keyboard back in the field */
  const [seenMode, setSeenMode] = useState(mode)
  if (seenMode !== mode) {
    setSeenMode(mode)
    if (mode === 'replace') {
      setShowReplace(true)
      setScope('page')
    }
  }
  useEffect(() => {
    if (mode === 'replace') scopeTouched.current = true
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [mode])

  const hits = useMemo<Hit[]>(() => {
    const frames = readingOrder((page?.frames ?? []).filter((f) => !f.hidden))
    return frames.flatMap((frame) =>
      findInHtml(frame.html, query, { matchCase }).map((match, n) => ({ frame, n, match })),
    )
  }, [page?.frames, query, matchCase])
  /* an answer for an older query is not shown while the new one is asked */
  const remoteHits = useMemo(
    () => (isRemote(scope) && scope !== 'library' && remote?.q === query.trim() ? remote.hits : []),
    [scope, remote, query],
  )
  const libraryAnswer =
    scope === 'library' && libraryResult?.q === query.trim() && libraryResult.kind === kind
      ? libraryResult.result
      : null
  /* all pages: one row per frame, stepped frame by frame; the libraries: one row per family */
  const groups = useMemo(
    () =>
      scope === 'library'
        ? libraryAnswer
          ? libraryRows(libraryAnswer)
          : []
        : bySection(groupByFrame(remoteHits, query)),
    [scope, libraryAnswer, remoteHits, query],
  )
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  /* the row the preview shows: hovered (after an intent delay) or reached
     with ↑/↓; leaving the list keeps it, so the pointer can reach the preview */
  const [pointed, setPointed] = useState<string | null>(null)
  const intent = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(intent.current), [])
  const rows = useMemo(() => resultRows(groups, open), [groups, open])
  const listLength = isRemote(scope) ? groups.length : hits.length
  const active = listLength ? Math.min(cursor, listLength - 1) : -1
  const pointedRow = rows.find((r) => r.key === pointed) ?? null

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /* the pane's variant chips: the family opens in the list, the variant is pointed */
  function showVariant(row: ResultRow, label: string | null) {
    const g = row.group
    window.clearTimeout(intent.current)
    if (label !== null) setOpen((prev) => (prev.has(groupKey(g)) ? prev : new Set(prev).add(groupKey(g))))
    const key = label === null ? rowKey(g) : rowKey(g, label)
    setPointed(key)
    setCursor(row.groupIndex)
    window.requestAnimationFrame(() => document.getElementById(rowDomId(key))?.scrollIntoView({ block: 'nearest' }))
  }

  function hover(key: string) {
    window.clearTimeout(intent.current)
    intent.current = window.setTimeout(() => setPointed(key), HOVER_INTENT_MS)
  }

  /* ↑/↓ walk every visible row, variants of an expanded frame included */
  function point(dir: 1 | -1) {
    if (!rows.length) return
    const at = rows.findIndex((r) => r.key === pointed)
    const from = at === -1 ? rows.findIndex((r) => r.groupIndex === active && !r.variant) : at
    const next = rows[from === -1 ? 0 : (from + dir + rows.length) % rows.length]!
    window.clearTimeout(intent.current)
    setPointed(next.key)
    setCursor(next.groupIndex)
    document.getElementById(rowDomId(next.key))?.scrollIntoView({ block: 'nearest' })
  }

  function flyToHit(hit: CanvasFindHit) {
    const s = useStore.getState()
    /* a hit in another canvas opens it on that frame */
    if (hit.canvasId && hit.canvasId !== s.canvas?.id) {
      navigate(`/c/${hit.canvasId}?frame=${hit.frameId}`)
      return
    }
    s.select(hit.frameId)
    s.requestFlyTo(hit.frameId)
    if (hit.where === 'text') pickWhenLoaded(hit.frameId, query.trim(), hit.n, matchCase)
  }

  /* a library item lives on its library canvas: fly there, or open it */
  function goToItem(libraryId: string, item: LibraryItemSummary) {
    const s = useStore.getState()
    if (libraryId !== s.canvas?.id) return navigate(itemCanvasUrl(libraryId, item))
    s.select(item.frameId)
    s.requestFlyTo(item.frameId)
  }

  function goRemote(index: number) {
    const group = groups[index]
    if (!group) return
    setCursor(index)
    setPointed(rowKey(group))
    if (group.item && group.libraryId) return goToItem(group.libraryId, group.item)
    /* the frame's first readable match is picked; a name match just frames it */
    const hit = group.hits.find((h) => h.where === 'text') ?? group.hits[0]
    if (hit) flyToHit(hit)
  }

  /* the row's library item, and the frame it is copied from */
  const sourceOf = (row: ResultRow): InsertSource => {
    const item = rowItem(row)
    return { item, frameId: item?.frameId ?? row.group.frameId }
  }

  function goRow(row: ResultRow) {
    if (!row.variant) return goRemote(row.groupIndex)
    setCursor(row.groupIndex)
    setPointed(row.key)
    if (row.variant.item && row.group.libraryId) return goToItem(row.group.libraryId, row.variant.item)
    if (row.variant.hit) flyToHit(row.variant.hit)
  }

  const drag = useFindDrag()

  /* a library row drags onto any frame; the click stays the fallback */
  function pressRow(e: ReactPointerEvent<HTMLElement>, row: ResultRow) {
    const source = sourceOf(row)
    if (!canEdit || !isLibraryItem(source) || !source.item) return
    drag.start(e, source.item.id, source.frameId, (target) => void insertRow(row, target))
  }

  /* a click, or ↩: insert a library item into the selected frame, else go */
  function activate(row: ResultRow, shift: boolean) {
    if (drag.swallowClick()) return
    const action = rowAction(useStore.getState(), sourceOf(row), shift)
    if (action.kind === 'insert') void insertRow(row, action.target)
    else goRow(row)
  }

  const [inserting, setInserting] = useState(false)

  async function insertRow(row: ResultRow, target: InsertTarget) {
    if (inserting) return
    const source = sourceOf(row)
    const ref = source.item?.id ?? row.group.label
    const notice = useStore.getState().pushNotice
    setInserting(true)
    setPointed(row.key)
    notice(t('actions.findInserting', { ref }), { busy: true })
    try {
      const done = await insertLibraryItem({
        sourceFrameId: source.frameId,
        focus: source.item ? libraryFocus(row) : textFocus(focusOf(row, query)),
        ref,
        target,
        ...(source.item && row.group.libraryId
          ? { libraryId: row.group.libraryId, rev: source.item.rev, mode: source.item.mode }
          : {}),
      })
      if (!done) return notice(t('actions.findInsertFailed', { ref }))
      const parts = [
        done.found
          ? t('actions.findInserted', { ref: done.ref, frame: target.frame.name })
          : t('actions.findInsertedWhole', { ref: done.ref }),
        done.scripted ? t('actions.findInsertedStatic') : '',
        done.approvalWithdrawn ? t('actions.findApprovalWithdrawn') : '',
      ]
      notice(parts.filter(Boolean).join(' · '))
      useInsertedBox.getState().open(done)
    } catch {
      notice(t('actions.findInsertFailed', { ref }))
    } finally {
      setInserting(false)
    }
  }

  function copyRowId(row: ResultRow): boolean {
    const id = rowItem(row)?.id ?? row.group.id
    if (!id) return false
    navigator.clipboard
      .writeText(id)
      .then(() => useStore.getState().pushNotice(t('actions.findCopiedId', { id })))
      .catch(() => {})
    return true
  }

  /* the row ↩ and ⌘C act on: the pointed one, else the active frame */
  const currentRow = () => pointedRow ?? rows.find((r) => r.groupIndex === active && !r.variant) ?? null

  function go(index: number) {
    if (isRemote(scope)) return goRemote(index)
    const hit = hits[index]
    if (!hit) return
    setCursor(index)
    const s = useStore.getState()
    s.select(hit.frame.id)
    s.pickElement({ frameId: hit.frame.id, selector: hit.match.selector }, true)
    s.requestFlyTo(hit.frame.id)
    document.getElementById(`find-hit-${index}`)?.scrollIntoView({ block: 'nearest' })
  }

  function move(dir: 1 | -1) {
    if (!listLength) return
    go(active === -1 ? 0 : (active + dir + listLength) % listLength)
  }

  /* the menus' Find next / previous */
  const [seenStep, setSeenStep] = useState(step)
  if (seenStep !== step) {
    setSeenStep(step)
    if (step) move(step.dir)
  }

  function replaceOne() {
    const hit = hits[active]
    if (!hit || hit.frame.locked || hit.match.locked) return
    const replaced = replaceInHtml(hit.frame.html, query, replacement, { matchCase, only: hit.n })
    if (replaced) saveFrameHtml(hit.frame, replaced.html)
  }

  function replaceAll() {
    const byFrame = new Map<string, Frame>()
    for (const hit of hits) if (!hit.frame.locked) byFrame.set(hit.frame.id, hit.frame)
    let count = 0
    const changes = [...byFrame.values()].flatMap((frame) => {
      const replaced = replaceInHtml(frame.html, query, replacement, { matchCase })
      if (!replaced) return []
      count += replaced.count
      return [{ frame, html: replaced.html }]
    })
    saveFramesHtml(changes)
    if (count) useStore.getState().pushNotice(t('actions.replaced', { count }))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      if (isRemote(scope)) point(dir)
      else move(dir)
    } else if (e.key === 'Enter' && e.altKey && isRemote(scope) && !e.nativeEvent.isComposing) {
      /* ⌥↩ opens or closes the pointed family's variants */
      e.preventDefault()
      const row = currentRow()
      if (row?.group.inside.length) toggle(groupKey(row.group))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const row = isRemote(scope) ? currentRow() : null
      if (row) activate(row, e.shiftKey)
      else move(e.shiftKey ? -1 : 1)
    } else if (isRemote(scope) && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      /* ⌘C copies the reference id, unless text in the field is selected */
      const field = e.currentTarget
      if (field.selectionStart !== field.selectionEnd) return
      const row = currentRow()
      if (row && copyRowId(row)) e.preventDefault()
    }
  }

  /* the footer follows the selection: re-rendered when it changes */
  useStore((s) => s.selectedElement)
  useStore((s) => s.selectedId)
  useStore((s) => s.canvas?.frames)
  const hintRow = isRemote(scope) ? currentRow() : null
  const hint = hintRow ? footerHint(useStore.getState(), sourceOf(hintRow)) : null

  const q = query.trim()
  const waiting = isRemote(scope) && (searching || (scope === 'library' ? !libraryAnswer : remote?.q !== q))
  const count = !q
    ? ''
    : waiting
      ? '…'
      : listLength
        ? t('actions.findCount', {
            current: active + 1,
            total: listLength,
          })
        : t('actions.findNone')

  /* the row the pane shows: the pointed one, else the active family */
  const shownIndex = Math.max(active, 0)
  const shownGroup = pointedRow?.group ?? groups[shownIndex]
  const shownRow: ResultRow | null =
    pointedRow ?? (shownGroup ? { key: rowKey(shownGroup), group: shownGroup, groupIndex: shownIndex } : null)
  const shownSource = shownRow ? sourceOf(shownRow) : null
  const place = placeOf(scope)
  const noLibrary = scope === 'library' && !isLibraryCanvas && !hasLibrary
  const wide = isRemote(scope) && !!q
  const results = isRemote(scope) ? groups.length : hits.length

  return (
    <>
      {/* the stage and its panels dim behind the palette (⌘F 1 frame); a
          press on the scrim closes it, as outside a dialog */}
      <div
        aria-hidden
        data-slot="find-scrim"
        className="absolute inset-0 z-[39] bg-[var(--scrim)] motion-safe:animate-[fade-in_200ms_var(--ease-out)]"
        onPointerDown={onClose}
      />
      <div
        role="search"
        aria-label={t('actions.findLabel')}
        /* ⌘F 1: a palette centred over the stage, a paper sheet at elevation 4
         that opens on the soft spring; it widens into list + live preview
         once there is something to show */
        className={cn(
          'absolute left-1/2 z-40 flex max-h-[calc(100vh-var(--chrome-top,0px)-64px)] -translate-x-1/2 flex-col overflow-hidden rounded-sheet bg-paper shadow-modal',
          'animate-[modal-in_400ms_var(--spring-soft)] transition-[width] duration-slow ease-in-out',
          wide ? 'w-[min(900px,calc(100vw-24px))]' : 'w-[min(600px,calc(100vw-24px))]',
        )}
        style={{ top: 'calc(var(--chrome-top, 0px) + 40px)' }}
      >
        <div className="flex flex-none flex-col gap-2 px-3 pt-3 pb-2.5">
          <div className="flex items-center gap-1">
            {canEdit && (
              <IconButton
                size="sm"
                aria-label={t('actions.showReplace')}
                on={showReplace}
                onClick={() => {
                  const next = !showReplace
                  setShowReplace(next)
                  /* replacing works on the page's own HTML */
                  if (next) pickScope('page')
                }}
              >
                <ChevronRightIcon
                  width={14}
                  height={14}
                  aria-hidden
                  className={cn('transition-transform motion-reduce:transition-none', showReplace && 'rotate-90')}
                />
              </IconButton>
            )}
            <SearchField
              ref={inputRef}
              className="min-w-0 flex-1"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              onKeyDown={onKeyDown}
              placeholder={t('actions.findPlaceholder')}
              aria-label={t('actions.findPlaceholder')}
              trailing={<span className="flex-none font-mono text-caption text-ink-faint">{count}</span>}
            />
            <IconButton
              size="sm"
              aria-label={t('actions.matchCase')}
              on={matchCase}
              onClick={() => setMatchCase((v) => !v)}
            >
              <span className="font-mono text-caption">Aa</span>
            </IconButton>
            <IconButton
              size="sm"
              aria-label={t('actions.previousMatch')}
              disabled={!listLength}
              onClick={() => move(-1)}
            >
              <ArrowUpIcon width={14} height={14} aria-hidden />
            </IconButton>
            <IconButton size="sm" aria-label={t('actions.nextMatch')} disabled={!listLength} onClick={() => move(1)}>
              <ArrowDownIcon width={14} height={14} aria-hidden />
            </IconButton>
            <IconButton size="sm" aria-label={t('actions.closeFind')} onClick={onClose}>
              <XIcon width={14} height={14} aria-hidden />
            </IconButton>
          </div>
          {canEdit && showReplace && scope === 'page' && (
            <div className="flex items-center gap-1 pl-7">
              <Input
                inputSize="sm"
                className="min-w-0 flex-1"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose()
                  else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    replaceOne()
                  }
                }}
                placeholder={t('actions.replacePlaceholder')}
                aria-label={t('actions.replacePlaceholder')}
              />
              <Button size="sm" disabled={active === -1 || !!hits[active]?.match.locked} onClick={replaceOne}>
                {t('actions.replaceOne')}
              </Button>
              <Button size="sm" disabled={!hits.length} onClick={replaceAll}>
                {t('actions.replaceAll')}
              </Button>
            </div>
          )}
          {/* where to look: this canvas (its page or every page), the libraries, everything */}
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              aria-label={t('library.scopeMenu')}
              value={place}
              onValueChange={(next) => pickScope(next === 'canvas' ? canvasScope.current : (next as Place & Scope))}
            >
              {PLACES.map((p) => (
                <SegmentedItem key={p.place} value={p.place} title={t(p.title)}>
                  {t(p.label)}
                </SegmentedItem>
              ))}
            </Segmented>
            {place === 'canvas' && pageCount > 1 && (
              <ToggleChipGroup
                className="gap-1"
                aria-label={t('actions.findScopeCanvas')}
                value={scope}
                onValueChange={(next) => pickScope(next as Scope)}
              >
                <ToggleChipItem size="sm" value="page" title={t('actions.findScopePage')}>
                  {t('actions.findThisPage')}
                </ToggleChipItem>
                <ToggleChipItem size="sm" value="canvas" title={t('actions.findAllPages')}>
                  {t('actions.findEveryPage')}
                </ToggleChipItem>
              </ToggleChipGroup>
            )}
          </div>
          {scope === 'library' && (libraryAnswer?.facets.kind.length ?? 0) > 1 && (
            <ToggleChipGroup
              className="gap-1"
              aria-label={t('library.kinds')}
              value={kind || 'all'}
              onValueChange={(next) => {
                setKind(next === 'all' ? '' : next)
                setCursor(0)
              }}
            >
              <ToggleChipItem size="sm" value="all">
                {t('library.allKinds')}
              </ToggleChipItem>
              {libraryAnswer!.facets.kind.map((k) => (
                <ToggleChipItem key={k.value} size="sm" value={k.value}>
                  {k.label} <span className="font-mono text-ink-faint tabular-nums">{k.count}</span>
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          )}
        </div>
        {/* side by side; on a phone the pane goes above the list */}
        <div className={cn('flex min-h-0 flex-1 border-t border-line-soft', mobile && 'flex-col-reverse')}>
          <div
            className={cn(
              'max-h-[min(440px,calc(100vh-240px))] min-w-0 overflow-y-auto',
              wide && !mobile ? 'w-[360px] flex-none border-r border-line-soft' : 'w-full',
            )}
          >
            {!q ? (
              <p className="px-3 py-3 text-caption text-ink-faint">
                {noLibrary ? t('library.noLibrary') : t(PLACES.find((p) => p.place === place)!.start)}
              </p>
            ) : waiting && !results ? (
              <div className="flex flex-col gap-1.5 p-2" aria-label={t('actions.findSearching')} aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} index={i} className="h-12 rounded-row" />
                ))}
              </div>
            ) : !results ? (
              <div className="flex flex-col gap-1 px-3 py-4" aria-live="polite">
                <p className="text-body text-ink">{t('actions.findNoneFor', { query: q })}</p>
                <p className="text-caption text-ink-faint">
                  {noLibrary ? t('library.noLibrary') : t('actions.findNoneHint')}
                </p>
              </div>
            ) : isRemote(scope) ? (
              <FindResultList
                groups={groups}
                open={open}
                pointed={pointed}
                hasPointedRow={!!pointedRow}
                active={active}
                showCanvas={scope === 'all' || scope === 'library'}
                onToggle={toggle}
                onHover={hover}
                onLeave={() => window.clearTimeout(intent.current)}
                onPress={pressRow}
                onActivate={activate}
              />
            ) : (
              <FindTextList hits={hits} active={active} onGo={go} />
            )}
          </div>
          {wide && (
            <div className={cn('flex min-w-0 flex-1', mobile && 'border-b border-line-soft')}>
              {shownRow && shownSource ? (
                <FindPreviewPane
                  compact={mobile}
                  row={shownRow}
                  frameId={shownSource.frameId}
                  focus={shownSource.item ? libraryFocus(shownRow) : textFocus(focusOf(shownRow, query))}
                  hint={footerHint(useStore.getState(), shownSource)}
                  busy={inserting}
                  {...(isLibraryItem(shownSource) ? { staticNote: t('actions.findStaticNote') } : {})}
                  onVariant={(label) => showVariant(shownRow, label)}
                  onInsert={() => {
                    const action = rowAction(useStore.getState(), shownSource, false)
                    if (action.kind === 'insert') void insertRow(shownRow, action.target)
                  }}
                  onGo={() => goRow(shownRow)}
                />
              ) : (
                <p className="m-auto px-6 text-center text-caption text-ink-faint">
                  {waiting ? t('actions.findSearching') : t('actions.findPreviewEmpty')}
                </p>
              )}
            </div>
          )}
        </div>
        {results > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft px-3 py-1.5 text-caption text-ink-faint">
            {isRemote(scope) ? (
              <>
                <KeyHint
                  keys="↩"
                  label={hint?.kind === 'insert' ? t('actions.findKeyInsert') : t('actions.findKeyGo')}
                />
                {hint?.kind === 'insert' && <KeyHint keys="⇧↩" label={t('actions.findKeyGo')} />}
                {hintRow && hintRow.group.inside.length > 0 && (
                  <KeyHint keys="⌥↩" label={t('actions.findKeyVariants')} />
                )}
                {hintRow && (rowItem(hintRow)?.id ?? hintRow.group.id) && (
                  <KeyHint keys="⌘C" label={t('actions.findKeyCopy')} />
                )}
              </>
            ) : (
              <>
                <KeyHint keys="↩" label={t('actions.findKeyNext')} />
                <KeyHint keys="⇧↩" label={t('actions.findKeyPrevious')} />
              </>
            )}
            <span className="ml-auto flex items-center gap-2">
              {isRemote(scope) && (
                <span className="tabular-nums">
                  {scope === 'library'
                    ? t('library.findSummary', { count: libraryAnswer?.total ?? groups.length })
                    : t('actions.findFramesSummary', {
                        frames: groups.length,
                        total: remote?.total ?? remoteHits.length,
                      })}
                </span>
              )}
              {scope === 'library' && (
                <Button
                  size="inline"
                  onClick={() => {
                    const lib = shownGroup?.libraryId
                    const from = useStore.getState().canvas?.id
                    const frame = useStore.getState().selectedId
                    const params = new URLSearchParams({ q })
                    if (from && from !== lib) params.set('from', from)
                    if (from && from !== lib && frame) {
                      params.set('frame', frame)
                      const name = useStore.getState().canvas?.frames.find((f) => f.id === frame)?.name
                      if (name) params.set('fname', name)
                    }
                    if (lib) navigate(`/l/${lib}?${params}`)
                  }}
                >
                  {t('library.openInGallery')}
                </Button>
              )}
            </span>
            {hint && hint.kind !== 'none' && (
              <span className="sr-only" aria-live="polite">
                {hint.kind === 'insert'
                  ? t('actions.findHintInsert', { frame: hint.frameName })
                  : hint.kind === 'select'
                    ? t('actions.findHintSelect')
                    : t('actions.findHintGo')}
              </span>
            )}
          </div>
        )}
        {drag.overlay}
      </div>
    </>
  )
}

/** One keyboard hint in the footer: the keys, then what they do. */
function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <Kbd>{keys}</Kbd>
      {label}
    </span>
  )
}

function emptyFacets(): LibrarySearchResult['facets'] {
  return { kind: [], category: [], source: [], tag: [] }
}
