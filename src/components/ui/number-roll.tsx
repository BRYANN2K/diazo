import * as React from 'react'

import { cn } from '@/lib/utils'

const DIGIT = /[0-9]/

/**
 * 01 Foundations · NumberRoll: a cost, token or count whose changed digits
 * roll like an odometer instead of jumping (420ms, ease-out). The digits that
 * did not change stay still. Mono and tabular, so the width never moves.
 * Under reduced motion the new value simply replaces the old one.
 */
function NumberRoll({
  value,
  size = 'sm',
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  /** the formatted value ("$0.497", "12,480 tokens") */
  value: string
  /** sm 13px in rows and meters, lg 28px for Usage totals */
  size?: 'sm' | 'lg'
}) {
  /* the value shown before this one, kept from the last change (the
     reset-during-render pattern: no effect, no extra paint) */
  const [current, setCurrent] = React.useState(value)
  const [previous, setPrevious] = React.useState(value)
  if (value !== current) {
    setPrevious(current)
    setCurrent(value)
  }
  const chars = Array.from(value)
  const before = Array.from(previous)
  /* digits are aligned from the right, where a counter changes */
  const offset = chars.length - before.length
  return (
    <span
      data-slot="number-roll"
      className={cn(
        'inline-flex items-baseline font-mono font-medium tabular-nums leading-none text-ink',
        size === 'lg' ? 'text-[28px] tracking-[-0.02em]' : 'text-[13px]',
        className,
      )}
      aria-label={value}
      {...props}
    >
      {chars.map((ch, i) => {
        const old = before[i - offset]
        const rolls = old !== undefined && old !== ch && DIGIT.test(ch) && DIGIT.test(old)
        if (!rolls) {
          return (
            <span key={i} aria-hidden>
              {ch}
            </span>
          )
        }
        return (
          <span key={i} aria-hidden className="inline-block h-[1em] overflow-hidden align-baseline">
            <span
              key={value}
              className="flex flex-col animate-[number-roll_var(--dur-slower)_var(--ease-out)_both] [&>span]:block [&>span]:h-[1em]"
            >
              <span>{old}</span>
              <span>{ch}</span>
            </span>
          </span>
        )
      })}
    </span>
  )
}

export { NumberRoll }
