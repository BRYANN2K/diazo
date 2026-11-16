import * as React from 'react'

import { cn } from '@/lib/utils'

/** how long each step of the agent's work stays up before the next rolls in */
const STEP_MS = 2400

/**
 * 01 Foundations · ThinkingStatus: the agent's live status line, always in
 * agent orange. A pulsing dot and a label that rolls up through the agent's
 * human-readable steps under a 2s shimmer; `done` folds it into a quiet line
 * ("Thought for 12s"). Under reduced motion the label still changes, but
 * without the roll, the shimmer or the pulse.
 */
function ThinkingStatus({
  steps,
  done,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** what the agent is doing, newest last; the line shows them in turn */
  steps: string[]
  /** once set, the line rests on this text in ink-3 */
  done?: string
}) {
  const [tick, setTick] = React.useState(0)
  const count = steps.length
  React.useEffect(() => {
    if (done || count < 2) return
    const id = window.setInterval(() => setTick((n) => n + 1), STEP_MS)
    return () => window.clearInterval(id)
  }, [done, count])
  const label = count ? steps[tick % count] : ''
  return (
    <div
      data-slot="thinking-status"
      data-state={done ? 'done' : 'thinking'}
      role="status"
      aria-live="polite"
      className={cn('flex h-[22px] min-w-0 items-center gap-2 text-body', className)}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 flex-none rounded-full',
          done
            ? 'bg-ink-3'
            : 'bg-agent shadow-[0_0_0_3px_var(--agent-wash)] animate-[agent-pulse_1.6s_ease-in-out_infinite]',
        )}
      />
      {done ? (
        <span className="truncate text-ink-3">{done}</span>
      ) : (
        <span className="block h-5 min-w-0 overflow-hidden">
          <span
            key={label}
            className="block truncate font-medium leading-5 shimmer-text animate-[status-in_var(--dur-base)_var(--ease-out)_both,shimmer_2s_linear_infinite]"
          >
            {label}
          </span>
        </span>
      )}
    </div>
  )
}

export { ThinkingStatus }
