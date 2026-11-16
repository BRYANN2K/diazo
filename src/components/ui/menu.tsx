import * as React from 'react'
import { cva } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* The row the dropdown, context and model menus share (01 Foundations ·
   MenuItem): 30px, the well under the pointer or the keyboard at once, a
   caption or key cap on the right. */
const menuItemVariants = cva(
  'flex min-h-[30px] w-full items-center gap-2 whitespace-nowrap rounded-row border-0 bg-transparent px-2.5 py-1 text-left text-body font-normal no-underline transition-colors duration-fast disabled:cursor-default disabled:text-ink-3 disabled:hover:bg-transparent',
  {
    variants: {
      tone: {
        default: 'text-ink hover:bg-well hover:duration-0',
        danger: 'text-danger hover:bg-danger-wash hover:duration-0',
      },
    },
    defaultVariants: { tone: 'default' },
  },
)

/** Trailing keyboard shortcut inside a menu item. */
function MenuHint({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="menu-hint"
      className={cn('ml-auto pl-3 font-mono text-micro whitespace-nowrap text-ink-3', className)}
      {...props}
    />
  )
}

export { MenuHint, menuItemVariants }
