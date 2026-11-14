import { useEffect, useMemo, useState } from 'react'
import type { Frame } from '../../../shared/types'
import { api } from '../../lib/api'
import { refsIn, revKey, type LibraryRef } from '../../lib/libraryRefs'
import { replaceLibraryBlock } from '../../lib/findInsert'
import { canEditOpenCanvas, useStore } from '../../lib/store'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { ConfirmDialog } from '../ui/alert-dialog'
import { Button } from '../ui/button'

/** The library block the selected element sits in, if any. */
function blockOf(frame: Frame, selector: string): LibraryRef | null {
  const refs = refsIn(frame.html)
  if (!refs.length) return null
  try {
    const doc = new DOMParser().parseFromString(frame.html, 'text/html')
    const el = doc.querySelector(selector)?.closest('[data-doop-ref-lib]')
    const id = el?.getAttribute('data-doop-id')
    return refs.find((r) => r.elementId === id) ?? null
  } catch {
    return null
  }
}

/**
 * "From library" on an element inside a block inserted from a library: the
 * item, a link to it, and Update when its item moved on (a fresh copy in
 * its place, one undo step, after a confirmation). Revisions are asked once
 * per block selected, not per render.
 */
export function LibrarySourceSection({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const canEdit = useStore((s) => canEditOpenCanvas(s))
  const block = useMemo(() => blockOf(frame, selector), [frame, selector])
  const [current, setCurrent] = useState<{ key: string; rev: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const libraryId = block?.libraryId ?? null
  const itemId = block?.ref ?? null
  const blockRev = block?.rev ?? null
  const key = libraryId && itemId ? revKey(libraryId, itemId) : null

  /* once per block: the primitives name it, not the frame's every edit */
  useEffect(() => {
    if (!libraryId || !itemId || blockRev === null) return
    let stale = false
    api
      .libraryRevs([{ libraryId, itemId }])
      .then((r) => {
        const found = r.revs.find((x) => x.libraryId === libraryId && x.itemId === itemId)
        if (!stale && found) setCurrent({ key: revKey(libraryId, itemId), rev: found.rev })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [libraryId, itemId, blockRev])

  if (!block) return null
  const latest = current?.key === key ? current.rev : null
  const stale = block.rev !== null && latest !== null && latest > block.rev
  return (
    <div className="flex flex-col gap-1.5 border-b border-line-soft px-3 py-2.5" data-testid="library-source">
      <span className="text-caption text-ink-faint">{t('library.fromLibrary')}</span>
      <div className="flex items-center gap-2">
        <Button
          size="inline"
          className="min-w-0 truncate font-mono"
          onClick={() => navigate(`/l/${block.libraryId}/i/${encodeURIComponent(block.ref)}`)}
        >
          {block.ref}
        </Button>
        {stale && canEdit && (
          <Button size="sm" onClick={() => setConfirming(true)}>
            {t('library.update')}
          </Button>
        )}
      </div>
      {stale && <span className="text-caption text-ink-faint">{t('library.updateAvailable', { rev: latest })}</span>}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('library.updateTitle')}
        description={t('library.updateDescription')}
        confirmLabel={t('library.update')}
        onConfirm={() => void replaceLibraryBlock(frame.id, block)}
      />
    </div>
  )
}
