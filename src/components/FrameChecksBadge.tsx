import type { Frame } from '../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Tooltip } from './ui/tooltip'
import { useT } from '../lib/i18n'

/** The frame's latest responsive + accessibility verdict, next to its name:
 *  "A11y ✓" when clean, "A11y n" with the issue count. Nothing shows until a
 *  first check ran. */
export function FrameChecksBadge({ frame }: { frame: Frame }) {
  const t = useT()
  const checks = frame.checks
  if (!checks) return null
  const count = checks.issues.length
  const label = count === 0 ? t('checks.clean') : t('checks.issueCount', { count })
  const title = `${t('checks.badgeTitle')} · ${t('checks.scoreLabel', { score: checks.score })}`
  return (
    <Tooltip label={title} side="top" align="start">
      {/* Frame checks: passed is ok, errors are danger (with their "!"), and
          warnings wear the yellow pencil, shown only on hover or selection */}
      <Badge
        tone={count === 0 ? 'ok' : checks.errors > 0 ? 'danger' : 'caution'}
        className={cn(
          'shrink-0',
          count > 0 &&
            checks.errors === 0 &&
            'opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100 group-data-[selected]:opacity-100',
        )}
        aria-label={label}
      >
        {t('checks.badgeLabel')} {count === 0 ? '✓' : count}
      </Badge>
    </Tooltip>
  )
}
