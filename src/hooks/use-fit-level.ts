import { useLayoutEffect, useState } from 'react'

/** How far a row has to fold to fit its box: 0 is the full row, each level
 *  one step more compact (labels to icons, say), up to `maxLevel`. The row is
 *  measured before paint, so a fold never flashes: when the content overflows
 *  the element's content box the level goes up one and the row renders
 *  again. A new width or a new `content` key starts over
 *  from the full row, and so does a web font finishing loading. The element
 *  should keep its width whatever the level (a header, a flex-1 strip), so a
 *  fold cannot feed back into its size. */
export function useFitLevel<T extends HTMLElement>(
  maxLevel: number,
  content: string,
): { measure: (el: T | null) => void; level: number } {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  const [level, setLevel] = useState(0)
  const [seen, setSeen] = useState('')
  /* a web font landing changes every label's width */
  const [fonts, setFonts] = useState(0)

  const key = `${content}|${width}|${fonts}`
  if (key !== seen) {
    setSeen(key)
    setLevel(0)
  }

  useLayoutEffect(() => {
    if (!el) return
    /* both are missing outside a real browser (jsdom) */
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setWidth(Math.round(el.clientWidth)))
    observer?.observe(el)
    const fontSet = 'fonts' in document ? document.fonts : null
    const refit = () => setFonts((n) => n + 1)
    fontSet?.addEventListener('loadingdone', refit)
    return () => {
      observer?.disconnect()
      fontSet?.removeEventListener('loadingdone', refit)
    }
  }, [el])

  useLayoutEffect(() => {
    if (!el || level >= maxLevel) return
    if (overflows(el)) {
      // eslint-disable-next-line react/set-state-in-effect -- folds after measuring the DOM, before paint
      setLevel(level + 1)
    }
    /* `seen` changes with the content and the width: measure again then */
  }, [el, level, maxLevel, seen])

  return { measure: setEl, level }
}

/** Whether a row's children reach past its content box. `scrollWidth` alone
 *  misses a flex row that runs into its own end padding, so the children's
 *  far edge is checked against the padding edge too. Children out of the
 *  flow (a strip's gliding indicator, which follows the open tab and may be
 *  mid-transition) do not count: `scrollWidth` is read only without them. */
function overflows(el: HTMLElement): boolean {
  const children = [...el.children]
  const flow = children.filter((child) => {
    const position = getComputedStyle(child).position
    return position !== 'absolute' && position !== 'fixed'
  })
  if (flow.length === children.length && el.scrollWidth > el.clientWidth + 1) return true
  const box = el.getBoundingClientRect()
  const end = box.right - (parseFloat(getComputedStyle(el).paddingRight) || 0)
  let right = box.left
  for (const child of flow) right = Math.max(right, child.getBoundingClientRect().right)
  return right > end + 0.5
}
