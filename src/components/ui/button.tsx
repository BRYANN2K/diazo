import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/* Diazo's button (01 Foundations · Button): a surface drawn by a 1px ring
   rather than a border, one ink primary per screen, and the agent tone for an
   action an agent will carry out. Hover changes colour only (80ms in, 140ms
   out); a press scales to .97 over 140ms. The border stays in the base
   (transparent) so callers that set a border colour keep working. */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control',
    'border font-medium transition-[background-color,border-color,color,box-shadow,transform]',
    'duration-fast ease-out hover:duration-instant active:scale-[0.97]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
    'disabled:pointer-events-none disabled:opacity-45',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /* secondary, the workhorse: surface, line ring, the well under the pointer */
        default: 'border-transparent bg-surface text-ink shadow-ring hover:bg-well',
        primary: 'border-transparent bg-ink text-on-ink hover:bg-ink-2',
        /* toolbars, menus, a dialog's Cancel: no ring until the pointer is on it */
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-well hover:text-ink',
        /* an action an agent carries out (Ask Diazo): orange wash and the agent dot */
        agent:
          "border-transparent bg-agent-wash text-agent-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--agent)_35%,transparent)] before:size-[7px] before:flex-none before:rounded-full before:bg-agent before:content-[''] hover:bg-[color-mix(in_srgb,var(--agent)_16%,transparent)]",
        danger: 'border-transparent bg-transparent text-danger shadow-ring hover:bg-danger-wash',
        /* bare text action — menu rows, inline destructive links */
        bare: 'border-transparent bg-transparent text-ink-2 hover:bg-well hover:text-ink',
        'bare-danger': 'border-transparent bg-transparent text-danger hover:bg-danger-wash',
        link: 'border-transparent bg-transparent text-ink underline-offset-4 hover:underline active:scale-100',
        /* filled destructive — the retry affordance on failed tasks */
        'danger-solid': 'border-danger bg-danger text-white hover:border-ink hover:bg-ink hover:text-on-ink',
        /* flat ink fill: compact affordances inside cards */
        solid: 'border-transparent bg-ink text-on-ink hover:bg-ink-2 disabled:opacity-40',
        /* sits on an ink surface — foreground and hover invert with the theme */
        inverse: 'border-transparent bg-transparent text-on-ink hover:bg-on-ink/15',
      },
      size: {
        pill: 'h-[22px] rounded-full px-2 text-caption font-medium',
        sm: 'h-[26px] px-[9px] text-label',
        md: 'h-[30px] px-3 text-body',
        lg: 'h-9 justify-center px-4 text-copy',
        /* the header and toolbar action with a leading glyph (Import, New canvas) */
        bar: 'h-[30px] pl-2.5 pr-3 text-body',
        icon: 'size-[30px] p-0',
        'icon-sm': 'size-[26px] rounded-tag p-0',
        /* a text action inside a line of copy or a selection bar ("Clear",
           "Select page", "Codex & other clients →"): no box, no fill, the
           caption step. Pair it with `bare` or `link`. */
        inline: 'h-auto gap-1 rounded-tag p-0 text-caption hover:bg-transparent active:scale-100',
      },
      /* stretches to the container — the mobile default for primary actions */
      block: { true: 'w-full justify-center', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'md', block: false },
  },
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="button"
      /* A bare <button> inside a form is a submit button, so any Button that
         is not explicitly a submit would be activated by Enter in a text
         field — on the sign-in form that meant Enter firing "Forgot
         password?". Default to "button"; forms opt in with type="submit". */
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(buttonVariants({ variant, size, block, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
