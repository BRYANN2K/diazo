import { useEffect, useState } from 'react'
import type { ImportReport, LibraryListEntry } from '../../../shared/library'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { navigate } from '../../lib/navigate'
import { Button } from '../ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** The category select's "let the rules decide" (a Select item cannot be ''). */
const BY_RULES = '__rules__'

/**
 * "Add to library…": pick a library and, if you like, its category, see what its rules would do to the
 * frames (ids, variants, findings), then add copies of them.
 */
export function AddToLibraryModal({
  frameIds,
  onClose,
  onAdded,
}: {
  frameIds: string[]
  onClose: () => void
  onAdded?: (count: number) => void
}) {
  const t = useT()
  const [libraries, setLibraries] = useState<LibraryListEntry[] | null>(null)
  const [libraryId, setLibraryId] = useState('')
  const [report, setReport] = useState<{ libraryId: string; report: ImportReport } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categories, setCategories] = useState<{ libraryId: string; paths: string[] } | null>(null)
  const [category, setCategory] = useState(BY_RULES)

  useEffect(() => {
    api
      .listLibraries()
      .then((r) => {
        const usable = r.libraries.filter((l) => l.role !== 'read')
        setLibraries(usable)
        setLibraryId((id) => id || usable[0]?.id || '')
      })
      .catch(() => setLibraries([]))
  }, [])

  useEffect(() => {
    if (!libraryId) return
    let stale = false
    api
      .getLibraryDetail(libraryId)
      .then((d) => {
        if (!stale) setCategories({ libraryId, paths: d.taxonomy.categories.map((c) => c.path) })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [libraryId])

  const picked = category === BY_RULES ? {} : { category }

  useEffect(() => {
    if (!libraryId) return
    let stale = false
    api
      .importToLibrary(libraryId, { frameIds, dryRun: true, ...(category === BY_RULES ? {} : { category }) })
      .then((r) => {
        if (!stale) setReport({ libraryId, report: r.report })
      })
      .catch(() => {
        if (!stale) setError(t('library.importFailed'))
      })
    return () => {
      stale = true
    }
  }, [libraryId, frameIds, t, category])

  const shown = report?.libraryId === libraryId ? report.report : null

  async function add(how: { force?: boolean; asVariantOf?: string } = {}) {
    setBusy(true)
    setError(null)
    try {
      const r = await api.importToLibrary(libraryId, { frameIds, ...picked, ...how })
      const failed = r.applied.filter((a) => a.error)
      if (failed.length) setError(failed.map((a) => a.error).join(' · '))
      else {
        onAdded?.(r.applied.length)
        onClose()
      }
    } catch {
      setError(t('library.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal size="md" onClose={onClose}>
      <ModalTitle>{t('library.addTitle', { count: frameIds.length })}</ModalTitle>
      <ModalLede>{t('library.addLede')}</ModalLede>
      <div className="mt-4 flex flex-col gap-3">
        {libraries && !libraries.length ? (
          <p className="text-copy text-ink-faint">{t('library.noLibraryToAdd')}</p>
        ) : (
          <Select
            value={libraryId}
            onValueChange={(next) => {
              setLibraryId(next)
              setCategory(BY_RULES)
            }}
          >
            <SelectTrigger className="w-full" aria-label={t('library.panelLibrary')}>
              <SelectValue placeholder={t('library.panelLibrary')} />
            </SelectTrigger>
            <SelectContent>
              {(libraries ?? []).map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {categories?.libraryId === libraryId && categories.paths.length > 0 && (
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full" aria-label={t('library.addCategory')}>
              <SelectValue placeholder={t('library.addCategory')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BY_RULES}>{t('library.addCategoryByRules')}</SelectItem>
              {categories.paths.map((path) => (
                <SelectItem key={path} value={path}>
                  {path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {shown?.duplicates?.length ? (
          <div className="flex flex-col gap-2 rounded-card p-3 shadow-ring" data-testid="add-duplicates">
            <span className="text-label font-medium text-ink">{t('library.duplicateTitle')}</span>
            {shown.duplicates.map((d) => {
              const best = d.matches[0]!
              return (
                <div key={d.frameId} className="flex flex-col gap-1.5">
                  <p className="text-copy text-ink-soft">
                    {d.name} ·{' '}
                    {t('library.alreadyIn', { library: best.libraryName, category: best.category, name: best.name })}{' '}
                    <span className="text-caption text-ink-faint">
                      (
                      {best.reason === 'same-url'
                        ? t('library.duplicateReason_same_url')
                        : best.reason === 'same-content'
                          ? t('library.duplicateReason_same_content')
                          : t('library.duplicateReason_similar', { score: Math.round(best.score * 100) })}
                      )
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" onClick={() => navigate(best.url)}>
                      {t('library.duplicateOpen')}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void add({ force: true })}>
                      {t('library.duplicateForce')}
                    </Button>
                    {best.libraryId === libraryId && (
                      <Button size="sm" disabled={busy} onClick={() => void add({ asVariantOf: best.itemId })}>
                        {t('library.duplicateVariant')}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
        {shown && (
          <ul className="flex flex-col gap-1.5 text-copy text-ink-soft" data-testid="add-report">
            {shown.frames.map((f) => (
              <li key={f.frameId}>
                <span className="font-mono text-caption text-ink">
                  {f.item?.itemId ?? (f.ignored ? t('library.notAnItem') : t('library.noItem'))}
                </span>
                {f.variants.length > 0 && ` · ${t('library.countVariants', { count: f.variants.length })}`}
                {f.item && ` · ${f.item.category}`}
                {f.item?.status === 'draft' && ` · ${t('library.status_draft')}`}
                {f.findings.map((finding, i) => (
                  <span key={i} className="block text-caption text-ink-faint">
                    {finding.message}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-caption text-accent-ink">
            {error}
          </p>
        )}
      </div>
      <ModalActions>
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!shown || busy || (!!shown.duplicates?.length && !shown.frames.length)}
          onClick={() => void add()}
        >
          {t('library.add')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
