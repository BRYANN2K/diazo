import { useEffect, useState } from 'react'
import { formatCost } from '../../shared/agentRuns'
import type { DuelEntryResult, DuelView } from '../../shared/duel'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { effortLabel } from '../lib/effortLabels'
import { useT } from '../lib/i18n'
import { FramePreview } from './FramePreview'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ListSection } from './ui/list'

function elapsed(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** The open model duels of this canvas, one comparison card each: every
 *  entry's render, cost, time and lint score side by side, and the button
 *  that keeps one. Re-read whenever a card on the board settles. */
export function DuelCards({ canvasId }: { canvasId: string }) {
  const t = useT()
  const settled = useStore((s) => s.tasks.filter((task) => task.endedAt || task.failedAt).length)
  const [duels, setDuels] = useState<DuelView[]>([])

  useEffect(() => {
    let live = true
    api
      .listDuels(canvasId)
      /* anything but a list (an older server, a stub) shows no duels rather
       * than throwing in render and taking the canvas page down with it */
      .then((list) => live && setDuels(Array.isArray(list) ? list : []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [canvasId, settled])

  const open = duels.filter((d) => !d.pickedFrameId)
  if (open.length === 0) return null
  return (
    <section aria-label={t('duel.cardsTitle')} className="flex flex-none flex-col pb-1">
      <ListSection>{t('duel.cardsTitle')}</ListSection>
      {open.map((duel) => (
        <DuelCard
          key={duel.id}
          canvasId={canvasId}
          duel={duel}
          onPicked={(next) => setDuels((list) => list.map((d) => (d.id === next.id ? next : d)))}
        />
      ))}
    </section>
  )
}

function DuelCard({
  canvasId,
  duel,
  onPicked,
}: {
  canvasId: string
  duel: DuelView
  onPicked: (duel: DuelView) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const allSettled = duel.results.every((r) => r.status === 'done' || r.status === 'failed')

  async function keep(entry: DuelEntryResult) {
    setBusy(true)
    try {
      onPicked(await api.pickDuel(canvasId, duel.id, entry.frameId))
      useStore.getState().pushNotice(t('duel.kept', { label: entry.label }))
    } catch (err) {
      useStore.getState().pushNotice(errorMessage(err, t('duel.pickFailed')))
      setBusy(false)
    }
  }

  return (
    <div className="mx-3 mb-2 rounded-card border border-border p-2">
      <p className="line-clamp-2 text-label text-ink-soft">{duel.brief}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {duel.results.map((entry) => (
          <div key={entry.frameId} className="flex min-w-0 flex-col gap-1">
            <div className="aspect-video overflow-hidden rounded-card border border-border bg-white">
              <FramePreview frameId={entry.exists ? entry.frameId : null} empty={null} />
            </div>
            <span className="truncate text-caption font-medium text-ink">{entry.label}</span>
            <span className="text-caption text-ink-faint">
              {[
                formatCost(entry.costUsd),
                elapsed(entry.durationMs),
                entry.runner.effort ? effortLabel(entry.runner.effort, undefined, t) : '',
                entry.lintScore !== undefined ? t('duel.lint', { score: entry.lintScore }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {entry.status === 'done' ? (
              <Button
                variant="default"
                size="sm"
                disabled={busy || !allSettled || !entry.exists}
                onClick={() => void keep(entry)}
              >
                {t('duel.keep')}
              </Button>
            ) : (
              <Badge tone="outline">
                {entry.status === 'failed'
                  ? t('duel.statusFailed')
                  : entry.status === 'running'
                    ? t('duel.statusRunning')
                    : t('duel.statusQueued')}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
