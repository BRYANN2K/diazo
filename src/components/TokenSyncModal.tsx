import { useEffect, useMemo, useState } from 'react'
import type { TokenDiffEntry } from '../../shared/tokenSync'
import { api, errorMessage } from '../lib/api'
import { t as translate, useT } from '../lib/i18n'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'

/* Token sync with the linked repo. The server reads the repo's CSS
   variables and Tailwind theme (through the desktop app) and diffs them
   with the canvas's tokens; here the person ticks what to take into doop.
   Nothing changes until "Apply in doop" — and the repo is never written
   from this direction. */

type Preview = Awaited<ReturnType<typeof api.previewTokenSync>>

const themesLine = (themes?: Record<string, string>) =>
  themes && Object.keys(themes).length
    ? ` · ${Object.entries(themes)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')}`
    : ''

export function TokenSyncModal({ canvasId, onClose }: { canvasId: string; onClose: () => void }) {
  const t = useT()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<number | null>(null)
  /* doop → repo: the patch the server built, then what the desktop app wrote */
  const [patch, setPatch] = useState<Awaited<ReturnType<typeof api.previewTokenPatch>> | null>(null)
  const [written, setWritten] = useState<{ written: string[]; repo: string } | null>(null)

  useEffect(() => {
    let live = true
    api
      .previewTokenSync(canvasId)
      .then((res) => {
        if (!live) return
        setPreview(res)
        setPicked(new Set(res.entries.filter((e) => e.kind !== 'doop-only').map((e) => e.name)))
      })
      .catch((e) => live && setError(errorMessage(e, translate('panels.tokenSyncFailed'))))
    return () => {
      live = false
    }
  }, [canvasId])

  const incoming = useMemo(() => preview?.entries.filter((e) => e.kind !== 'doop-only') ?? [], [preview])
  const doopOnly = useMemo(() => preview?.entries.filter((e) => e.kind === 'doop-only') ?? [], [preview])

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  async function apply() {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const tokens = incoming
        .filter((e) => picked.has(e.name) && e.repo)
        .map((e) => ({ name: e.name, type: e.type, value: e.repo!.value, themes: e.repo!.themes }))
      const res = await api.applyTokenSync(canvasId, tokens)
      setApplied(res.results.filter((r) => r.result !== 'error').length)
    } catch (e) {
      setError(errorMessage(e, translate('panels.tokenSyncFailed')))
    } finally {
      setBusy(false)
    }
  }

  /* every token where doop's value differs from the repo's, or the repo lacks it */
  const outgoing = useMemo(() => preview?.entries.filter((e) => e.kind !== 'add').map((e) => e.name) ?? [], [preview])

  async function previewPatch() {
    setBusy(true)
    setError(null)
    try {
      setPatch(await api.previewTokenPatch(canvasId, outgoing))
    } catch (e) {
      setError(errorMessage(e, translate('panels.tokenSyncFailed')))
    } finally {
      setBusy(false)
    }
  }

  async function writePatch() {
    if (!patch?.patch) return
    setBusy(true)
    setError(null)
    try {
      setWritten((await api.writeTokenPatch(canvasId, outgoing, patch.patch)).result)
    } catch (e) {
      setError(errorMessage(e, translate('panels.tokenSyncWriteFailed')))
    } finally {
      setBusy(false)
    }
  }

  const row = (e: TokenDiffEntry, checkable: boolean) => (
    <li key={e.name} className="flex items-start gap-2 border-t border-line py-2 first:border-t-0">
      {checkable && (
        <label className="relative mt-0.5 flex">
          <Checkbox aria-label={e.name} checked={picked.has(e.name)} onChange={() => toggle(e.name)} />
        </label>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <code className="truncate text-label text-ink">{e.name}</code>
          {/* token sync diff: changed in caution, new in ok, Diazo-only neutral */}
          <Badge tone={e.kind === 'change' ? 'caution' : e.kind === 'add' ? 'ok' : 'default'}>
            {t(`panels.tokenSyncKind_${e.kind === 'doop-only' ? 'doopOnly' : e.kind}`)}
          </Badge>
        </span>
        {e.doop && (
          <span className="block truncate text-caption text-ink-faint">
            {t('panels.tokenSyncDoop')}: {e.doop.value}
            {themesLine(e.doop.themes)}
          </span>
        )}
        {e.repo && (
          <span className="block truncate text-caption text-ink-soft" title={`${e.repo.file}:${e.repo.line}`}>
            {t('panels.tokenSyncRepo')}: {e.repo.value}
            {themesLine(e.repo.themes)} — {e.repo.file}
            {e.repo.line ? `:${e.repo.line}` : ''}
          </span>
        )}
      </span>
    </li>
  )

  return (
    <Modal size="lg" onClose={onClose} aria-label={t('panels.tokenSyncTitle')}>
      <ModalEyebrow>{t('panels.tokenSyncEyebrow')}</ModalEyebrow>
      <ModalTitle>{t('panels.tokenSyncTitle')}</ModalTitle>
      {!preview && !error && <ModalLede className="mt-4">{t('panels.tokenSyncReading')}</ModalLede>}
      {error && !preview && <p className="mt-4 text-copy text-danger">! {error}</p>}
      {patch && !written && (
        <>
          <ModalLede>{t('panels.tokenSyncPatchLede', { repo: patch.repo })}</ModalLede>
          {patch.patch ? (
            <Textarea
              variant="code"
              readOnly
              className="mt-3 h-[260px] w-full"
              aria-label={t('panels.tokenSyncPatch')}
              value={patch.patch}
            />
          ) : (
            <p className="mt-3 text-copy text-ink-soft">{t('panels.tokenSyncPatchEmpty')}</p>
          )}
          {patch.skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-caption text-ink-faint">
              {patch.skipped.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 text-caption text-danger">! {error}</p>}
          <ModalActions>
            <Button variant="bare" onClick={() => setPatch(null)}>
              {t('common.back')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !patch.patch}
              title={t('panels.tokenSyncWriteTitle')}
              onClick={() => void writePatch()}
            >
              {busy ? t('panels.tokenSyncWriting') : t('panels.tokenSyncWrite')}
            </Button>
          </ModalActions>
        </>
      )}
      {written && (
        <>
          <ModalLede className="mt-4">{t('panels.tokenSyncWritten', { repo: written.repo })}</ModalLede>
          <ul className="mt-2 space-y-0.5 text-caption text-ink-faint">
            {written.written.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <ModalActions>
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </ModalActions>
        </>
      )}
      {preview && applied === null && !patch && !written && (
        <>
          <ModalLede>
            {t('panels.tokenSyncLede', { repo: preview.repo, files: preview.files.length, same: preview.same })}
          </ModalLede>
          {preview.entries.length === 0 && (
            <p className="mt-3 text-copy text-ink-soft">{t('panels.tokenSyncInSync')}</p>
          )}
          {incoming.length > 0 && (
            <ul
              className="stagger-children mt-3 max-h-[300px] list-none overflow-y-auto p-0"
              data-testid="token-sync-incoming"
            >
              {incoming.map((e) => row(e, true))}
            </ul>
          )}
          {doopOnly.length > 0 && (
            <>
              <p className="mt-3 text-caption text-ink-faint">{t('panels.tokenSyncDoopOnly')}</p>
              <ul className="max-h-[160px] list-none overflow-y-auto p-0">{doopOnly.map((e) => row(e, false))}</ul>
            </>
          )}
          {preview.truncated && <p className="mt-2 text-caption text-ink-faint">{t('panels.tokenSyncTruncated')}</p>}
          {error && <p className="mt-2 text-caption text-danger">! {error}</p>}
          <ModalActions>
            <Button variant="bare" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {outgoing.length > 0 && (
              <Button
                variant="bare"
                disabled={busy}
                title={t('panels.tokenSyncToRepoTitle')}
                onClick={() => void previewPatch()}
              >
                {t('panels.tokenSyncToRepo', { count: outgoing.length })}
              </Button>
            )}
            <Button variant="primary" disabled={busy || picked.size === 0} onClick={() => void apply()}>
              {busy ? t('panels.tokenSyncApplying') : t('panels.tokenSyncApply', { count: picked.size })}
            </Button>
          </ModalActions>
        </>
      )}
      {applied !== null && (
        <>
          <ModalLede className="mt-4">{t('panels.tokenSyncApplied', { count: applied })}</ModalLede>
          <ModalActions>
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}
