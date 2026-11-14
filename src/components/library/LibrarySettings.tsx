import { useEffect, useState } from 'react'
import type { LibraryDetail, LibraryListEntry } from '../../../shared/library'
import { rulesOrDefault } from '../../../shared/libraryRules'
import { api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { ConfirmDialog } from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { CardHeader, CardRow, CardTitle, SettingsCard } from '../ui/card'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { LibraryRulesForm } from './LibraryRulesForm'

/**
 * A library's settings, for whoever manages it: its description, its kinds,
 * its rules (with their effect previewed), the categories of another
 * library, a reindex, and "Stop being a library".
 */
export function LibrarySettings({ detail, onChanged }: { detail: LibraryDetail; onChanged?: () => void }) {
  const t = useT()
  const [description, setDescription] = useState(detail.library.description)
  const [confirming, setConfirming] = useState(false)
  const [others, setOthers] = useState<LibraryListEntry[]>([])
  const [from, setFrom] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [describe, setDescribe] = useState(!!detail.library.describeItems)

  useEffect(() => {
    api
      .listLibraries()
      .then((r) => setOthers(r.libraries.filter((l) => l.id !== detail.id)))
      .catch(() => {})
  }, [detail.id])

  async function transfer() {
    if (!from) return
    const dry = await api.transferLibraryCategories(detail.id, from, true)
    if (!window.confirm(t('library.transferConfirm', { matched: dry.matched, changes: dry.changes }))) return
    const done = await api.transferLibraryCategories(detail.id, from)
    setNotice(
      t('library.transferDone', { changes: done.changes, onlyFrom: done.onlyFromCount, onlyTo: done.onlyToCount }),
    )
    onChanged?.()
  }

  return (
    <div className="flex flex-col" data-testid="library-settings">
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('library.settingsTitle')}</CardTitle>
        </CardHeader>
        <CardRow
          label={t('library.description')}
          controlWidth="lg"
          control={
            <Input
              variant="well"
              aria-label={t('library.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => void api.updateLibrary(detail.id, { description }).then(() => onChanged?.())}
            />
          }
        />
        <CardRow label={t('library.kinds')}>
          <span className="text-copy text-ink-soft">
            {detail.taxonomy.kinds.map((k) => `${k.id} (${k.label})`).join(', ') || '—'}
          </span>
        </CardRow>
        <CardRow
          label={t('library.transferLabel')}
          control={
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger className="w-full" aria-label={t('library.transferLabel')}>
                <SelectValue placeholder={t('library.transferPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {others.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          action={
            <Button size="sm" disabled={!from} onClick={() => void transfer()}>
              {t('library.transferAction')}
            </Button>
          }
        />
        <CardRow label={t('library.describeLabel')}>
          <div className="flex items-start gap-3">
            <Switch
              aria-label={t('library.describeLabel')}
              checked={describe}
              onCheckedChange={(on) => {
                setDescribe(on)
                void api
                  .updateLibrary(detail.id, { describeItems: on })
                  .then(() => onChanged?.())
                  .catch(() => setDescribe(!on))
              }}
            />
            <span className="text-caption text-ink-faint">{t('library.describeCost')}</span>
          </div>
        </CardRow>
        <CardRow
          label={t('library.reindexLabel')}
          action={
            <Button
              size="sm"
              onClick={() => void api.reindexLibrary(detail.id).then(() => setNotice(t('library.reindexing')))}
            >
              {t('library.reindex')}
            </Button>
          }
        />
        <CardRow
          label={t('library.stopLabel')}
          action={
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
              {t('library.stop')}
            </Button>
          }
        />
      </SettingsCard>
      {notice && <p className="mt-2 text-caption text-ink-faint">{notice}</p>}
      <LibraryRulesForm libraryId={detail.id} rules={rulesOrDefault(detail.rules)} onSaved={() => onChanged?.()} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('library.stopTitle')}
        description={t('library.stopDescription')}
        confirmLabel={t('library.stop')}
        destructive
        onConfirm={() => void api.deleteLibrary(detail.id).then(() => navigate('/libraries'))}
      />
    </div>
  )
}
