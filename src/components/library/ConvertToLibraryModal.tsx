import { useEffect, useState } from 'react'
import type { LibraryCategory, LibraryPreview } from '../../../shared/library'
import type { RulePresetName } from '../../../shared/libraryRules'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { XIcon } from '../ui/icons'
import { Input } from '../ui/input'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../ui/modal'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { CurateLibraryModal } from './CurateLibraryModal'

type Step = 'preset' | 'report' | 'taxonomy'

/**
 * "Turn into a library", in three steps: the preset (the detected one
 * preselected, and why), the dry run's report (items, ignored, unreadable,
 * duplicates), then the proposed categories, editable before applying. No
 * frame is written.
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
  const [step, setStep] = useState<Step>('preset')
  const [preset, setPreset] = useState<RulePresetName | null>(null)
  const [detected, setDetected] = useState<RulePresetName | null>(null)
  const [preview, setPreview] = useState<{ preset: RulePresetName; report: LibraryPreview } | null>(null)
  const [categories, setCategories] = useState<LibraryCategory[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [curating, setCurating] = useState(false)

  useEffect(() => {
    let stale = false
    api
      .previewLibrary(canvasId, preset ? { preset } : {})
      .then((r) => {
        if (stale) return
        setPreview({ preset: r.preset, report: r.preview })
        setDetected((d) => d ?? r.preset)
        setCategories(null)
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
  const shownCategories = categories ?? report?.taxonomy.categories ?? []

  async function convert() {
    if (!report) return
    setBusy(true)
    try {
      await api.createLibrary(canvasId, {
        preset: chosen,
        taxonomy: { ...report.taxonomy, categories: shownCategories.filter((c) => c.path.trim()) },
      })
      onConverted?.()
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (curating) return <CurateLibraryModal initialSources={[canvasId]} onClose={onClose} />

  const counts = report && (
    <p data-testid="library-preview-counts">
      {t('library.countFamilies', { count: report.families })} ·{' '}
      {t('library.countVariants', { count: report.variants })} ·{' '}
      {t('library.countIgnored', { count: report.ignored.length })}
    </p>
  )

  return (
    <Modal size="lg" onClose={onClose}>
      <ModalTitle>{t('library.convertTitle')}</ModalTitle>
      <ModalLede>{t('library.convertLede')}</ModalLede>
      <p className="mt-2 text-caption text-ink-faint">
        {t('library.convertStep', { step: step === 'preset' ? 1 : step === 'report' ? 2 : 3, total: 3 })}
      </p>
      {step === 'preset' && (
        <div className="mt-3 flex flex-col gap-2">
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
          <div className="text-copy text-ink-soft" aria-live="polite">
            {failed ? (
              <p className="text-accent-ink">{t('library.previewFailed')}</p>
            ) : report ? (
              counts
            ) : (
              <p>{t('library.previewing')}</p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-card p-3 shadow-ring">
            <p className="min-w-0 flex-1 text-caption text-ink-soft">{t('library.curateHint')}</p>
            <Button size="sm" onClick={() => setCurating(true)}>
              {t('library.curateOpen')}
            </Button>
          </div>
        </div>
      )}
      {step === 'report' && report && (
        <Tabs defaultValue="items" className="mt-3">
          <TabsList>
            <TabsTrigger value="items">{t('library.tabItems')}</TabsTrigger>
            <TabsTrigger value="ignored">{t('library.tabIgnored', { count: report.ignored.length })}</TabsTrigger>
            <TabsTrigger value="unreadable">
              {t('library.tabUnreadable', { count: report.unreadable.length })}
            </TabsTrigger>
            <TabsTrigger value="duplicates">
              {t('library.tabDuplicates', { count: report.duplicates.length })}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="items" className="mt-2 text-copy text-ink-soft">
            {counts}
            {report.scripted > 0 && <p>{t('library.countScripted', { count: report.scripted })}</p>}
          </TabsContent>
          <TabsContent value="ignored" className="mt-2">
            <FrameList
              rows={report.ignored.map((f) => ({
                id: f.frameId,
                text: f.section ? `${f.name} → ${f.section}` : f.name,
              }))}
            />
          </TabsContent>
          <TabsContent value="unreadable" className="mt-2">
            <FrameList rows={report.unreadable.map((f) => ({ id: f.frameId, text: `${f.name} · ${f.reason}` }))} />
          </TabsContent>
          <TabsContent value="duplicates" className="mt-2">
            <FrameList rows={report.duplicates.map((d) => ({ id: d.itemId, text: d.itemId }))} />
          </TabsContent>
        </Tabs>
      )}
      {step === 'taxonomy' && report && (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-label font-medium text-ink">{t('library.categoriesLabel')}</span>
          <p className="text-caption text-ink-faint">{t('library.categoriesHint')}</p>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid="library-categories">
            {shownCategories.map((c, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <Input
                  inputSize="sm"
                  variant="well"
                  className="min-w-0 flex-1"
                  aria-label={t('library.categoryName')}
                  value={c.path}
                  onChange={(e) => {
                    const next = [...shownCategories]
                    next[i] = { ...c, path: e.target.value }
                    setCategories(next)
                  }}
                />
                <IconButton
                  size="sm"
                  aria-label={t('library.removeCategory')}
                  onClick={() => setCategories(shownCategories.filter((_, j) => j !== i))}
                >
                  <XIcon width={12} height={12} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ModalActions>
        {step !== 'preset' && (
          <Button onClick={() => setStep(step === 'taxonomy' ? 'report' : 'preset')}>{t('library.back')}</Button>
        )}
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        {step === 'taxonomy' ? (
          <Button variant="primary" disabled={!report || busy} onClick={() => void convert()}>
            {busy ? t('library.converting') : t('library.convertConfirm')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!report}
            onClick={() => setStep(step === 'preset' ? 'report' : 'taxonomy')}
          >
            {t('library.next')}
          </Button>
        )}
      </ModalActions>
    </Modal>
  )
}

function FrameList({ rows }: { rows: { id: string; text: string }[] }) {
  return (
    <ul className="flex max-h-60 flex-col gap-0.5 overflow-y-auto text-caption text-ink-faint">
      {rows.slice(0, 200).map((r) => (
        <li key={r.id} className="truncate">
          {r.text}
        </li>
      ))}
    </ul>
  )
}
