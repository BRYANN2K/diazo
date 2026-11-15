import { cn } from '@/lib/utils'
import type { Frame } from '../../../shared/types'
import type { TextMatch } from '../../lib/actions/findText'
import { useT } from '../../lib/i18n'
import { LockIcon } from '../ui/icons'
import { Pressable } from '../ui/pressable'

/** One text match on the open page. */
export interface TextHit {
  frame: Frame
  /** the match's place among its frame's matches, which a single replace names */
  n: number
  match: TextMatch
}

/** Matches listed on the page; ↩ still steps through every one. */
const MAX_LISTED = 200

/**
 * ⌘F's page list: the text matches of the open page in reading order, under
 * the name of the frame they are in. A locked match (its layer or frame
 * locked) is found and listed, marked, and never replaced.
 */
export function FindTextList({
  hits,
  active,
  onGo,
}: {
  hits: TextHit[]
  active: number
  onGo: (index: number) => void
}) {
  const t = useT()
  const listed = hits.slice(0, MAX_LISTED)
  return (
    <ul className="flex flex-col p-1.5" aria-label={t('actions.findLabel')}>
      {listed.map((hit, i) => {
        const opensFrame = i === 0 || listed[i - 1]!.frame.id !== hit.frame.id
        const locked = !!hit.frame.locked || !!hit.match.locked
        return (
          <li key={`${hit.frame.id}:${i}`}>
            {opensFrame && (
              <p className="truncate px-2 pt-2 pb-0.5 text-caption text-ink-faint first:pt-0.5">{hit.frame.name}</p>
            )}
            <Pressable
              focus="none"
              id={`find-hit-${i}`}
              onClick={() => onGo(i)}
              className={cn(
                'flex w-full items-center gap-2 rounded-row px-2 py-1 text-left transition-colors duration-100 motion-reduce:transition-none',
                i === active ? 'bg-paper-deep' : 'hover:bg-sub',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-body text-ink-soft">
                {hit.match.before}
                <mark className="rounded-tag bg-brand/20 text-ink">{hit.match.text}</mark>
                {hit.match.after}
              </span>
              {locked && (
                <LockIcon
                  width={12}
                  height={12}
                  className="flex-none text-ink-faint"
                  aria-label={t('actions.findLocked')}
                />
              )}
            </Pressable>
          </li>
        )
      })}
    </ul>
  )
}
