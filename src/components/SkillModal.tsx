import { useState } from 'react'
import { MAX_SKILL_CHARS, MAX_SKILL_DESCRIPTION_CHARS, skillSlug } from '../../shared/skills'
import { api } from '../lib/api'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { getLocale, useT } from '@/lib/i18n'
import { ConfirmDialog } from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { MarkdownBlock, Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { Textarea } from './ui/textarea'

/**
 * One canvas skill, read or edited (shared/skills.ts): its name, the line
 * saying when agents should load it, and the instructions. `name` null
 * creates a new one.
 */
export function SkillModal({
  canvasId,
  name,
  onClose,
}: {
  canvasId: string
  name: string | null
  onClose: () => void
}) {
  const skill = useStore((s) => s.canvas?.skills?.find((x) => x.name === name) ?? null)
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const creating = name === null
  const [editing, setEditing] = useState(creating)
  const [nameDraft, setNameDraft] = useState('')
  const [description, setDescription] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const t = useT()

  async function run(action: () => Promise<unknown>, after: () => void) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      after()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : t('panels.skillSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const slug = creating ? skillSlug(nameDraft) : (skill?.name ?? '')
  const save = () =>
    run(
      () => api.setSkill(canvasId, slug, { description: description.trim(), markdown }),
      () => (creating ? onClose() : setEditing(false)),
    )

  if (editing) {
    return (
      <Modal size="xl" onClose={() => !busy && onClose()}>
        <ModalTitle>{creating ? t('panels.skillNew') : t('panels.skillEdit', { name: slug })}</ModalTitle>
        <div className="mt-3 flex flex-col gap-3">
          {creating && (
            <Field labelVariant="form" label={t('panels.skillName')} hint={`/${slug || '…'}`}>
              <Input
                variant="mono"
                autoFocus
                value={nameDraft}
                maxLength={64}
                disabled={busy}
                placeholder={t('panels.skillNamePlaceholder')}
                onChange={(e) => setNameDraft(e.target.value)}
              />
            </Field>
          )}
          <Field labelVariant="form" label={t('panels.skillDescription')} hint={t('panels.skillDescriptionHint')}>
            <Input
              variant="well"
              autoFocus={!creating}
              value={description}
              maxLength={MAX_SKILL_DESCRIPTION_CHARS}
              disabled={busy}
              placeholder={t('panels.skillDescriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field labelVariant="form" label={t('panels.skillBody')}>
            {/* Skill dialog: the body is written in the dark code well */}
            <Textarea
              variant="code"
              className="min-h-[38dvh] resize-y rounded-card px-3.5 py-3 text-label/relaxed md:text-label/relaxed"
              value={markdown}
              maxLength={MAX_SKILL_CHARS}
              disabled={busy}
              placeholder={t('panels.skillBodyPlaceholder')}
              onChange={(e) => setMarkdown(e.target.value)}
            />
          </Field>
        </div>
        {error && <p className="mt-2.5 text-copy text-accent-ink">{error}</p>}
        <ModalActions className="items-center">
          <span className="text-caption text-ink-faint tabular-nums">
            {markdown.length.toLocaleString(getLocale())} / {MAX_SKILL_CHARS.toLocaleString(getLocale())}
          </span>
          <ModalSpacer />
          <Button variant="ghost" disabled={busy} onClick={() => (creating ? onClose() : setEditing(false))}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !slug || !description.trim() || !markdown.trim()}
            onClick={() => void save()}
          >
            {busy ? t('panels.memorySaving') : t('common.save')}
          </Button>
        </ModalActions>
      </Modal>
    )
  }

  return (
    <Modal size="xl" onClose={() => !busy && onClose()}>
      {!skill ? (
        <>
          <ModalTitle className="sr-only">{t('panels.skills')}</ModalTitle>
          <ModalLede>{t('panels.skillGone')}</ModalLede>
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
          </ModalActions>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <ModalTitle>/{skill.name}</ModalTitle>
            <Badge tone="outline">{t('panels.skillBadge')}</Badge>
          </div>
          <p className="mt-1.5 text-copy text-ink-soft">{skill.description}</p>
          <p className="mt-1 text-caption text-ink-faint">
            {t('panels.memoryEditedBy', {
              name: skill.updatedBy,
              date: new Date(skill.updatedAt).toLocaleString(getLocale()),
            })}
          </p>
          <MarkdownBlock>{skill.markdown}</MarkdownBlock>
          {error && <p className="mt-2.5 text-copy text-accent-ink">{error}</p>}
          <ModalActions>
            {!readOnly && (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                {t('common.delete')}
              </Button>
            )}
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={t('panels.skillDeleteTitle', { name: skill.name })}
              description={t('panels.skillDeleteDescription')}
              confirmLabel={t('panels.memoryDeleteConfirm')}
              destructive
              onConfirm={() => void run(() => api.deleteSkill(canvasId, skill.name), onClose)}
            />
            <ModalSpacer />
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.close')}
            </Button>
            {!readOnly && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setDescription(skill.description)
                  setMarkdown(skill.markdown)
                  setError(null)
                  setEditing(true)
                }}
              >
                {t('panels.memoryEdit')}
              </Button>
            )}
          </ModalActions>
        </>
      )}
    </Modal>
  )
}
