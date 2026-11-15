import { useState } from 'react'
import { isLocalRunner, type AgentRunners, type RunnerOption, type RunnerPick } from '../../shared/agentRunner'
import { DUEL_MAX, DUEL_MIN, duelProblem } from '../../shared/duel'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { useAgentRunners } from '../lib/runnerPick'
import { effortOptions } from '../lib/effortLabels'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { StepSlider } from './ui/step-slider'
import { Textarea } from './ui/textarea'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

interface Choice {
  /** the row's stable id: the connection and the model; the effort is a pick detail */
  key: string
  pick: RunnerPick
  label: string
  /** the effort dial, where the connection has one */
  efforts?: RunnerOption[]
  provider: RunnerPick['provider']
}

/** Every connection × model the person can send to, as duel choices. The
 *  models already come from the connection's own catalog (agent-runners);
 *  here only the entries that are not a model to compare are weeded out:
 *  the Plan's "Claude Code default" alias stands for whatever the CLI is
 *  set to, while a pinned `claude-*` id the Plan is set to is a real model. */
export function duelChoices(runners: AgentRunners | null): Choice[] {
  return (runners?.runners ?? []).flatMap((runner) => {
    let models = runner.models.length > 0 ? runner.models : [{ id: runner.model, name: runner.model, blurb: '' }]
    /* a desktop CLI's `default` is whatever it is set to, not a model to compare */
    if (isLocalRunner(runner.provider)) {
      models = models.filter((model) => model.id !== 'default')
      if (runner.model !== 'default' && !models.some((model) => model.id === runner.model))
        models = [...models, { id: runner.model, name: runner.model, blurb: '' }]
    }
    return models.map((model) => ({
      key: `${runner.provider}|${model.id}`,
      provider: runner.provider,
      pick: { provider: runner.provider, model: model.id, ...(runner.effort ? { effort: runner.effort } : {}) },
      label: `${runner.name} · ${model.name}`,
      efforts: runner.efforts,
    }))
  })
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
  const [chosen, setChosen] = useState<string[]>([])
  /* a row's effort once the dial was touched; untouched rows run their
     connection's configured effort (choice.pick carries it) */
  const [effortOf, setEffortOf] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const choices = duelChoices(runners)
  const picks = choices
    .filter((c) => chosen.includes(c.key))
    .map((c) => ({ ...c.pick, ...(effortOf[c.key] !== undefined ? { effort: effortOf[c.key] } : {}) }))
  const problem = duelProblem(brief, picks)

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
    <Modal size="md" onClose={onClose}>
      <ModalTitle>{t('duel.title')}</ModalTitle>
      <ModalLede>{t('duel.lede', { min: DUEL_MIN, max: DUEL_MAX })}</ModalLede>
      <Textarea
        className="mt-4"
        rows={4}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={t('duel.briefPlaceholder')}
      />
      <div className="mt-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
        {choices.length === 0 && <p className="text-body text-muted-foreground">{t('duel.noModels')}</p>}
        {choices.map((choice) => {
          const on = chosen.includes(choice.key)
          return (
            <div key={choice.key}>
              <label className="flex items-center gap-2 text-body">
                <Checkbox
                  checked={on}
                  disabled={!on && chosen.length >= DUEL_MAX}
                  onChange={() => toggle(choice.key)}
                />
                {choice.label}
              </label>
              {on && choice.efforts && choice.efforts.length > 0 && (
                <StepSlider
                  className="ml-6 mt-1"
                  label={t('duel.effortFor', { label: choice.label })}
                  steps={effortOptions(choice.provider, choice.efforts, t).map((step) => ({
                    ...step,
                    title: step.blurb,
                  }))}
                  value={effortOf[choice.key] ?? choice.pick.effort}
                  onValueChange={(effort) => setEffortOf((map) => ({ ...map, [choice.key]: effort }))}
                />
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="mt-2 text-body text-muted-foreground">{error}</p>}
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
