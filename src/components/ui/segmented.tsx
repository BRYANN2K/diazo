import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'

import { cn } from '@/lib/utils'
import { GlideIndicator } from './glide-indicator'

/* One-of-N switches (01 Foundations · Segmented): ⌘F's scope, the theme, the
   dashboard's grid/list, the agent's model tier. Radix ToggleGroup makes the
   row a single tab stop that the arrow keys move through, and drives the
   selected look off data-state. The surface pill glides between options on
   the snap spring. Deselection is swallowed: these switches always have
   exactly one answer. */
function Segmented({
  className,
  value,
  onValueChange,
  children,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive.Root>, 'type' | 'value' | 'defaultValue' | 'onValueChange'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="segmented"
      value={value}
      onValueChange={(next) => next && onValueChange(next)}
      className={cn('relative flex rounded-[8px] bg-well p-0.5', className)}
      {...props}
    >
      <GlideIndicator
        activeSelector="[data-slot=segmented-item][data-state=on]"
        timing="snap"
        className="rounded-[6px] bg-surface shadow-ring"
      />
      {children}
    </ToggleGroupPrimitive.Root>
  )
}

function SegmentedItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-item"
      className={cn(
        'relative z-[1] min-h-[30px] flex-1 whitespace-nowrap rounded-[6px] border-0 bg-transparent px-2.5 py-0.75 text-label text-ink-2 transition-colors duration-fast hover:text-ink hover:duration-instant focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal data-[state=on]:font-medium data-[state=on]:text-ink sm:min-h-0 sm:flex-none',
        className,
      )}
      {...props}
    />
  )
}

/** Icon-only variant: a row of square buttons (grid / list). */
function SegmentedIcons({ className, ...props }: React.ComponentProps<typeof Segmented>) {
  return <Segmented className={cn('gap-0 overflow-hidden', className)} {...props} />
}

function SegmentedIconItem({ className, ...props }: React.ComponentProps<typeof SegmentedItem>) {
  return (
    <SegmentedItem
      className={cn(
        'grid min-h-[30px] flex-none place-items-center px-2.5 text-ink-3 data-[state=on]:text-ink sm:min-h-0 sm:py-1.5',
        className,
      )}
      {...props}
    />
  )
}

export { Segmented, SegmentedItem, SegmentedIcons, SegmentedIconItem }
