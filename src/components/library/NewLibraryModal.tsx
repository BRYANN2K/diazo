import { useState, type ReactNode } from 'react'
import { ApiError, api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Callout } from '../ui/callout'
import { ChoiceList, ChoiceRow } from '../ui/choice-list'
import { FolderPlusIcon, LibraryIcon, SparkIcon } from '../ui/icons'
import { Input } from '../ui/input'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../ui/modal'
import { Textarea } from '../ui/textarea'

export type NewLibraryPath = 'canvas' | 'curate'

function errorOf(error: unknown): string {
  if (error instanceof ApiError && typeof error.body.error === 'string') return error.body.error
  return error instanceof Error ? error.message : String(error)
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 flex-none place-items-center rounded-control bg-paper-deep text-ink">{children}</span>
  )
}

/**
 * "New library": start empty (a name, a description and starting
 * categories, typed or suggested by AI from one line), or go on to turn a
 * canvas into a library, or to organise several with AI.
 */
export function NewLibraryModal({ onClose, onPath }: { onClose: () => void; onPath: (path: NewLibraryPath) => void }) {
  const t = useT()
  const [empty, setEmpty] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categories, setCategories] = useState('')
  const [brief, setBrief] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function suggest() {
    setSuggesting(true)
    setError(null)
    try {
      const r = await api.suggestLibraryCategories(brief)
      setCategories(r.categories.join('\n'))
      if (!description.trim()) setDescription(brief)
    } catch (e) {
      setError(t('library.newSuggestFailed', { error: errorOf(e) }))
    } finally {
      setSuggesting(false)
    }
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const created = await api.newLibrary({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        categories: categories
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean),
      })
      onClose()
      navigate(`/l/${created.id}`)
    } catch (e) {
      setError(t('library.newFailed', { error: errorOf(e) }))
      setBusy(false)
    }
  }

  if (!empty) {
    return (
      <Modal size="md" onClose={onClose}>
        <ModalTitle>{t('library.newTitle')}</ModalTitle>
        <ModalLede>{t('library.newLede')}</ModalLede>
        <ChoiceList className="mt-4" data-testid="new-library-paths">
          <ChoiceRow
            icon={
              <Mark>
                <FolderPlusIcon size="rail" />
              </Mark>
            }
            title={t('library.newEmpty')}
            description={t('library.newEmptyHint')}
            onClick={() => setEmpty(true)}
          />
          <ChoiceRow
            icon={
              <Mark>
                <LibraryIcon size="rail" />
              </Mark>
            }
            title={t('library.newFromCanvas')}
            description={t('library.newFromCanvasHint')}
            onClick={() => onPath('canvas')}
          />
          <ChoiceRow
            icon={
              <Mark>
                <SparkIcon size="rail" />
              </Mark>
            }
            title={t('library.curateOpen')}
            description={t('library.curateHint')}
            onClick={() => onPath('curate')}
          />
        </ChoiceList>
        <ModalActions>
          <ModalSpacer />
          <Button onClick={onClose}>{t('library.cancel')}</Button>
        </ModalActions>
      </Modal>
    )
  }

  return (
    <Modal size="md" onClose={onClose}>
      <ModalTitle>{t('library.newEmpty')}</ModalTitle>
      <ModalLede>{t('library.newEmptyHint')}</ModalLede>
      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-ink">{t('library.newName')}</span>
          <Input variant="well" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-ink">{t('library.newDescription')}</span>
          <Input variant="well" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium text-ink">{t('library.newBrief')}</span>
          <div className="flex gap-2">
            <Input
              variant="well"
              className="min-w-0 flex-1"
              value={brief}
              placeholder={t('library.newBriefPlaceholder')}
              aria-label={t('library.newBrief')}
              onChange={(e) => setBrief(e.target.value)}
            />
            <Button disabled={!brief.trim() || suggesting} onClick={() => void suggest()}>
              <SparkIcon size="rail" /> {suggesting ? t('library.newSuggesting') : t('library.newSuggest')}
            </Button>
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-label font-medium text-ink">{t('library.newCategories')}</span>
          <Textarea
            variant="well"
            rows={6}
            value={categories}
            data-testid="new-library-categories"
            onChange={(e) => setCategories(e.target.value)}
          />
          <span className="text-caption text-ink-faint">{t('library.newCategoriesHint')}</span>
        </label>
        {error && <Callout tone="error">{error}</Callout>}
      </div>
      <ModalActions>
        <Button onClick={() => setEmpty(false)}>{t('library.back')}</Button>
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? t('library.newCreating') : t('library.newCreate')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
