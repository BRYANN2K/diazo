import { useState } from 'react'
import {
  type AgentRunner,
  type AgentRunners,
  type RunnerOption,
  type RunnerPick,
  type RunnerProvider,
} from '../../shared/agentRunner'
import { DUEL_MAX, DUEL_MIN, duelLetter, duelProblem } from '../../shared/duel'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { useAgentRunners } from '../lib/runnerPick'
import { RUNNER_APP_ICON } from '../lib/runnerMarks'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { EffortMenu } from './EffortMenu'
import { AppIcon } from './ui/brand-mark'
import { Avatar } from './ui/avatar'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { IconButton } from './ui/icon-button'
import { XIcon } from './ui/icons'
import { SearchField } from './ui/search-field'
import { Textarea } from './ui/textarea'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

/** Past this many models the list gets a search field. */
const SEARCH_FROM = 7

export interface DuelChoice {
  /** the row's stable id: the connection and the model; the effort is a pick detail */
  key: string
  provider: RunnerProvider
  runnerName: string
  model: RunnerOption
  /** "ChatGPT · GPT-6.1 Sol" */
  label: string
  /** the pick as it runs untouched: the connection's configured effort */
  pick: RunnerPick
  /** the effort levels, where the connection has any */
  efforts?: RunnerOption[]
}

export interface DuelGroup {
  runner: AgentRunner
  choices: DuelChoice[]
}

/** Every connection the person can send to, with its models as duel
 *  choices. The models already come from the connection's own catalog
 *  (agent-runners), so this knows no provider by name: it only drops a
 *  `default` entry, which stands for whatever the connection is set to and
 *  could not answer a brief differently from the model beside it, and keeps
 *  a configured model the menu does not list (a pinned id) as a choice. */
export function duelGroups(runners: AgentRunners | null): DuelGroup[] {
  return (runners?.runners ?? []).flatMap((runner) => {
    let models = runner.models.filter((model) => model.id !== 'default')
    if (runner.model && runner.model !== 'default' && !models.some((model) => model.id === runner.model))
      models = [...models, { id: runner.model, name: runner.model, blurb: '' }]
    if (models.length === 0) return []
    const efforts = runner.efforts && runner.efforts.length > 0 ? runner.efforts : undefined
    const choices = models.map((model) => ({
      key: `${runner.provider}|${model.id}`,
      provider: runner.provider,
      runnerName: runner.name,
      model,
      label: `${runner.name} · ${model.name}`,
      pick: { provider: runner.provider, model: model.id, ...(runner.effort ? { effort: runner.effort } : {}) },
      ...(efforts ? { efforts } : {}),
    }))
    return [{ runner, choices }]
  })
}

export function duelChoices(runners: AgentRunners | null): DuelChoice[] {
  return duelGroups(runners).flatMap((group) => group.choices)
}

/** The groups narrowed to the models a query names: by model name or id,
 *  or by the connection's name, which keeps that whole group. */
export function filterDuelGroups(groups: DuelGroup[], query: string): DuelGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return groups
  return groups.flatMap((group) => {
    const choices = group.choices.filter((choice) => {
      const text = `${group.runner.name} ${choice.model.name} ${choice.model.id}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
    return choices.length > 0 ? [{ ...group, choices }] : []
  })
}

/** A connection's face: its app tile, or its initials for a provider this
 *  build has no tile for. */
function RunnerFace({ runner, size }: { runner: Pick<AgentRunner, 'provider' | 'name'>; size: number }) {
  const brand = RUNNER_APP_ICON[runner.provider]
  return brand ? <AppIcon brand={brand} size={size} /> : <Avatar name={runner.name} size={size} />
}

/** The composer's Duel: the brief goes to 2-3 picked models at once, each
 *  into its own empty frame beside the others, to compare and keep one. */
export function DuelDialog({
  canvasId,
  brief: initialBrief,
  onClose,
  onStarted,
}: {
  canvasId: string
  brief: string
  onClose: () => void
  onStarted: () => void
}) {
  const t = useT()
  const runners = useAgentRunners()
  const pageId = useStore((s) => s.activePageId) ?? undefined
  const [brief, setBrief] = useState(initialBrief)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  /* a contestant's effort once its menu was used (`null` = Default, no effort
     sent); an untouched one runs its connection's configured effort */
  const [effortOf, setEffortOf] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const groups = duelGroups(runners)
  const choices = groups.flatMap((group) => group.choices)
  const shown = filterDuelGroups(groups, query)
  const contestants = chosen.flatMap((key) => choices.filter((choice) => choice.key === key))
  const effortFor = (choice: DuelChoice): string | undefined => {
    const own = effortOf[choice.key]
    return own === undefined ? choice.pick.effort : (own ?? undefined)
  }
  const picks = contestants.map((choice) => {
    const effort = effortFor(choice)
    return { provider: choice.provider, model: choice.model.id, ...(effort ? { effort } : {}) }
  })
  const problem = duelProblem(brief, picks)
  const full = chosen.length >= DUEL_MAX

  function toggle(key: string) {
    setChosen((list) =>
      list.includes(key) ? list.filter((k) => k !== key) : list.length < DUEL_MAX ? [...list, key] : list,
    )
  }

  async function start() {
    if (problem || busy) return
    setBusy(true)
    setError('')
    try {
      await api.startDuel(canvasId, brief.trim(), picks, pageId)
      useStore.getState().pushNotice(t('duel.started', { count: picks.length }))
      useStore.getState().allowanceChanged()
      onStarted()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(errorMessage(err, t('duel.failed')))
    }
  }

  return (
    <Modal size="lg" onClose={onClose}>
      <ModalTitle>{t('duel.title')}</ModalTitle>
      <ModalLede>{t('duel.lede', { min: DUEL_MIN, max: DUEL_MAX })}</ModalLede>
      <Textarea
        className="mt-4"
        rows={3}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={t('duel.briefPlaceholder')}
        aria-label={t('duel.briefLabel')}
      />

      <section aria-label={t('duel.contestants')} className="mt-4 flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-label font-medium text-ink">{t('duel.contestants')}</span>
          <span className="text-caption text-ink-faint">
            {t('duel.picked', { count: chosen.length, max: DUEL_MAX })}
          </span>
        </div>
        {Array.from({ length: DUEL_MAX }, (_, i) => {
          const choice = contestants[i]
          const letter = duelLetter(i)
          if (!choice)
            return (
              <div
                key={`empty-${letter}`}
                className="flex h-11 items-center gap-3 rounded-card border border-dashed border-line px-3 text-body text-ink-faint"
              >
                <Badge tone="outline">{letter}</Badge>
                {i < DUEL_MIN ? t('duel.slotEmpty') : t('duel.slotOptional')}
              </div>
            )
          return (
            <div
              key={choice.key}
              data-contestant={letter}
              className="flex h-11 items-center gap-3 rounded-card bg-sub pl-3 pr-1.5 shadow-ring"
            >
              <Badge tone="brand">{letter}</Badge>
              <RunnerFace runner={{ provider: choice.provider, name: choice.runnerName }} size={20} />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-body font-medium text-ink">{choice.model.name}</span>
                <span className="truncate text-caption text-ink-faint">{choice.runnerName}</span>
              </span>
              {choice.efforts && (
                <EffortMenu
                  provider={choice.provider}
                  efforts={choice.efforts}
                  value={effortFor(choice)}
                  withDefault={!choice.pick.effort}
                  label={t('duel.effortFor', { label: choice.label })}
                  onChange={(effort) => setEffortOf((map) => ({ ...map, [choice.key]: effort ?? null }))}
                />
              )}
              <IconButton
                size="sm"
                shape="round"
                variant="danger"
                aria-label={t('duel.remove', { label: choice.label })}
                onClick={() => toggle(choice.key)}
              >
                <XIcon size={14} />
              </IconButton>
            </div>
          )
        })}
      </section>

      {choices.length === 0 ? (
        <p className="mt-4 text-body text-ink-soft">{t('duel.noModels')}</p>
      ) : (
        <>
          {choices.length >= SEARCH_FROM && (
            <SearchField
              className="mt-4"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('duel.search')}
              aria-label={t('duel.search')}
            />
          )}
          <div
            role="group"
            aria-label={t('duel.models')}
            className={cn(
              'mt-3 max-h-72 overflow-y-auto overscroll-contain rounded-card bg-surface shadow-ring',
              choices.length < SEARCH_FROM && 'mt-4',
            )}
          >
            {shown.length === 0 && (
              <p className="px-3 py-4 text-body text-ink-faint">{t('duel.noMatch', { query: query.trim() })}</p>
            )}
            {shown.map(({ runner, choices: rows }) => (
              <div key={runner.provider} role="group" aria-label={runner.name}>
                <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line-soft bg-surface px-3 py-2">
                  <RunnerFace runner={runner} size={20} />
                  <span className="text-label font-medium text-ink">{runner.name}</span>
                  {runner.email && <span className="truncate text-caption text-ink-faint">{runner.email}</span>}
                  {runner.online === false && (
                    <span className="ml-auto flex-none text-caption text-ink-faint">{t('duel.offline')}</span>
                  )}
                </div>
                {rows.map((choice) => {
                  const index = chosen.indexOf(choice.key)
                  const on = index >= 0
                  const disabled = !on && full
                  return (
                    <label
                      key={choice.key}
                      className={cn(
                        'relative flex items-center gap-3 px-3 py-2',
                        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-paper-deep',
                        on && 'bg-paper-deep',
                      )}
                      title={disabled ? t('duel.full') : choice.model.id}
                    >
                      <Checkbox
                        checked={on}
                        disabled={disabled}
                        aria-label={choice.label}
                        onChange={() => toggle(choice.key)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-ink">{choice.model.name}</span>
                        {choice.model.blurb && (
                          <span className="truncate text-caption text-ink-faint">{choice.model.blurb}</span>
                        )}
                      </span>
                      {on && <Badge tone="brand">{duelLetter(index)}</Badge>}
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
          {full && <p className="mt-2 text-caption text-ink-faint">{t('duel.full')}</p>}
        </>
      )}

      {error && <p className="mt-2 text-body text-accent-ink">{error}</p>}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('duel.cancel')}
        </Button>
        <ModalSpacer />
        <Button variant="primary" disabled={!!problem || busy} onClick={() => void start()}>
          {busy ? t('duel.starting') : t('duel.start', { count: picks.length })}
        </Button>
      </ModalActions>
    </Modal>
  )
}
