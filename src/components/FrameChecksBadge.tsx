import type { Frame } from '../../shared/types'
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
      <Badge
        tone={count === 0 ? 'success' : checks.errors > 0 ? 'banned' : 'outline'}
        className="shrink-0"
        aria-label={label}
      >
        {t('checks.badgeLabel')} {count === 0 ? '✓' : count}
      </Badge>
    </Tooltip>
  )
}
