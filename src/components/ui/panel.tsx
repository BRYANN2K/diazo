import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { Button } from './button'
import { CollapsibleTrigger } from './collapsible'
import { Tooltip } from './tooltip'
import { XIcon } from './icons'
import { GlideIndicator } from './glide-indicator'

const ACTIVE_PANEL_TAB = '[data-slot=panel-tab][data-state=active], [data-slot=panel-icon-tab][data-state=active]'

/* The canvas islands (01 Foundations · Panel: paper, radius 14, elevation 2).
   On a wide screen they float over the board; inside a mobile Sheet they fill it. That used to be a `.side-panel`
   class the page reached back through with descendant selectors — it is a prop
   now, so the panel's two shapes live in one place. */
const panelVariants = cva('flex min-w-0 flex-col overflow-hidden bg-paper text-body text-ink', {
  variants: {
    surface: {
      floating: 'pointer-events-auto absolute z-[35] rounded-panel shadow-panel',
      /* a column flush with the window's edge and the bar above it, the
         canvas beside it (Settings → Appearance → Canvas panels); the
         caller says which side takes the hairline */
      docked: 'pointer-events-auto absolute inset-y-0 z-[35] rounded-none border-line shadow-none',
      /* filling a Sheet: no chrome of its own, the sheet provides it */
      inline: 'h-full w-full rounded-none border-0 shadow-none',
    },
  },
  defaultVariants: { surface: 'floating' },
})

/** where a canvas panel lives: over the board, docked to its edge, or
 *  filling a phone's sheet */
export type PanelSurface = NonNullable<VariantProps<typeof panelVariants>['surface']>

export interface PanelResize {
  label: string
  edge: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (width: number) => void
}

/** Panels whose edge is being dragged right now (see `data-panel-resizing`). */
let resizingPanels = 0

function Panel({
  className,
  surface,
  resize,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof panelVariants> & { resize?: PanelResize }) {
  const drag = React.useRef<{ x: number; width: number } | null>(null)
  /* marks the panel while its edge is dragged; styles.css pauses the chrome's
     position transitions then, so neighbours follow the pointer in step */
  const [dragging, setDragging] = React.useState(false)
  /* mirrored on <body>, which the rule keys on: a `body:has(…) *` rule
     restyled the whole page on every DOM insertion anywhere (each pan tick) */
  React.useEffect(() => {
    if (!dragging) return
    resizingPanels += 1
    document.body.toggleAttribute('data-panel-resizing', true)
    return () => {
      resizingPanels -= 1
      /* two edges can be dragged at once (two fingers); the last one clears it */
      if (resizingPanels === 0) document.body.toggleAttribute('data-panel-resizing', false)
    }
  }, [dragging])
  const endDrag = () => {
    drag.current = null
    setDragging(false)
  }
  const resizing = surface !== 'inline' ? resize : undefined
  const setWidth = (width: number) => {
    if (resizing) resizing.onResize(Math.round(Math.max(resizing.min, Math.min(resizing.max, width))))
  }

  return (
    <div
      data-slot="panel"
      data-panel-resizing={dragging || undefined}
      className={cn(panelVariants({ surface, className }))}
      style={resizing ? { ...style, width: resizing.width } : style}
      {...props}
    >
      {children}
      {resizing && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={resizing.label}
          aria-orientation="vertical"
          aria-valuemin={resizing.min}
          aria-valuemax={resizing.max}
          aria-valuenow={resizing.width}
          className={cn(
            'absolute inset-y-2 z-10 w-1.5 touch-none cursor-col-resize rounded-full focus-visible:bg-ink/20 focus-visible:outline-none',
            resizing.edge === 'right' ? 'right-0' : 'left-0',
          )}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            drag.current = { x: e.clientX, width: resizing.width }
            setDragging(true)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            e.stopPropagation()
            const delta = (e.clientX - drag.current.x) * (resizing.edge === 'right' ? 1 : -1)
            setWidth(drag.current.width + delta)
          }}
          onPointerUp={(e) => {
            endDrag()
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(e) => {
            const direction = resizing.edge === 'right' ? 1 : -1
            let width: number
            if (e.key === 'ArrowLeft') width = resizing.width - 10 * direction
            else if (e.key === 'ArrowRight') width = resizing.width + 10 * direction
            else if (e.key === 'Home') width = resizing.min
            else if (e.key === 'End') width = resizing.max
            else return
            e.preventDefault()
            e.stopPropagation()
            setWidth(width)
          }}
        />
      )}
    </div>
  )
}

/** Sticky header: title or tabs on the left, actions on the right. Sentence
 *  case in the UI sans — the white system has no uppercase mono headers. */
const PanelHeader = React.forwardRef<HTMLElement, React.ComponentProps<'header'>>(function PanelHeader(
  { className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      data-slot="panel-header"
      className={cn(
        'sticky top-0 z-[2] flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-line bg-paper pr-1.5 pl-1.5 text-body font-semibold text-ink [&>:first-child:not([data-slot=panel-tabs])]:pl-2',
        className,
      )}
      {...props}
    />
  )
})

const PanelBody = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(function PanelBody(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="panel-body"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      {...props}
    />
  )
})

/** The tab strip some panel headers carry instead of a title. Goes inside a
 *  <PanelTabsRoot> together with the PanelTabPanels it switches. */
function PanelTabsRoot({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="panel-tabs-root"
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      {...props}
    />
  )
}

const PanelTabs = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentProps<typeof TabsPrimitive.List>
>(function PanelTabs({ className, ...props }, ref) {
  /* min-w-0 so a long tab strip shrinks instead of shoving the close button
     out through the panel's padding */
  return (
    <TabsPrimitive.List
      ref={ref}
      data-slot="panel-tabs"
      className={cn('relative flex min-w-0 gap-0.5 rounded-[9px] bg-well p-0.75', className)}
      {...props}
    >
      <GlideIndicator activeSelector={ACTIVE_PANEL_TAB} className="rounded-[7px] bg-surface shadow-ring" />
      {props.children}
    </TabsPrimitive.List>
  )
})

/* forwards its ref so a Tooltip can anchor on an icon-only tab */
const PanelTab = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentProps<typeof TabsPrimitive.Trigger>
>(function PanelTab({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      data-slot="panel-tab"
      className={cn(
        'relative z-[1] inline-flex h-[26px] items-center gap-1.25 whitespace-nowrap rounded-[7px] px-2.25 text-label text-ink-2 transition-colors duration-fast hover:text-ink hover:duration-instant focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal data-[state=active]:font-medium data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  )
})

/** A tab with an icon and its label, on the strip's gliding surface. `compact`
 *  folds the label away when the strip runs out of room (useFitLevel): the
 *  icon stays, the label is kept as the accessible name, and the design
 *  system's Tooltip shows it on hover and keyboard focus. `title` is that
 *  tooltip's text when it should say more than the label. */
const PanelIconTab = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof TabsPrimitive.Trigger> & {
    icon: React.ReactNode
    /** a count pinned to the tab's corner, outside the folding label */
    badge?: React.ReactNode
    compact?: boolean
  }
>(function PanelIconTab({ className, icon, badge, compact = false, title, children, ...props }, ref) {
  /* one element whether folded or not: the tooltip is always there and only
     opens while folded, so a tab that unfolds under an arrow key keeps focus */
  return (
    <Tooltip label={title ?? children} side="bottom" disabled={!compact}>
      <IconTabTrigger
        ref={ref}
        data-slot="panel-icon-tab"
        data-compact={compact ? '' : undefined}
        className={cn(
          'group relative z-[1] inline-flex h-[26px] shrink-0 items-center rounded-[7px] px-2.25 font-sans text-label font-normal normal-case text-ink-2 transition-colors duration-fast hover:text-ink hover:duration-instant focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal data-[state=active]:font-medium data-[state=active]:text-ink',
          className,
        )}
        {...props}
      >
        <span className="grid size-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{icon}</span>
        <span className={compact ? 'sr-only' : 'block whitespace-nowrap pl-1.25'}>{children}</span>
        {badge}
      </IconTabTrigger>
    </Tooltip>
  )
})

/* the tooltip's trigger writes its own `data-state` (closed, delayed-open)
   onto its child; the tab's `active` / `inactive` is what the strip's
   gliding surface and the active weight read, so the tooltip's is dropped */
const IconTabTrigger = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof TabsPrimitive.Trigger>>(
  function IconTabTrigger({ 'data-state': _tooltipState, ...props }: TabTriggerProps, ref) {
    return <TabsPrimitive.Trigger ref={ref} {...props} />
  },
)
type TabTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger> & { 'data-state'?: string }

function PanelTabPanel({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="panel-tab-panel"
      className={cn('flex min-h-0 flex-1 flex-col outline-none', className)}
      {...props}
    />
  )
}

/** A full-width row that expands the section under it. Wrap it and its panel
 *  in <Collapsible> — Radix does the aria-controls/expanded wiring. */
function PanelDisclosure({ className, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="panel-disclosure"
      className={cn(
        'flex w-full items-center gap-2 border-t border-line bg-transparent px-3 py-2.5 text-left text-label text-ink-2 transition-colors duration-fast hover:text-ink hover:duration-instant',
        className,
      )}
      {...props}
    />
  )
}

/** The small ✕ that closes a rail. Draws its own glyph: a text ✕ sits on a
 *  baseline and never centres in the button, the icon does. */
function PanelClose({
  className,
  label,
  children: _children,
  ...props
}: React.ComponentProps<'button'> & { label?: string }) {
  const t = useT()
  const text = label ?? t('common.close')
  return (
    <Tooltip label={text} side="bottom" align="end">
      <Button
        variant="bare"
        size="icon-sm"
        aria-label={text}
        className={cn('size-7 shrink-0 rounded-control text-ink-2 hover:bg-well hover:text-ink', className)}
        {...props}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Tooltip>
  )
}

export {
  Panel,
  PanelHeader,
  PanelBody,
  PanelTabsRoot,
  PanelTabs,
  PanelTab,
  PanelIconTab,
  PanelTabPanel,
  PanelClose,
  PanelDisclosure,
  panelVariants,
}
