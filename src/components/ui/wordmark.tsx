import * as React from 'react'

import { cn } from '@/lib/utils'
import { DiazoWordmark, Logo } from '../Logo'

/** The mark + "diazo" lockup used in headers, the auth card and the footer.
 *  The word is the outlined Familjen Grotesk wordmark, in the text colour
 *  with its blue dot, and reads as "Diazo" to assistive tech. */
function Wordmark({
  size = 'md',
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  size?: 'sm' | 'md'
}) {
  return (
    <span
      data-slot="wordmark"
      className={cn('flex items-center', size === 'sm' ? 'gap-1.5' : 'gap-2', className)}
      {...props}
    >
      <Logo className={size === 'sm' ? 'size-[24px]' : 'size-[28px]'} />
      <DiazoWordmark height={size === 'sm' ? 18 : 22} className="translate-y-[1px]" />
    </span>
  )
}

export { Wordmark }
