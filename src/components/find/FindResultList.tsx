import type { PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '../../lib/i18n'
import {
  groupKey,
  MAX_GROUPS,
  MAX_INSIDE,
  rowDomId,
  rowKey,
  sectionOf,
  type FindSection,
  type FrameGroup,
  type ResultRow,
} from '../../lib/findRows'
import { Badge } from '../ui/badge'
import { IconButton } from '../ui/icon-button'
import { ChevronRightIcon } from '../ui/icons'
import { Pressable } from '../ui/pressable'
import { FramePreview } from '../FramePreview'
import { ItemThumb } from '../library/ItemThumb'

const SECTION_LABEL = {
  canvas: 'actions.findSectionCanvas',
  library: 'actions.findSectionLibrary',
} as const

/** A variant's name inside its family: the id without the family's prefix. */
export function variantName(group: FrameGroup, label: string): string {
  const prefix = group.id ? `${group.id}-` : ''
  return prefix && label.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : label
}

/**
 * ⌘F's remote list: one row per frame group or library family, its variants
 * under it when expanded, in two sections (the canvases' matches, then the
 * library items) when both answered. Rows only: what a press, a click or a
 * hover does is the bar's. `groups` comes in section order (`bySection`).
 */
export function FindResultList({
  groups,
  open,
  pointed,
  hasPointedRow,
  active,
  showCanvas,
  onToggle,
  onHover,
  onLeave,
  onPress,
  onActivate,
}: {
  groups: FrameGroup[]
  /** the groups whose entries are shown, by group key */
  open: ReadonlySet<string>
  /** the row the preview follows, by key */
  pointed: string | null
  /** the pointed row is one of the rows listed */
  hasPointedRow: boolean
  /** the group stepped to with ↩ (highlighted when nothing is pointed) */
  active: number
  /** name each row's canvas (the everywhere scope) */
  showCanvas: boolean
  onToggle: (frameId: string) => void
  onHover: (key: string) => void
  onLeave: () => void
  onPress: (e: ReactPointerEvent<HTMLElement>, row: ResultRow) => void
  onActivate: (row: ResultRow, shift: boolean) => void
}) {
  const t = useT()
  const shown = groups.slice(0, MAX_GROUPS)
  const sections = new Set(shown.map(sectionOf))
  const titled = sections.size > 1 || sections.has('library')
  return (
    <ul className="flex flex-col p-1.5" aria-label={t('actions.findLabel')} onMouseLeave={onLeave}>
      {shown.map((g, i) => {
        const expanded = open.has(groupKey(g))
        const variants = g.variantCount ?? g.inside.length
        const row: ResultRow = { key: rowKey(g), group: g, groupIndex: i }
        const on = pointed === rowKey(g) || (!hasPointedRow && i === active)
        const section: FindSection = sectionOf(g)
        const opensSection = titled && (i === 0 || sectionOf(shown[i - 1]!) !== section)
        return (
          <li key={groupKey(g)} data-section={section}>
            {opensSection && (
              <p className="px-2 pt-2 pb-1 text-caption text-ink-faint first:pt-0.5">
                {t(SECTION_LABEL[section])}
                <span className="ml-1.5 font-mono tabular-nums">
                  {shown.filter((x) => sectionOf(x) === section).length}
                </span>
              </p>
            )}
            <div
              id={rowDomId(rowKey(g))}
              data-on={on || undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-row px-1.5 py-1.5 transition-colors duration-100 motion-reduce:transition-none',
                on ? 'bg-paper-deep' : 'hover:bg-sub',
              )}
              onMouseEnter={() => onHover(rowKey(g))}
            >
              <Pressable
                focus="none"
                onPointerDown={(e) => onPress(e, row)}
                onClick={(e) => onActivate(row, e.shiftKey)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="h-10 w-14 flex-none overflow-hidden rounded-tag bg-sub ring-1 ring-line-soft">
                  {g.item ? <ItemThumb item={g.item} /> : <FramePreview frameId={g.frameId} empty={null} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body text-ink">{g.label || g.id}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink-faint">
                    {g.item && <Badge className="flex-none">{g.item.kind}</Badge>}
                    {g.id && <span className="truncate font-mono">{g.id}</span>}
                    <span className="truncate">
                      {g.id ? '· ' : ''}
                      {showCanvas && g.canvasName ? `${g.canvasName} · ` : ''}
                      {g.pageName}
                    </span>
                  </span>
                </span>
              </Pressable>
              <span className="flex-none text-caption text-ink-faint tabular-nums">
                {variants && g.item
                  ? t('actions.findVariants', { count: variants })
                  : g.item
                    ? ''
                    : t('actions.findMatches', { count: g.hits.length })}
              </span>
              {g.inside.length > 0 ? (
                <IconButton
                  size="sm"
                  aria-label={t('actions.findShowInside')}
                  aria-expanded={expanded}
                  onClick={() => onToggle(groupKey(g))}
                >
                  <ChevronRightIcon
                    width={14}
                    height={14}
                    aria-hidden
                    className={cn(
                      'transition-transform duration-150 motion-reduce:transition-none',
                      expanded && 'rotate-90',
                    )}
                  />
                </IconButton>
              ) : (
                <span className="size-6 flex-none" />
              )}
            </div>
            {expanded && (
              <ul className="flex flex-col gap-px pt-0.5 pb-1 pl-[74px] animate-in fade-in-0 duration-150 motion-reduce:animate-none">
                {g.inside.slice(0, MAX_INSIDE).map((x) => {
                  const variantRow: ResultRow = { key: rowKey(g, x.label), group: g, groupIndex: i, variant: x }
                  return (
                    <li key={x.label} id={rowDomId(variantRow.key)}>
                      <Pressable
                        focus="none"
                        onMouseEnter={() => onHover(variantRow.key)}
                        onPointerDown={(e) => onPress(e, variantRow)}
                        onClick={(e) => onActivate(variantRow, e.shiftKey)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-row px-1.5 py-1 text-left transition-colors duration-100 motion-reduce:transition-none',
                          pointed === variantRow.key ? 'bg-paper-deep' : 'hover:bg-sub',
                        )}
                      >
                        {x.item && (
                          <span className="h-6 w-9 flex-none overflow-hidden rounded-tag bg-sub ring-1 ring-line-soft">
                            <ItemThumb item={x.item} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink-soft">{x.label}</span>
                      </Pressable>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
