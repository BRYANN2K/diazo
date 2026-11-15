import { cn } from '@/lib/utils'
import type { ItemFocus } from '../../lib/findPreviewRuntime'
import type { FooterHint } from '../../lib/findInsert'
import { MAX_INSIDE, rowItem, type ResultRow } from '../../lib/findRows'
import { useT } from '../../lib/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ToggleChipGroup, ToggleChipItem } from '../ui/toggle-chip'
import { FindPreview } from '../FindPreview'
import { variantName } from './FindResultList'

/** Variants offered as chips over the preview; the rest stay in the list. */
const MAX_VARIANT_CHIPS = 12

const FAMILY = '\u0000family'

/**
 * ⌘F's side pane: the pointed result large and live (its animations and
 * hover demos running, the pointer let in), its name, kind and category,
 * chips to switch between the family's matched variants, and the two
 * actions a row has (insert into the selected frame, go to it).
 */
export function FindPreviewPane({
  row,
  focus,
  frameId,
  hint,
  staticNote,
  busy,
  compact = false,
  onVariant,
  onInsert,
  onGo,
}: {
  row: ResultRow
  focus: ItemFocus
  /** the frame the preview renders */
  frameId: string
  /** what a click on the row would do */
  hint: FooterHint
  staticNote?: string
  /** an insert is running */
  busy: boolean
  /** a phone: a shorter preview over the list */
  compact?: boolean
  /** show a variant of the row's family (its label), or the family (null) */
  onVariant: (label: string | null) => void
  onInsert: () => void
  onGo: () => void
}) {
  const t = useT()
  const g = row.group
  const item = rowItem(row)
  const chips = g.inside.slice(0, Math.min(MAX_INSIDE, MAX_VARIANT_CHIPS))
  const title = row.variant?.item?.label ?? g.label ?? g.id
  const ref = item?.id ?? g.id
  const libraryId = g.libraryId
  return (
    <section
      aria-label={t('actions.findPreviewLabel', { name: title || '' })}
      className="flex min-w-0 flex-1 flex-col gap-2.5 p-3"
    >
      <FindPreview
        key={frameId}
        frameId={frameId}
        focus={focus}
        interactive
        className={cn('w-full rounded-card', compact ? 'h-44' : 'h-[300px]')}
        {...(libraryId && item ? { item: { libraryId, itemId: item.id } } : {})}
        {...(staticNote ? { staticNote } : {})}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-copy font-medium text-ink">{title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-ink-faint">
          {item && <Badge>{item.kind}</Badge>}
          {ref && <span className="truncate font-mono">{ref}</span>}
          {(item?.category ?? g.pageName) && <span className="truncate">· {item?.category ?? g.pageName}</span>}
          {g.canvasName && <span className="truncate">· {g.canvasName}</span>}
        </span>
      </div>
      {g.item && chips.length > 0 && (
        <ToggleChipGroup
          className="gap-1"
          aria-label={t('actions.findKeyVariants')}
          value={row.variant ? row.variant.label : FAMILY}
          onValueChange={(next) => onVariant(next === FAMILY ? null : next)}
        >
          <ToggleChipItem size="sm" value={FAMILY}>
            {t('actions.findVariantFamily')}
          </ToggleChipItem>
          {chips.map((x) => (
            <ToggleChipItem key={x.label} size="sm" value={x.label} title={x.label}>
              {variantName(g, x.label)}
            </ToggleChipItem>
          ))}
        </ToggleChipGroup>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {hint.kind === 'insert' && (
          <Button size="sm" variant="primary" disabled={busy} onClick={onInsert}>
            {t('actions.findInsertInto', { frame: hint.frameName })}
          </Button>
        )}
        <Button size="sm" onClick={onGo}>
          {t('actions.findGoTo')}
        </Button>
        {hint.kind === 'select' && (
          <span className="text-caption text-ink-faint" aria-live="polite">
            {t('actions.findInsertSelect')}
          </span>
        )}
      </div>
    </section>
  )
}
