import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* Diazo labels a control three ways, all sentence case in the UI sans: a
   quiet caption over a field in a dense panel, the label step over a form row
   (01 Foundations · Field: 12px medium ink, 6px above the well), or a bolder
   body line that heads a group. Labels never wrap. */
const labelVariants = cva('block truncate text-ink-2', {
  variants: {
    variant: {
      caption: 'mb-1 text-caption text-ink-3',
      form: 'mb-1.5 text-label font-medium text-ink',
      plain: 'mb-1 text-body/4 font-semibold text-ink',
    },
  },
  defaultVariants: { variant: 'caption' },
})

function Label({ className, variant, ...props }: React.ComponentProps<'label'> & VariantProps<typeof labelVariants>) {
  return <label data-slot="label" className={cn(labelVariants({ variant, className }))} {...props} />
}

/** A label + control + optional hint, stacked. */
function Field({
  label,
  hint,
  labelVariant,
  htmlFor,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  label?: React.ReactNode
  hint?: React.ReactNode
  labelVariant?: VariantProps<typeof labelVariants>['variant']
  htmlFor?: string
}) {
  return (
    <div data-slot="field" className={cn('min-w-0', className)} {...props}>
      {label ? (
        <Label variant={labelVariant} htmlFor={htmlFor}>
          {label}
        </Label>
      ) : null}
      {children}
      {hint ? <p className="mt-1.5 text-caption text-ink-3">{hint}</p> : null}
    </div>
  )
}

export { Field, Label, labelVariants }
