import * as React from 'react'

import { cn } from '@/lib/utils'

type Box = { x: number; y: number; w: number; h: number; first: boolean }

/**
 * The surface pill that glides under the active option of a tab strip or a
 * segmented control (redesign: Tabs glide on ease-in-out 200ms, Segmented on
 * the snap spring). It measures the active child of its parent, found by
 * `activeSelector`, and follows it through resizes and selection changes. The
 * first placement does not animate; reduced motion makes every move instant
 * (the global rule leaves only opacity transitions).
 *
 * Render it as the first child of a `relative` container; the options must
 * sit above it (`relative z-[1]`).
 */
function GlideIndicator({
  activeSelector,
  className,
  timing = 'tab',
}: {
  /** finds the active option inside the indicator's parent */
  activeSelector: string
  className?: string
  /** `tab` glides on ease-in-out 200ms, `snap` on the snap spring (320ms) */
  timing?: 'tab' | 'snap'
}) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [box, setBox] = React.useState<Box | null>(null)

  React.useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const measure = () => {
      const active = parent.querySelector<HTMLElement>(activeSelector)
      if (!active) {
        setBox(null)
        return
      }
      const x = active.offsetLeft
      const y = active.offsetTop
      const w = active.offsetWidth
      const h = active.offsetHeight
      setBox((prev) => {
        if (prev && prev.x === x && prev.y === y && prev.w === w && prev.h === h) return prev
        return { x, y, w, h, first: prev === null }
      })
    }
    measure()
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    resize?.observe(parent)
    for (const child of Array.from(parent.children)) resize?.observe(child)
    const mutation = new MutationObserver(measure)
    mutation.observe(parent, { attributes: true, subtree: true, childList: true })
    return () => {
      resize?.disconnect()
      mutation.disconnect()
    }
  }, [activeSelector])

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="glide-indicator"
      className={cn(
        'pointer-events-none absolute top-0 left-0 z-0',
        box &&
          !box.first &&
          (timing === 'snap'
            ? 'transition-[transform,width,height] duration-[320ms] ease-spring-snap'
            : 'transition-[transform,width,height] duration-normal ease-in-out'),
        !box && 'opacity-0',
        className,
      )}
      style={box ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h } : undefined}
    />
  )
}

export { GlideIndicator }
