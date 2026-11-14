import { useCallback, useEffect, useState } from 'react'
import type { LibraryItemSummary, RuleFinding } from '../../../shared/library'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { SelectionBar, SelectionBarAction } from '../ui/selection-bar'
import { ItemThumb } from './ItemThumb'

type InboxItem = LibraryItemSummary & { findings: RuleFinding[] }

/**
 * What the rules flagged, in one place: drafts and items with findings,
 * each with why. Accept, Hide or re-run the rules on a selection; a
 * duplicate shows both images and "Keep this one" hides the other.
 */
export function LibraryInbox({ libraryId, onChanged }: { libraryId: string; onChanged?: () => void }) {
  const t = useT()
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api
      .libraryInbox(libraryId)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [libraryId])
  useEffect(load, [load])

  async function setStatus(ids: string[], status: 'active' | 'hidden') {
    if (!ids.length) return
    setBusy(true)
    try {
      await api.setLibraryItemsStatus(libraryId, ids, status)
      setItems((list) => (list ?? []).filter((i) => !ids.includes(i.id)))
      setPicked(new Set())
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  if (!items) return <p className="text-copy text-ink-faint">{t('library.loading')}</p>
  if (!items.length) return <p className="text-copy text-ink-faint">{t('library.inboxEmpty')}</p>
  const byId = new Map(items.map((i) => [i.id, i]))
  return (
    <div className="flex flex-col gap-3" data-testid="library-inbox">
      <SelectionBar
        count={picked.size}
        total={items.length}
        actions={
          <>
            <SelectionBarAction disabled={busy || !picked.size} onClick={() => void setStatus([...picked], 'active')}>
              {t('library.accept')}
            </SelectionBarAction>
            <SelectionBarAction disabled={busy || !picked.size} onClick={() => void setStatus([...picked], 'hidden')}>
              {t('library.hide')}
            </SelectionBarAction>
            <SelectionBarAction disabled={busy} onClick={() => void api.reindexLibrary(libraryId).then(load)}>
              {t('library.rerunRules')}
            </SelectionBarAction>
          </>
        }
      />
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const duplicateOf = item.findings.find((f) => f.kind === 'duplicate')?.itemId
          const other = duplicateOf ? byId.get(duplicateOf) : undefined
          return (
            <li
              key={item.id}
              data-inbox-item={item.id}
              className="flex gap-3 rounded-card bg-surface p-2.5 shadow-ring"
            >
              <Checkbox
                aria-label={item.id}
                checked={picked.has(item.id)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })
                }
              />
              <span className="h-16 w-24 flex-none overflow-hidden rounded-row bg-sub">
                <ItemThumb item={item} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-caption text-ink">{item.id}</span>
                <span className="text-caption text-ink-faint">
                  {item.status === 'draft' ? t('library.status_draft') : ''}
                </span>
                {item.findings.map((f, i) => (
                  <span key={i} className="text-caption text-ink-soft">
                    {f.message}
                  </span>
                ))}
              </div>
              {duplicateOf && (
                <div className="flex flex-none items-center gap-2">
                  {other && (
                    <span className="h-16 w-24 overflow-hidden rounded-row bg-sub">
                      <ItemThumb item={other} />
                    </span>
                  )}
                  <Button size="sm" disabled={busy} onClick={() => void setStatus([duplicateOf], 'hidden')}>
                    {t('library.keepThisOne')}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
