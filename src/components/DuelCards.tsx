import { useEffect, useState } from 'react'
import { formatCost } from '../../shared/agentRuns'
import type { DuelView } from '../../shared/duel'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { FramePreview } from './FramePreview'
import { Badge } from './ui/badge'
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
      .then((list) => live && setDuels(list))
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
        <DuelCard key={duel.id} duel={duel} />
      ))}
    </section>
  )
}

function DuelCard({ duel }: { duel: DuelView }) {
  const t = useT()

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
                entry.lintScore !== undefined ? t('duel.lint', { score: entry.lintScore }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {entry.status !== 'done' && (
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
