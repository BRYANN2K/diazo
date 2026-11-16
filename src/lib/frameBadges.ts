/** How a frame's verdict badge (anti-slop lint, frame checks) sits next to its
 *  name, per the Frame checks frame: a clean verdict is a quiet green tick
 *  that stays; one with issues stays out of sight until the frame is hovered,
 *  focused or selected, then wears red when an error is among them and the
 *  yellow caution tone for warnings alone. */
export type VerdictTone = 'ok' | 'danger' | 'caution'

export function verdictTone(issues: number, errors: number): VerdictTone {
  if (issues === 0) return 'ok'
  return errors > 0 ? 'danger' : 'caution'
}

/** Hidden at rest, shown while the frame (the `group` wrapper) is hovered,
 *  holds focus or is selected. Nothing for a clean verdict. At rest the badge
 *  is `sr-only`: out of the title row's flow, so the frame's name keeps the
 *  whole width, and its label still reaches assistive tech. */
export function verdictReveal(issues: number): string {
  return issues === 0
    ? ''
    : 'sr-only opacity-0 transition-opacity duration-fast group-hover:not-sr-only group-hover:opacity-100 group-focus-within:not-sr-only group-focus-within:opacity-100 group-data-[selected]:not-sr-only group-data-[selected]:opacity-100'
}
