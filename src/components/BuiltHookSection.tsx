import { useEffect, useState } from 'react'
import { formatBuiltMappings, parseBuiltMappings, type BuiltHookInfo } from '../../shared/built'
import { ApiError, api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ui/alert-dialog'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'

/** The import modal's "Preview deploys" step (shared/built.ts): the canvas's
 *  deploy hook — endpoint, a secret shown once, route → frame mappings —
 *  and the last delivery's report with a link to each route's drift
 *  compare. Durable access only, like sync keys. */
export function BuiltHookSection({ canvasId, onBack }: { canvasId: string; onBack: () => void }) {
  const t = useT()
  const pushNotice = useStore((s) => s.pushNotice)
  const [hook, setHook] = useState<BuiltHookInfo | null | undefined>(undefined)
  const [secret, setSecret] = useState<string | null>(null)
  const [mappings, setMappings] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'endpoint' | 'secret' | null>(null)
  const [forbidden, setForbidden] = useState(false)
  /* an in-app "are you sure": window.confirm is a silent cancel in the
     desktop shell's webview */
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | null>(null)

  function show(next: BuiltHookInfo | null) {
    setHook(next)
    setMappings(next ? formatBuiltMappings(next.mappings) : '')
  }

  function load() {
    api
      .getBuiltHook(canvasId)
      .then(({ hook: next }) => show(next))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        setHook(null)
      })
  }

  useEffect(load, [canvasId])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch (e) {
      pushNotice(errorMessage(e, t('built.failed')))
    }
    setBusy(false)
  }

  const issue = () =>
    run(async () => {
      const issued = await api.issueBuiltHook(canvasId)
      show(issued.hook)
      setSecret(issued.secret)
    })

  const remove = () =>
    run(async () => {
      await api.deleteBuiltHook(canvasId)
      show(null)
      setSecret(null)
    })

  const saveMappings = () =>
    run(async () => {
      const saved = await api.setBuiltMappings(canvasId, parseBuiltMappings(mappings))
      show(saved.hook)
      pushNotice(t('built.mappingsSaved'))
    })

  async function copy(what: 'endpoint' | 'secret', value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const header = (
    <ImportStepHeader
      icon={<AppIcon brand="built" size={40} />}
      title={t('built.title')}
      lede={forbidden ? t('built.forbidden') : t('built.lede')}
    />
  )
  if (forbidden || hook === undefined) {
    return (
      <>
        {header}
        <ImportStepFooter onBack={onBack} />
      </>
    )
  }
  if (!hook) {
    return (
      <>
        {header}
        <ImportStepFooter note={t('built.note')} onBack={onBack} backDisabled={busy}>
          <Button variant="primary" disabled={busy} onClick={() => void issue()}>
            {t('built.create')}
          </Button>
        </ImportStepFooter>
      </>
    )
  }

  const copyButton = (what: 'endpoint' | 'secret', value: string) => (
    <Button size="sm" className="shrink-0" onClick={() => void copy(what, value)}>
      {copied === what ? t('built.copied') : t('built.copy')}
    </Button>
  )
  const last = hook.lastDelivery
  return (
    <>
      {header}
      <Field className="mt-4" label={t('built.endpoint')} labelVariant="form" htmlFor="built-endpoint">
        <div className="flex items-center gap-2">
          <Input id="built-endpoint" variant="well" className="font-mono text-caption" readOnly value={hook.endpoint} />
          {copyButton('endpoint', hook.endpoint)}
        </div>
      </Field>
      {secret && (
        <Field className="mt-3" label={t('built.secret')} labelVariant="form" htmlFor="built-secret">
          <div className="flex items-center gap-2">
            <Input id="built-secret" variant="well" className="font-mono text-caption" readOnly value={secret} />
            {copyButton('secret', secret)}
          </div>
          <Note>{t('built.secretOnce')}</Note>
        </Field>
      )}
      <Field className="mt-3" label={t('built.mappings')} labelVariant="form" htmlFor="built-mappings">
        <Textarea
          id="built-mappings"
          className="font-mono text-caption"
          rows={3}
          placeholder={t('built.mappingsPlaceholder')}
          value={mappings}
          disabled={busy}
          onChange={(e) => setMappings(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Note className="mr-auto">{t('built.mappingsHint')}</Note>
          <Button size="sm" disabled={busy} onClick={() => void saveMappings()}>
            {t('built.saveMappings')}
          </Button>
        </div>
      </Field>
      <div className="mt-4 flex flex-col gap-1.5 rounded-card border border-line px-3.5 py-3">
        <div className="flex items-center gap-2 text-body">
          <b className="font-semibold">{t('built.lastDelivery')}</b>
          <Note className="mr-auto truncate">
            {last
              ? `${last.deployUrl}${last.commit ? ` · ${last.commit}` : ''}${last.status === 'running' ? ` · ${t('built.running')}` : ''}`
              : t('built.noDelivery')}
          </Note>
          <Button variant="bare" size="inline" onClick={load}>
            {t('built.refresh')}
          </Button>
        </div>
        {last?.routes.map((r) => (
          <div key={r.route} className="flex items-center gap-2 text-caption">
            <span className="font-mono">{r.route}</span>
            <Note className="mr-auto truncate">
              {r.status === 'failed'
                ? `${t('built.failed')} — ${r.error ?? ''}`
                : [
                    r.designFrameName ?? t('built.unmatched'),
                    r.score !== undefined ? t('built.score', { score: r.score }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </Note>
            {r.driftUrl && (
              <a className="text-ink underline-offset-4 hover:underline" href={r.driftUrl}>
                {t('built.openCompare')}
              </a>
            )}
          </div>
        ))}
      </div>
      <ImportStepFooter note={t('built.note')} onBack={onBack} backDisabled={busy}>
        <Button variant="danger" disabled={busy} onClick={() => setConfirming('remove')}>
          {t('built.remove')}
        </Button>
        <Button disabled={busy} onClick={() => setConfirming('rotate')}>
          {t('built.rotate')}
        </Button>
      </ImportStepFooter>
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming === 'rotate' ? t('built.rotateConfirm') : t('built.removeConfirm')}
        confirmLabel={confirming === 'rotate' ? t('built.rotate') : t('built.remove')}
        destructive
        onConfirm={() => {
          const action = confirming
          setConfirming(null)
          if (action) void (action === 'rotate' ? issue() : remove())
        }}
      />
    </>
  )
}
