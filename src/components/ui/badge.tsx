import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* 01 Foundations · Badge: a 20px status tag for counts, roles, states and
   model names, so the tones below are the vocabulary — nothing should invent
   its own tag colour, and a state is never told by colour alone (agent and ok
   carry a dot, danger a "!"). `shape="pill"` is the rounder, roomier tag a
   review header names its source with (a repo, a site, a Figma file); it
   truncates. */
const dot = "before:size-1.5 before:flex-none before:rounded-full before:content-['']"
const badgeVariants = cva(
  'inline-flex items-center gap-1.25 whitespace-nowrap border border-transparent text-caption font-semibold tracking-normal',
  {
    variants: {
      tone: {
        /* neutral: counts, Default */
        default: 'bg-well text-ink-2',
        /* selected, You */
        signal: 'bg-signal-wash text-signal',
        /* Writing, Queued for Orca, agent-made */
        agent: cn('bg-agent-wash text-agent-ink before:bg-agent', dot),
        /* Connected, Passed */
        ok: cn('bg-ok-wash text-ok before:bg-ok', dot),
        /* hover or selection only */
        caution: 'bg-[color-mix(in_srgb,var(--caution)_22%,transparent)] text-caution-ink',
        /* Failed: always with its text */
        danger: "bg-danger-wash text-danger before:font-extrabold before:content-['!']",
        admin: 'bg-signal-wash text-signal',
        banned: "bg-danger-wash text-danger before:font-extrabold before:content-['!']",
        accent: 'bg-danger-wash text-danger',
        outline: 'bg-transparent text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]',
        /* the one highlighted option in a set ("Popular") */
        brand: 'bg-signal text-white',
        /* a confirmed state ("verified") */
        success: cn('bg-ok-wash text-ok before:bg-ok', dot),
      },
      shape: {
        tag: 'h-5 rounded-tag px-1.75',
        /* inline-block, not flex: an ellipsis only applies to a block's own text */
        pill: 'inline-block max-w-full truncate rounded-pill px-[9px] py-[5px] sm:max-w-[240px]',
      },
      interactive: {
        true: 'cursor-pointer transition-colors hover:bg-current/10',
        false: '',
      },
    },
    /* the neutral pill sits on a paper fill rather than the hairline alone */
    compoundVariants: [{ tone: 'default', shape: 'pill', className: 'bg-paper' }],
    defaultVariants: { tone: 'default', shape: 'tag', interactive: false },
  },
)

/* forwards its ref, so a Tooltip can anchor on a badge (the frame checks) */
const Badge = React.forwardRef<
  HTMLSpanElement,
  React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }
>(function Badge({ className, tone, shape, interactive, asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot : 'span'
  return (
    <Comp
      ref={ref}
      data-slot="badge"
      className={cn(badgeVariants({ tone, shape, interactive, className }))}
      {...props}
    />
  )
})

export { Badge, badgeVariants }
