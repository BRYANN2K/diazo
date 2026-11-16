import { flushSync } from 'react-dom'
import { prefersReducedMotion } from './motion'

/** the view-transition name the destination of a shared expand wears */
export const SHARED_EXPAND = 'shared-expand'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> }
}

/**
 * The redesign's shared expand (Libraries 2 · Item view): the tile that was
 * pressed grows into the view it opens. `from` wears the shared name for the
 * old picture, `update` renders the new view synchronously, and whatever in it
 * carries `SHARED_EXPAND` is the end of the morph. Without View Transitions,
 * or under reduced motion, it simply runs `update`.
 */
export function sharedExpand(from: Element | null, update: () => void): void {
  const doc = document as ViewTransitionDocument
  if (!from || !doc.startViewTransition || prefersReducedMotion()) {
    update()
    return
  }
  const el = from as HTMLElement
  el.style.viewTransitionName = SHARED_EXPAND
  doc.startViewTransition(() => {
    el.style.viewTransitionName = ''
    flushSync(update)
  })
}
