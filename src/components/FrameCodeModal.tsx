import { useCallback, useEffect, useState } from 'react'
import type { FrameCodeFramework, FrameCodePreview } from '../../shared/frameCode'
import { api, errorMessage } from '../lib/api'
import { t as translate, useT } from '../lib/i18n'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Textarea } from './ui/textarea'

/* Frame → code: the server turns the frame into a React or Astro component
   (tokens as var(--token), mapped components imported) and diffs it against
   what the linked repo holds at that path. The person reads the diff here;
   writing goes through the desktop app's own dialog. */

export function FrameCodeModal({ frameId, onClose }: { frameId: string; onClose: () => void }) {
  const t = useT()
  const [framework, setFramework] = useState<FrameCodeFramework>('react')
  /* '' = the server's default: the frame's mapping or src/components/<Name> */
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<FrameCodePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (next: { framework: FrameCodeFramework; path: string }) => {
      setBusy(true)
      setError(null)
      try {
        setPreview(
          await api.previewFrameCode(frameId, {
            framework: next.framework,
            ...(next.path.trim() ? { path: next.path.trim() } : {}),
          }),
        )
      } catch (e) {
        setPreview(null)
        setError(errorMessage(e, translate('inspector.frameCodeFailed')))
      } finally {
        setBusy(false)
      }
    },
    [frameId],
  )

  /* the first preview, on the defaults; later ones follow the person's picks */
  useEffect(() => {
    let live = true
    api
      .previewFrameCode(frameId, { framework: 'react' })
      .then((res) => live && setPreview(res))
      .catch((e) => live && setError(errorMessage(e, translate('inspector.frameCodeFailed'))))
    return () => {
      live = false
    }
  }, [frameId])

  function pickFramework(next: FrameCodeFramework) {
    setFramework(next)
    /* a typed path keeps its folder but takes the framework's extension */
    const nextPath = path.trim() ? path.replace(/\.(tsx|astro)$/, next === 'react' ? '.tsx' : '.astro') : ''
    setPath(nextPath)
    void load({ framework: next, path: nextPath })
  }

  const code = preview?.code
  return (
    <Modal size="xl" onClose={onClose} aria-label={t('inspector.frameCodeTitle')}>
      <ModalEyebrow>{t('inspector.frameCodeEyebrow')}</ModalEyebrow>
      <ModalTitle>{t('inspector.frameCodeTitle')}</ModalTitle>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented value={framework} onValueChange={(v) => pickFramework(v as FrameCodeFramework)}>
          <SegmentedItem value="react">React</SegmentedItem>
          <SegmentedItem value="astro">Astro</SegmentedItem>
        </Segmented>
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void load({ framework, path })
          }}
        >
          <Input
            className="min-w-0 flex-1"
            aria-label={t('inspector.frameCodePath')}
            placeholder={code?.files[0]?.path ?? 'src/components/Screen.tsx'}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button type="submit" variant="bare" disabled={busy}>
            {t('inspector.frameCodeRefresh')}
          </Button>
        </form>
      </div>
      {!preview && !error && <ModalLede className="mt-4">{t('inspector.frameCodeBuilding')}</ModalLede>}
      {error && <p className="mt-3 text-copy text-accent-ink">{error}</p>}
      {preview && code && (
        <>
          <ModalLede className="mt-3">
            {preview.summary
              ? t('inspector.frameCodeLede', {
                  repo: preview.repo,
                  files: preview.summary.files
                    .map((f) => `${f.path}${f.create ? ' (new)' : ''} +${f.added} −${f.removed}`)
                    .join(', '),
                })
              : t('inspector.frameCodeSame', { repo: preview.repo })}
          </ModalLede>
          {preview.patch && (
            <Textarea
              variant="code"
              readOnly
              className="mt-2 h-[320px] w-full"
              aria-label={t('inspector.frameCodeDiff')}
              value={preview.patch}
            />
          )}
          <ul className="mt-2 space-y-0.5 text-caption text-ink-faint">
            {code.imports.length > 0 && (
              <li>
                {t('inspector.frameCodeImports', { list: code.imports.map((i) => `${i.name} ← ${i.from}`).join(', ') })}
              </li>
            )}
            {code.unmapped.length > 0 && (
              <li>{t('inspector.frameCodeUnmapped', { list: code.unmapped.join(', ') })}</li>
            )}
            {code.tokens.length > 0 && <li>{t('inspector.frameCodeTokens', { list: code.tokens.join(', ') })}</li>}
            {code.droppedScripts > 0 && <li>{t('inspector.frameCodeScripts', { count: code.droppedScripts })}</li>}
          </ul>
        </>
      )}
      <ModalActions>
        <Button variant="bare" onClick={onClose}>
          {t('common.close')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
