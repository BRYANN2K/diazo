import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const textareaVariants = cva(
  'w-full min-w-0 resize-none font-[inherit] text-base text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-60 md:text-body/5 aria-invalid:border-danger aria-invalid:animate-[field-shake_300ms_var(--ease-out)]',
  {
    variants: {
      variant: {
        default:
          'rounded-control border border-line bg-well px-2.5 py-2 transition-[border-color,box-shadow,background-color] duration-fast focus:border-signal focus:bg-surface focus:ring-[3px] focus:ring-signal-wash',
        /* the Input well */
        well: 'rounded-control border border-line bg-well px-2.5 py-2 transition-[border-color,box-shadow,background-color] duration-fast focus:border-signal focus:bg-surface focus:ring-[3px] focus:ring-signal-wash',
        /* an HTML editor: the dark code well at the caption step, tabs two wide */
        code: 'border-0 bg-code p-3 font-mono text-caption/normal text-code-ink [tab-size:2] md:text-caption/normal',
        /* composers: the surrounding card is the field, this is just the text */
        bare: 'border-0 bg-transparent p-0',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>
>(function Textarea({ className, variant, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn(textareaVariants({ variant, className }))} {...props} />
})

export { Textarea, textareaVariants }
