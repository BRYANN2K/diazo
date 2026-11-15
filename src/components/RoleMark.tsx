import type { AgentRole } from '../../shared/agents'
import { DiazoAgentMark } from './Logo'
import { cn } from '@/lib/utils'

/** A role's badge: the Diazo Agent's solid face, the two white Ds on a disc
 *  in the role's crew colour. `size` is the disc's diameter. An unknown role
 *  gets a neutral ink disc so a stale card still reads. */
export function RoleMark({
  role,
  size = 14,
  className,
  style,
}: {
  role?: Pick<AgentRole, 'color'>
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <span
      className={cn('inline-grid flex-none place-items-center rounded-full align-middle', className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden
    >
      <DiazoAgentMark solid size={size} color={role?.color ?? 'var(--ink-faint)'} className="block" />
    </span>
  )
}
