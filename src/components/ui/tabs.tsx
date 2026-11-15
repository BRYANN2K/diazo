'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/lib/utils'
import { GlideIndicator } from './glide-indicator'

function Tabs({ className, orientation = 'horizontal', ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  )
}

/* 01 Foundations · Tabs: a well strip of icon + label tabs with a surface
   indicator that glides to the active tab on ease-in-out 200ms. `line` is
   the underlined strip, `card` the phone's full-width pane switcher. */
const tabsListVariants = cva(
  'group/tabs-list relative inline-flex w-fit items-center justify-center text-ink-2 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'gap-0.5 rounded-[9px] bg-well p-0.75 group-data-horizontal/tabs:h-8',
        line: 'gap-1 bg-transparent group-data-horizontal/tabs:h-8',
        /* the phone's pane switcher: a full-width 40px card in place of the sidebar */
        card: 'h-10 w-full gap-0.5 rounded-control bg-surface p-1 shadow-ring group-data-horizontal/tabs:h-10',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

const ACTIVE_TAB = '[data-slot=tabs-trigger][data-state=active]'

function TabsList({
  className,
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {variant === 'line' ? null : (
        <GlideIndicator
          activeSelector={ACTIVE_TAB}
          className="rounded-[7px] bg-surface shadow-[0_0_0_1px_var(--line),0_1px_2px_rgba(0,0,0,0.06)]"
        />
      )}
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative z-[1] inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] border border-transparent px-2 text-label whitespace-nowrap text-ink-2 transition-colors duration-fast group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-ink hover:duration-instant focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-50 data-[state=active]:font-medium data-[state=active]:text-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        'group-data-[variant=card]/tabs-list:h-full',
        'after:absolute after:bg-ink after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 text-copy outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
