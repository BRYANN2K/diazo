import { useEffect, useState } from 'react'
import { NumberRoll } from './ui/number-roll'
import { formatCost, formatTokens, type AgentRunRecord, type UsageReport } from '../../shared/agentRuns'
import { api, errorMessage } from '../lib/api'
import { timeAgo } from '../lib/time'
import { useT } from '../lib/i18n'
import { ListHint, ListItem, ListMeta, ListRow, ListSection, ListSummary, ListTitle } from './ui/list'
import { RunReplayModal } from './RunReplayModal'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { SyncIcon } from './ui/icons'
import { modelNameForId } from '../../shared/agentRunner'

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The Usage tab of the agents panel: what every resident run on this canvas
 *  consumed, totalled per model and listed per run, newest first. Read when
 *  the tab opens; Refresh re-reads after a run ends. */
export function UsagePanel({ canvasId }: { canvasId: string }) {
  const t = useT()
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [openRun, setOpenRun] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .getUsage(canvasId)
      .then((next) => {
        if (!live) return
        setReport(next)
        setError('')
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err, t('usage.failed')))
      })
    return () => {
      live = false
    }
  }, [canvasId, nonce, t])

  if (error) return <ListHint className="pt-3">{error}</ListHint>
  if (!report) return <ListHint className="pt-3">{t('usage.loading')}</ListHint>
  if (report.runs.length === 0) return <ListHint className="pt-3">{t('usage.empty')}</ListHint>

  const { total } = report
  const notes = [
    total.costEstimated ? t('usage.estimated') : '',
    total.unpricedRuns > 0 ? t('usage.unpriced', { count: total.unpricedRuns }) : '',
  ].filter(Boolean)
  return (
    <PanelBody className="pb-2">
      <ListSection>
        {t('usage.totalRuns', { count: total.runs })}
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)} aria-label={t('usage.refresh')}>
          <SyncIcon />
        </Button>
      </ListSection>
      <ListItem>
        {/* the total rolls its changed digits (NumberRoll, 28px) as runs land */}
        <ListTitle>
          <span className="sr-only">{t('usage.totalCost', { cost: formatCost(total.costUsd) })}</span>
          <NumberRoll size="lg" value={formatCost(total.costUsd)} aria-hidden />
        </ListTitle>
        <ListSummary>
          {t('usage.tokensInOut', { input: formatTokens(total.inputTokens), output: formatTokens(total.outputTokens) })}
          {' · '}
          {t('usage.totalTime', { time: elapsed(total.durationMs) })}
        </ListSummary>
        {notes.length > 0 && <ListMeta>{notes.join(' · ')}</ListMeta>}
      </ListItem>
      <ListSection>{t('usage.byModel')}</ListSection>
      {/* per model: its name, its share of the spend as an agent-orange bar
          and its cost, tokens and runs on the line under it (Usage frame) */}
      {report.byModel.map((m) => {
        const share = total.costUsd > 0 ? Math.min(1, m.costUsd / total.costUsd) : 0
        return (
          <ListItem key={m.model}>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(48px,40%)_auto] items-center gap-3">
              <ListTitle className="truncate" title={m.model}>
                {modelNameForId(m.model)}
              </ListTitle>
              <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-well">
                <span className="block h-full rounded-full bg-agent" style={{ width: `${share * 100}%` }} />
              </span>
              <span className="font-mono text-label tabular-nums text-ink">
                {formatCost(m.unpriced && m.costUsd === 0 ? undefined : m.costUsd)}
              </span>
            </div>
            <ListMeta>
              {t('usage.tokensInOut', { input: formatTokens(m.inputTokens), output: formatTokens(m.outputTokens) })}
              {' · '}
              {t('usage.runCount', { count: m.runs })}
              {m.cacheReadTokens > 0 && ` · ${t('usage.cached', { count: formatTokens(m.cacheReadTokens) })}`}
            </ListMeta>
          </ListItem>
        )
      })}
      <ListSection>{t('usage.runs')}</ListSection>
      {report.runs.map((run) => (
        <RunRow key={run.id} run={run} onOpen={() => setOpenRun(run.id)} />
      ))}
      {openRun && <RunReplayModal canvasId={canvasId} runId={openRun} onClose={() => setOpenRun(null)} />}
    </PanelBody>
  )
}

function RunRow({ run, onOpen }: { run: AgentRunRecord; onOpen: () => void }) {
  const t = useT()
  const outcome =
    run.outcome === 'done'
      ? t('usage.outcomeDone')
      : run.outcome === 'stopped'
        ? t('usage.outcomeStopped')
        : t('usage.outcomeFailed')
  return (
    <ListRow onClick={onOpen} title={t('replay.openRun')}>
      <ListTitle className="truncate">
        {run.agent}
        {run.kind === 'chat' && ` · ${t('usage.kindChat')}`}
      </ListTitle>
      <ListSummary>{run.label}</ListSummary>
      <ListMeta>
        {[
          formatCost(run.costUsd),
          t('usage.tokensInOut', {
            input: formatTokens(run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens),
            output: formatTokens(run.outputTokens),
          }),
          elapsed(run.endedAt - run.startedAt),
          outcome,
          timeAgo(run.startedAt),
        ].join(' · ')}
      </ListMeta>
    </ListRow>
  )
}
