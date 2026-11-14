import { useEffect, useState } from 'react'
import { codeLinkLabel, type CodeLink, type CodeLinkKind } from '../../shared/codeLinks'
import type { CodeSuggestion } from '../../shared/codeSuggest'
import { api, errorMessage } from '../lib/api'
import { t as translate, useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'

/* The Inspector's "Code" row: where this frame — or the component it is the
   main of — lives in the linked repo. A suggestion comes from the caller's
   own linked project (repo_search + repo_list, server-side); saving only
   stores the mapping, the repo is never written. */

const fillBtn = 'h-7 rounded-row bg-sub px-2 text-label font-normal text-ink hover:bg-paper-deep max-md:min-h-10'

export interface CodeLinkTarget {
  kind: CodeLinkKind
  id: string
  /** shown for a component target: "Component “Button”" */
  name?: string
}

export function CodeLinkSection({
  canvasId,
  target,
  canEdit,
}: {
  canvasId: string
  target: CodeLinkTarget
  canEdit: boolean
}) {
  const t = useT()
  const [link, setLink] = useState<CodeLink | null>(null)
  const [editing, setEditing] = useState(false)
  const [path, setPath] = useState('')
  const [exportName, setExportName] = useState('')
  const [suggestions, setSuggestions] = useState<CodeSuggestion[] | null>(null)
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    /* the parent keys this section by target, so a new target starts fresh */
    let live = true
    api
      .codeLinks(canvasId)
      .then(({ links }) => {
        if (!live) return
        setLink(links.find((l) => l.targetKind === target.kind && l.targetId === target.id) ?? null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [canvasId, target.kind, target.id])

  async function save(next: { path: string; exportName: string | null; source: CodeLink['source'] }) {
    setBusy(true)
    setError(null)
    try {
      const res = await api.putCodeLink(canvasId, { targetKind: target.kind, targetId: target.id, ...next })
      setLink(res.link)
      setEditing(false)
      setSuggestions(null)
    } catch (e) {
      setError(errorMessage(e, translate('inspector.codeLinkFailed')))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteCodeLink(canvasId, target.kind, target.id)
      setLink(null)
    } catch (e) {
      setError(errorMessage(e, translate('inspector.codeLinkFailed')))
    } finally {
      setBusy(false)
    }
  }

  async function suggest() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.suggestCodeLinks(canvasId, target.kind, target.id)
      setSuggestions(res.suggestions)
      setRepo(res.repo)
    } catch (e) {
      setError(errorMessage(e, translate('inspector.codeLinkFailed')))
    } finally {
      setBusy(false)
    }
  }

  function startEdit() {
    setPath(link?.path ?? '')
    setExportName(link?.exportName ?? '')
    setEditing(true)
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1.5" data-testid="code-link">
      {target.kind === 'component' && target.name && (
        <span className="text-caption text-ink-faint">{t('inspector.codeLinkComponent', { name: target.name })}</span>
      )}
      {!editing && (
        <p className={cn('m-0 truncate text-label', link ? 'text-ink' : 'text-ink-faint')} title={link?.path}>
          {link ? codeLinkLabel(link) : t('inspector.codeLinkNone')}
        </p>
      )}
      {editing && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (path.trim()) void save({ path, exportName: exportName.trim() || null, source: 'manual' })
          }}
        >
          <Input
            aria-label={t('inspector.codeLinkPath')}
            placeholder="src/components/Button.tsx"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Input
            aria-label={t('inspector.codeLinkExport')}
            placeholder="Button"
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
          />
          <Button type="submit" variant="bare" className={fillBtn} disabled={busy || !path.trim()}>
            {t('inspector.codeLinkSave')}
          </Button>
        </form>
      )}
      {canEdit && !editing && (
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="bare" className={fillBtn} disabled={busy} onClick={startEdit}>
            {t('inspector.codeLinkEdit')}
          </Button>
          {link ? (
            <Button variant="bare" className={fillBtn} disabled={busy} onClick={() => void remove()}>
              {t('inspector.codeLinkRemove')}
            </Button>
          ) : (
            <Button
              variant="bare"
              className={fillBtn}
              disabled={busy}
              title={t('inspector.codeLinkSuggestTitle')}
              onClick={() => void suggest()}
            >
              {busy ? t('inspector.codeLinkSuggesting') : t('inspector.codeLinkSuggest')}
            </Button>
          )}
        </div>
      )}
      {suggestions && suggestions.length === 0 && (
        <p className="m-0 text-caption text-ink-faint">{t('inspector.codeLinkNoSuggestions', { repo })}</p>
      )}
      {suggestions && suggestions.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {suggestions.map((s) => (
            <li key={s.path} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-caption text-ink-soft" title={s.path}>
                {codeLinkLabel(s)}
              </span>
              <Button
                variant="bare"
                className="h-6 rounded-row bg-surface px-2 text-caption font-normal text-ink shadow-ring"
                disabled={busy}
                onClick={() => void save({ path: s.path, exportName: s.exportName, source: 'suggested' })}
              >
                {t('inspector.codeLinkUse')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="m-0 text-caption text-accent-ink">{error}</p>}
    </div>
  )
}
