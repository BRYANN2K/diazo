import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/* text-base below md is deliberate: iOS zooms the viewport when a focused
   field is under 16px, and that zoom is what makes a mobile form feel broken.
   The design size comes back at md, where no such thing happens. */
export const fieldVariants = cva(
  'w-full min-w-0 text-base text-ink transition-[border-color,box-shadow,background-color] duration-fast outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger aria-invalid:animate-[field-shake_300ms_var(--ease-out)]',
  {
    variants: {
      variant: {
        /* 01 Foundations · Field: a well inside a line ring; on focus the
           surface, a signal edge and a 3px signal wash */
        default:
          'rounded-control border border-line bg-well px-2.5 focus:border-signal focus:bg-surface focus:ring-[3px] focus:ring-signal-wash md:text-body',
        /* the same well in a modal or form */
        well: 'rounded-control border border-line bg-well px-2.5 focus:border-signal focus:bg-surface focus:ring-[3px] focus:ring-signal-wash md:text-body',
        /* ids, keys, URLs, sizes — the mono well */
        mono: 'rounded-control border border-line bg-well px-2.25 font-mono focus:border-signal focus:bg-surface focus:ring-[3px] focus:ring-signal-wash md:text-label',
        /* lives inside another bordered shell (search rows, the prompt bar) */
        bare: 'border-0 bg-transparent p-0 focus:ring-0 md:text-copy',
        /* an editable heading: invisible until you hover or focus it */
        title:
          'rounded-control border border-transparent bg-transparent px-2 font-display font-semibold hover:border-line focus:border-signal focus:bg-surface md:text-lead',
      },
      inputSize: {
        sm: 'h-[30px] py-1',
        md: 'h-8 py-1.5',
        lg: 'h-10 py-2',
        auto: '',
      },
    },
    defaultVariants: { variant: 'default', inputSize: 'md' },
  },
)

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'> & VariantProps<typeof fieldVariants>>(
  function Input({ className, variant, inputSize, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(fieldVariants({ variant, inputSize, className }))}
        {...props}
      />
    )
  },
)

export { Input }
