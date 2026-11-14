import type { PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '../../lib/i18n'
import {
  MAX_GROUPS,
  MAX_INSIDE,
  rowDomId,
  rowKey,
  variantIds,
  type FrameGroup,
  type ResultRow,
} from '../../lib/findRows'
import { IconButton } from '../ui/icon-button'
import { ChevronRightIcon } from '../ui/icons'
import { Pressable } from '../ui/pressable'
import { FramePreview } from '../FramePreview'

/**
 * ⌘F's remote list: one row per frame group, its variants under it when
 * expanded. Rows only: what a press, a click or a hover does is the bar's.
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
  /** the frames whose variants are shown */
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
  return (
    <ul className="max-h-80 overflow-y-auto" aria-label={t('actions.findLabel')} onMouseLeave={onLeave}>
      {groups.slice(0, MAX_GROUPS).map((g, i) => {
        const expanded = open.has(g.frameId)
        const variants = variantIds(g).length
        const row: ResultRow = { key: rowKey(g), group: g, groupIndex: i }
        return (
          <li key={g.frameId}>
            <div
              id={rowDomId(rowKey(g))}
              className={cn(
                'flex items-center gap-2 rounded-row px-1.5 py-1',
                pointed === rowKey(g) || (!hasPointedRow && i === active) ? 'bg-paper-deep' : 'hover:bg-sub',
              )}
              onMouseEnter={() => onHover(rowKey(g))}
            >
              <Pressable
                focus="none"
                onPointerDown={(e) => onPress(e, row)}
                onClick={(e) => onActivate(row, e.shiftKey)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="h-[30px] w-[46px] flex-none overflow-hidden rounded-tag bg-sub ring-1 ring-line-soft">
                  <FramePreview frameId={g.frameId} empty={null} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-caption text-ink">{g.id ?? g.label}</span>
                  <span className="truncate text-caption text-ink-faint">
                    {g.id ? `${g.label} · ` : ''}
                    {showCanvas && g.canvasName ? `${g.canvasName} · ` : ''}
                    {g.pageName}
                  </span>
                </span>
              </Pressable>
              <span className="flex-none text-caption text-ink-faint tabular-nums">
                {variants
                  ? t('actions.findVariants', { count: variants })
                  : t('actions.findMatches', { count: g.hits.length })}
              </span>
              {g.inside.length > 0 ? (
                <IconButton
                  size="sm"
                  aria-label={t('actions.findShowInside')}
                  aria-expanded={expanded}
                  onClick={() => onToggle(g.frameId)}
                >
                  <ChevronRightIcon
                    width={14}
                    height={14}
                    aria-hidden
                    className={cn('transition-transform', expanded && 'rotate-90')}
                  />
                </IconButton>
              ) : (
                <span className="size-7 flex-none" />
              )}
            </div>
            {expanded && (
              <ul className="pb-1 pl-[62px]">
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
                          'w-full truncate rounded-row px-1.5 py-0.5 text-left font-mono text-caption text-ink-soft',
                          pointed === variantRow.key ? 'bg-paper-deep' : 'hover:bg-sub',
                        )}
                      >
                        {x.label}
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
