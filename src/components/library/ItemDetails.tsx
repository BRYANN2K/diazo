import { useState } from 'react'
import type { LibraryItemDetail, LibraryItemPatch } from '../../../shared/library'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'

type Item = LibraryItemDetail['item']

/** The item's description, tags, category and status: read for anyone,
 *  edited in place by someone who may curate. */
export function ItemDetails({
  item,
  curator,
  onSave,
}: {
  item: Item
  curator: boolean
  onSave: (patch: LibraryItemPatch) => Promise<void>
}) {
  const t = useT()
  const [draft, setDraft] = useState({
    description: item.description,
    tags: item.tags.join(', '),
    category: item.category,
    status: item.status === 'draft' ? 'draft' : item.status,
  })
  const [busy, setBusy] = useState(false)
  if (!curator) {
    return (
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-copy">
        <dt className="text-ink-faint">{t('library.description')}</dt>
        <dd className="text-ink-soft">{item.description || '—'}</dd>
        <dt className="text-ink-faint">{t('library.tags')}</dt>
        <dd className="text-ink-soft">{item.tags.join(', ') || '—'}</dd>
        <dt className="text-ink-faint">{t('library.category')}</dt>
        <dd className="text-ink-soft">{item.category}</dd>
      </dl>
    )
  }
  async function save() {
    setBusy(true)
    try {
      await onSave({
        description: draft.description,
        category: draft.category,
        tags: draft.tags
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        ...(draft.status !== 'draft' ? { status: draft.status as 'active' | 'deprecated' | 'hidden' } : {}),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="item-details-form">
      <label className="flex flex-col gap-1 text-label text-ink-soft">
        {t('library.description')}
        <Textarea
          variant="well"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-label text-ink-soft">
        {t('library.tags')}
        <Input
          variant="well"
          aria-label={t('library.tags')}
          value={draft.tags}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-label text-ink-soft">
        {t('library.category')}
        <Input
          variant="well"
          value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}
        />
      </label>
      <Select value={draft.status} onValueChange={(status) => setDraft({ ...draft, status: status as Item['status'] })}>
        <SelectTrigger className="w-48" aria-label={t('library.status')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {item.status === 'draft' && <SelectItem value="draft">{t('library.status_draft')}</SelectItem>}
          <SelectItem value="active">{t('library.status_active')}</SelectItem>
          <SelectItem value="deprecated">{t('library.status_deprecated')}</SelectItem>
          <SelectItem value="hidden">{t('library.status_hidden')}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="primary" className="self-start" disabled={busy} onClick={() => void save()}>
        {t('library.save')}
      </Button>
    </div>
  )
}

/** Why the item is what it is: the rules' findings, in words. */
export function ItemFindings({ item }: { item: Item }) {
  const t = useT()
  if (!item.findings.length) return <p className="text-copy text-ink-faint">{t('library.noFindings')}</p>
  return (
    <ul className="flex flex-col gap-1.5 text-copy text-ink-soft">
      {item.findings.map((f, i) => (
        <li key={i}>
          <span className="font-mono text-caption text-ink-faint">{f.kind}</span> {f.message}
        </li>
      ))}
    </ul>
  )
}
