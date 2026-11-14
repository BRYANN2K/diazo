import { useEffect, useState } from 'react'
import type { LibraryPreview } from '../../../shared/library'
import type { RulePresetName } from '../../../shared/libraryRules'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Disclosure } from '../ui/collapsible'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../ui/modal'
import { Segmented, SegmentedItem } from '../ui/segmented'

/**
 * "Turn into a library": the dry run of the conversion (what the frames
 * would give under each preset, what was ignored, what could not be read),
 * then one button that creates the library. No frame is written.
 */
export function ConvertToLibraryModal({
  canvasId,
  onClose,
  onConverted,
}: {
  canvasId: string
  onClose: () => void
  onConverted?: () => void
}) {
  const t = useT()
  const [preset, setPreset] = useState<RulePresetName | null>(null)
  const [detected, setDetected] = useState<RulePresetName | null>(null)
  const [preview, setPreview] = useState<{ preset: RulePresetName; report: LibraryPreview } | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    api
      .previewLibrary(canvasId, preset ? { preset } : {})
      .then((r) => {
        if (stale) return
        setPreview({ preset: r.preset, report: r.preview })
        setDetected((d) => d ?? r.preset)
        setFailed(false)
      })
      .catch(() => {
        if (!stale) setFailed(true)
      })
    return () => {
      stale = true
    }
  }, [canvasId, preset])

  const chosen = preset ?? detected ?? 'sheets'
  const report = preview?.preset === chosen ? preview.report : null

  async function convert() {
    setBusy(true)
    try {
      await api.createLibrary(canvasId, { preset: chosen })
      onConverted?.()
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal size="md" onClose={onClose}>
      <ModalTitle>{t('library.convertTitle')}</ModalTitle>
      <ModalLede>{t('library.convertLede')}</ModalLede>
      <div className="mt-4 flex flex-col gap-2">
        <span className="text-label font-medium text-ink">{t('library.presetLabel')}</span>
        <Segmented
          aria-label={t('library.presetLabel')}
          value={chosen}
          onValueChange={(next) => setPreset(next as RulePresetName)}
        >
          <SegmentedItem value="sheets">{t('library.presetSheets')}</SegmentedItem>
          <SegmentedItem value="blank">{t('library.presetBlank')}</SegmentedItem>
        </Segmented>
        <p className="text-caption text-ink-faint">
          {chosen === 'sheets' ? t('library.presetSheetsHint') : t('library.presetBlankHint')}
          {detected === chosen ? ` · ${t('library.presetDetected')}` : ''}
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-1 text-copy text-ink-soft" aria-live="polite">
        {failed ? (
          <p className="text-accent-ink">{t('library.previewFailed')}</p>
        ) : !report ? (
          <p>{t('library.previewing')}</p>
        ) : (
          <>
            <p data-testid="library-preview-counts">
              {t('library.countFamilies', { count: report.families })} ·{' '}
              {t('library.countVariants', { count: report.variants })} ·{' '}
              {t('library.countIgnored', { count: report.ignored.length })}
            </p>
            {report.scripted > 0 && <p>{t('library.countScripted', { count: report.scripted })}</p>}
            {report.duplicates.length > 0 && <p>{t('library.countDuplicates', { count: report.duplicates.length })}</p>}
            {report.unreadable.length > 0 && (
              <Disclosure label={t('library.unreadable', { count: report.unreadable.length })}>
                <ul className="flex flex-col gap-0.5 text-caption text-ink-faint">
                  {report.unreadable.slice(0, 50).map((f) => (
                    <li key={f.frameId} className="truncate">
                      {f.name} · {f.reason}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </>
        )}
      </div>
      <ModalActions>
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button variant="primary" disabled={!report || busy} onClick={() => void convert()}>
          {busy ? t('library.converting') : t('library.convertConfirm')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
