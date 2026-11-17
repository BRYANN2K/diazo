import * as React from 'react'

import { cn } from '@/lib/utils'

import { Button } from './button'

/* 01 Foundations · Toast: the bottom-right card that confirms something
   happened. A surface at elevation 3, a tone dot (ok, agent, danger: never
   colour alone, the text says it too), the message and at most one action.
   It enters on the soft spring from 14px below; under reduced motion it
   fades. It sits above the safe area and clear of the canvas toolbar on
   phones; on a wider screen a page may move it with --float-right and
   --float-bottom (the canvas keeps it clear of its panels and zoom pill). */
const TONE_DOT = {
  ok: 'bg-ok',
  agent: 'bg-agent',
  danger: 'bg-danger',
} as const

/* where a toast sits on its own, and where a stack of them sits */
const TOAST_PLACE =
  'fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-[70] -translate-x-1/2 sm:bottom-[var(--float-bottom,12px)] sm:left-auto sm:right-[var(--float-right,12px)] sm:translate-x-0 sm:transition-[right,bottom] sm:duration-150'

function Toast({
  className,
  children,
  tone,
  depth,
  style,
  ...props
}: React.ComponentProps<'div'> & {
  tone?: keyof typeof TONE_DOT
  /** inside a ToastStack: 0 is the newest, in front; each layer behind
   *  takes the front toast's height, scales down 5% and rises 14px, and the
   *  fourth fades out */
  depth?: number
}) {
  const stacked = depth !== undefined
  return (
    <div
      data-slot="toast"
      role="status"
      aria-live="polite"
      data-tone={tone}
      data-depth={depth}
      className={cn(
        'flex max-w-[min(360px,calc(100vw-24px))] items-center gap-2.5 rounded-card bg-surface px-3.5 py-3 text-body font-medium text-ink shadow-pop animate-[toast-in_400ms_var(--spring-soft)_both]',
        stacked
          ? 'absolute right-0 bottom-0 origin-bottom transition-[transform,opacity] duration-slow ease-out'
          : TOAST_PLACE,
        /* behind the front one, a toast is cut to its height, so a taller
           front toast (two lines, a longer language) still lets it peek */
        stacked && depth > 0 && 'h-[var(--toast-front-h)] overflow-hidden',
        className,
      )}
      style={
        stacked
          ? {
              ...style,
              transform: `translateY(${-14 * depth}px) scale(${1 - 0.05 * depth})`,
              opacity: depth > 2 ? 0 : 1,
              zIndex: 10 - depth,
            }
          : style
      }
      {...props}
    >
      {tone ? <span aria-hidden className={cn('size-4 flex-none rounded-full', TONE_DOT[tone])} /> : null}
      {children}
    </div>
  )
}

/** Several toasts at once (Sonner's stack): the newest in front, the
 *  older ones layered behind it. Falsy children are skipped, so callers can
 *  pass every toast they might show; the last one given is the newest. */
function ToastStack({ children, className }: { children: React.ReactNode; className?: string }) {
  const toasts = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{
    depth?: number
  }>[]
  const stackRef = useFrontToastHeight()
  if (toasts.length === 0) return null
  return (
    <div
      ref={stackRef}
      data-slot="toast-stack"
      className={cn(TOAST_PLACE, 'h-[var(--toast-front-h,46px)] w-[min(360px,calc(100vw-24px))]', className)}
    >
      {toasts.map((toast, i) => React.cloneElement(toast, { depth: toasts.length - 1 - i }))}
    </div>
  )
}

/** Keeps --toast-front-h on the stack at the front toast's height (no
 *  re-render: the toasts behind read it from CSS). Runs after every render,
 *  since a new toast changes which one is in front. */
function useFrontToastHeight() {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const stack = ref.current
    const front = stack?.querySelector<HTMLElement>('[data-slot="toast"][data-depth="0"]')
    if (!stack || !front || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => stack.style.setProperty('--toast-front-h', `${front.offsetHeight}px`))
    observer.observe(front)
    return () => observer.disconnect()
  })
  return ref
}

/** The button inside a toast (“Reload”). */
function ToastAction(props: React.ComponentProps<typeof Button>) {
  return <Button size="sm" data-slot="toast-action" {...props} />
}

/** Leads a toast whose action is still running (an export rendering). */
function ToastSpinner({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="toast-spinner"
      aria-hidden
      className={cn('size-3.5 shrink-0 animate-spin rounded-full border-2 border-agent/25 border-t-agent', className)}
      {...props}
    />
  )
}

export { Toast, ToastAction, ToastSpinner, ToastStack }
