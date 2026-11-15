import * as React from 'react'

import { cn } from '@/lib/utils'

/* 01 Foundations · Toast: the bottom-right card that confirms something
   happened. A surface at elevation 3, a tone dot (ok, agent, danger: never
   colour alone, the text says it too), the message and at most one action.
   It enters on the soft spring from 14px below; under reduced motion it
   fades. It sits above the safe area and clear of the canvas toolbar on
   phones. */
const TONE_DOT = {
  ok: 'bg-ok',
  agent: 'bg-agent',
  danger: 'bg-danger',
} as const

function Toast({
  className,
  children,
  tone,
  ...props
}: React.ComponentProps<'div'> & { tone?: keyof typeof TONE_DOT }) {
  return (
    <div
      data-slot="toast"
      role="status"
      aria-live="polite"
      data-tone={tone}
      className={cn(
        'fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-[70] flex max-w-[min(360px,calc(100vw-24px))] -translate-x-1/2 items-center gap-2.5 rounded-card bg-surface px-3.5 py-3 text-body font-semibold text-ink shadow-pop animate-[toast-in_400ms_var(--spring-soft)_both] sm:bottom-3 sm:left-auto sm:right-3 sm:translate-x-0',
        className,
      )}
      {...props}
    >
      {tone ? <span aria-hidden className={cn('size-4 flex-none rounded-full', TONE_DOT[tone])} /> : null}
      {children}
    </div>
  )
}

/** The inverted button inside a toast (“Reload”). */
function ToastAction({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="toast-action"
      className={cn(
        'whitespace-nowrap rounded-[6px] border-0 bg-transparent px-2 py-0.75 text-label font-medium text-ink shadow-ring transition-colors duration-fast hover:bg-well hover:duration-instant',
        className,
      )}
      {...props}
    />
  )
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

export { Toast, ToastAction, ToastSpinner }
