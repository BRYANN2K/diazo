import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * 01 Foundations · Chip: a 26px ring pill for suggestions, composer
 * attachments, filters and pickers. `on` is a chosen filter (signal wash);
 * `tone="agent"` marks something an agent produced or will run (the orange
 * dot). Hover changes colour only; a chip pops in from .92 on the snap spring
 * when it mounts (still under reduced motion).
 */
type ChipProps = React.ComponentProps<'button'> & {
  /** a 13px glyph for the tile; omit for a text-only chip */
  icon?: React.ReactNode
  on?: boolean
  tone?: 'default' | 'agent'
}

const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, icon, on = false, tone = 'default', type, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="chip"
      data-on={on || undefined}
      data-tone={tone}
      className={cn(
        'relative inline-flex h-[26px] flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-pill bg-surface px-2.5 text-label text-ink-2 shadow-ring',
        'animate-[pop-in_320ms_var(--spring-snap)_both] transition-[background-color,color,box-shadow] duration-fast hover:bg-well hover:text-ink hover:duration-instant',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        tone === 'agent' &&
          "text-ink before:size-1.5 before:flex-none before:rounded-full before:bg-agent before:content-['']",
        on &&
          'bg-signal-wash text-signal shadow-[0_0_0_1px_color-mix(in_srgb,var(--signal)_30%,transparent)] hover:bg-signal-wash hover:text-signal',
        className,
      )}
      {...props}
    >
      {icon ? <ChipIcon>{icon}</ChipIcon> : null}
      {children}
    </button>
  )
})

/** the 16px tile a chip's glyph sits on: a faint ink wash */
function ChipIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="chip-icon"
      className={cn('-ml-1 grid size-4 flex-none place-items-center rounded-tag text-current', className)}
      {...props}
    />
  )
}

export { Chip, ChipIcon }
