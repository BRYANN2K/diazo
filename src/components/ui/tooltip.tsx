import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

/* Labels for controls that show an icon and nothing else. A `title` attribute
   would do the same job in a browser's own styling, on its own ~1s delay, and
   not at all on touch; this one matches the app, opens promptly, and follows
   the control when the canvas is scrolled or zoomed. */

/* whether a TooltipProvider sits above: the app mounts one at its root, a
   component rendered alone (a test, a story) gets one of its own */
const ProvidedContext = React.createContext(false)

function TooltipProvider({ delayDuration = 250, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <ProvidedContext.Provider value>
      <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
    </ProvidedContext.Provider>
  )
}

/** Wraps a single focusable child. `label` is the text; everything else is
 *  positioning, which Radix handles. `disabled` keeps it shut without taking
 *  the wrapper away, so a control that gains or loses its tooltip keeps its
 *  element (and the keyboard focus on it). */
function Tooltip({
  label,
  side = 'top',
  align = 'center',
  disabled = false,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Content>, 'content'> & {
  label: React.ReactNode
  disabled?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const provided = React.useContext(ProvidedContext)
  if (!label) return <>{children}</>
  const tooltip = (
    <TooltipPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip"
          side={side}
          align={align}
          sideOffset={7}
          collisionPadding={8}
          className={cn(
            'z-[90] max-w-[260px] rounded-[6px] bg-ink px-2 py-[5px] text-caption font-medium leading-snug text-on-ink',
            'animate-[fade-in_120ms_var(--ease-out)] data-[state=closed]:animate-none',
            className,
          )}
          {...props}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
  return provided ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>
}

export { Tooltip, TooltipProvider }
