import { useState } from 'react'
import type { LibraryInfo, LibraryVisibility } from '../../../shared/library'
import { api, ApiError } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Callout } from '../ui/callout'
import { Segmented, SegmentedItem } from '../ui/segmented'

/**
 * Who can use this canvas as a design library: the people who can open it
 * (private), its whole workspace, or every account on the instance (public,
 * when the instance allows it). Seen in the share dialog of a library.
 */
export function LibraryVisibilitySection({
  canvasId,
  library,
  inWorkspace,
  canManage,
  onChange,
}: {
  canvasId: string
  library: LibraryInfo
  inWorkspace: boolean
  canManage: boolean
  onChange?: (visibility: LibraryVisibility) => void
}) {
  const t = useT()
  const [visibility, setVisibility] = useState<LibraryVisibility>(library.visibility)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function pick(next: LibraryVisibility) {
    if (next === visibility || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.updateLibrary(canvasId, { visibility: next })
      setVisibility(next)
      onChange?.(next)
    } catch (e) {
      setError(e instanceof ApiError && typeof e.body.error === 'string' ? e.body.error : t('library.visibilityFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3.5 flex flex-col gap-2 border-t border-line-soft pt-3.5" data-testid="library-visibility">
      <span className="text-body font-medium text-ink">{t('library.visibilityTitle')}</span>
      {canManage ? (
        <Segmented value={visibility} onValueChange={(v) => void pick(v as LibraryVisibility)}>
          <SegmentedItem value="private">{t('library.visibility_private')}</SegmentedItem>
          <SegmentedItem value="workspace" disabled={!inWorkspace}>
            {t('library.visibility_workspace')}
          </SegmentedItem>
          <SegmentedItem value="public">{t('library.visibility_public')}</SegmentedItem>
        </Segmented>
      ) : (
        <span className="text-label text-ink-faint">{t(`library.visibility_${visibility}`)}</span>
      )}
      {visibility === 'public' && <Callout>{t('library.publicWarning')}</Callout>}
      {error && (
        <p role="alert" className="text-caption text-accent-ink">
          {error}
        </p>
      )}
    </div>
  )
}
