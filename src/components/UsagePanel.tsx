import { useEffect, useState } from 'react'
import { formatCost, formatTokens, type AgentRunRecord, type UsageReport } from '../../shared/agentRuns'
import { api, errorMessage } from '../lib/api'
import { timeAgo } from '../lib/time'
import { useT } from '../lib/i18n'
import { ListHint, ListItem, ListMeta, ListSection, ListSummary, ListTitle } from './ui/list'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { SyncIcon } from './ui/icons'

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
        <ListTitle>{t('usage.totalCost', { cost: formatCost(total.costUsd) })}</ListTitle>
        <ListSummary>
          {t('usage.tokensInOut', { input: formatTokens(total.inputTokens), output: formatTokens(total.outputTokens) })}
          {' · '}
          {t('usage.totalTime', { time: elapsed(total.durationMs) })}
        </ListSummary>
        {notes.length > 0 && <ListMeta>{notes.join(' · ')}</ListMeta>}
      </ListItem>
      <ListSection>{t('usage.byModel')}</ListSection>
      {report.byModel.map((m) => (
        <ListItem key={m.model}>
          <ListTitle className="truncate">{m.model}</ListTitle>
          <ListSummary>
            {formatCost(m.unpriced && m.costUsd === 0 ? undefined : m.costUsd)}
            {' · '}
            {t('usage.tokensInOut', { input: formatTokens(m.inputTokens), output: formatTokens(m.outputTokens) })}
          </ListSummary>
          <ListMeta>
            {t('usage.runCount', { count: m.runs })}
            {m.cacheReadTokens > 0 && ` · ${t('usage.cached', { count: formatTokens(m.cacheReadTokens) })}`}
          </ListMeta>
        </ListItem>
      ))}
      <ListSection>{t('usage.runs')}</ListSection>
      {report.runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </PanelBody>
  )
}

function RunRow({ run }: { run: AgentRunRecord }) {
  const t = useT()
  const outcome =
    run.outcome === 'done'
      ? t('usage.outcomeDone')
      : run.outcome === 'stopped'
        ? t('usage.outcomeStopped')
        : t('usage.outcomeFailed')
  return (
    <ListItem>
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
    </ListItem>
  )
}
