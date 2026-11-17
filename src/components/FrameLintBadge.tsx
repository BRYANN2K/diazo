import type { Frame } from '../../shared/types'
import { Badge } from './ui/badge'
import { Tooltip } from './ui/tooltip'
import { useT } from '../lib/i18n'
import { verdictReveal, verdictTone } from '../lib/frameBadges'
import { cn } from '@/lib/utils'

/** The frame's latest anti-slop verdict, next to its name: ✓ when clean,
 *  the issue count otherwise, shown only on hover or selection (red with an
 *  error among them, yellow for warnings alone). Nothing shows until a first
 *  lint ran. */
export function FrameLintBadge({ frame }: { frame: Frame }) {
  const t = useT()
  const lint = frame.lint
  if (!lint) return null
  const count = lint.issues.length
  const label = count === 0 ? t('lint.clean') : t('lint.issueCount', { count })
  const title = `${t('lint.badgeTitle')} · ${t('lint.scoreLabel', { score: lint.score })}`
  return (
    <Tooltip label={title} side="top" align="start">
      <Badge tone={verdictTone(count, lint.errors)} className={cn('shrink-0', verdictReveal(count))} aria-label={label}>
        {count === 0 ? '✓' : count}
      </Badge>
    </Tooltip>
  )
}
