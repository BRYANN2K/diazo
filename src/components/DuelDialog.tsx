import { useState } from 'react'
import {
  runnerKey,
  type AgentRunner,
  type AgentRunners,
  type RunnerOption,
  type RunnerPick,
  type RunnerProvider,
} from '../../shared/agentRunner'
import { DUEL_MAX, DUEL_MIN, duelProblem } from '../../shared/duel'
import { api, errorMessage } from '../lib/api'
import { useStore } from '../lib/store'
import { useAgentRunners } from '../lib/runnerPick'
import { RUNNER_BRAND } from '../lib/runnerMarks'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { EffortGlyph, EffortMenu, ModelMenu, type PickedEffort, type PickedModel } from './ModelMenu'
import { BrandMark } from './ui/brand-mark'
import { Button } from './ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu'
import { PlusIcon } from './ui/icons'
import { MenuButton } from './ui/menu-button'
import { Textarea } from './ui/textarea'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'

export interface DuelChoice {
  /** the model's stable id: the connection and the model; the effort is a pick detail */
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

/** The connections as a duel slot's menu lists them: the duel's choices
 *  in place of each connection's own menu. */
function duelRunners(runners: AgentRunners | null): AgentRunner[] | null {
  if (!runners) return null
  return duelGroups(runners).map(({ runner, choices }) => ({ ...runner, models: choices.map((c) => c.model) }))
}

/** For each filled slot that repeats an earlier one (same connection, model
 *  and effort), the index of the slot it repeats. One run claims every card
 *  that agrees on the pick, so two equal slots would be one run, no duel. */
export function duelRepeats(slots: readonly (RunnerPick | undefined)[]): Map<number, number> {
  const seen = new Map<string, number>()
  const repeats = new Map<number, number>()
  slots.forEach((pick, index) => {
    if (!pick) return
    const key = runnerKey(pick)
    const first = seen.get(key)
    if (first === undefined) seen.set(key, index)
    else repeats.set(index, first)
  })
  return repeats
}

/** One duel slot: a model button and an effort button in the brief's foot,
 *  opening the same menus as the composer's two pills. Empty the model button
 *  reads "Model 2"; filled, the connection's mark and the model. Delete or
 *  Backspace on it clears it; the effort button shows only where the slot's
 *  connection has a dial. */
function DuelSlot({
  index,
  runners,
  pick,
  repeated,
  onPick,
}: {
  index: number
  runners: AgentRunner[] | null
  pick: RunnerPick | undefined
  repeated: boolean
  onPick: (pick: RunnerPick | undefined) => void
}) {
  const t = useT()
  const n = index + 1
  const optional = index >= DUEL_MIN
  const runner = pick ? runners?.find((r) => r.provider === pick.provider) : undefined

  function chooseModel(runner: AgentRunner, model: string) {
    /* the effort stays with the connection: kept across its own models, its
       configured one (or none: Default) on a change of connection */
    const effort = pick?.provider === runner.provider ? pick.effort : runner.effort
    onPick({ provider: runner.provider, model, ...(effort ? { effort } : {}) })
  }

  function chooseEffort(effort: string | undefined) {
    if (!pick) return
    onPick({ provider: pick.provider, model: pick.model, ...(effort ? { effort } : {}) })
  }

  const modelTrigger = (picked: PickedModel | undefined) => {
    const mark = picked ? RUNNER_BRAND[picked.runner.provider] : undefined
    return (
      <MenuButton
        variant="quiet"
        data-slot-index={n}
        data-filled={picked ? '' : undefined}
        disabled={!runners}
        aria-label={
          picked
            ? t('duel.slotAria', { n, label: picked.name })
            : optional
              ? t('duel.slotOptionalAria', { n })
              : t('duel.slotEmptyAria', { n })
        }
        title={picked ? `${picked.runner.name} · ${picked.name}` : undefined}
        onKeyDown={(e) => {
          if (pick && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault()
            onPick(undefined)
          }
        }}
        className="h-auto w-full min-w-0 max-w-none items-start gap-2 px-1.5 py-1 text-left [&>svg:last-child]:mt-0.5"
        icon={
          <span className="mt-0.5 grid size-3 flex-none place-items-center">
            {picked ? mark && <BrandMark brand={mark} size={12} /> : <PlusIcon className="size-3" strokeWidth={1.6} />}
          </span>
        }
      >
        {/* keyed by the pick, so a slot filling or changing eases its label in */}
        <span
          key={picked ? runnerKey(pick) : 'empty'}
          className="flex min-w-0 flex-1 flex-col gap-1 motion-safe:animate-[pop-in_320ms_var(--spring-snap)_both]"
        >
          <span className="font-mono text-micro text-ink-3">{t('duel.slot', { n })}</span>
          {picked && (
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 flex-none rounded-full bg-agent" />
              <span className="truncate font-semibold text-ink">{picked.name}</span>
            </span>
          )}
        </span>
      </MenuButton>
    )
  }

  const effortTrigger = (picked: PickedEffort) => (
    <MenuButton
      variant="quiet"
      data-effort-index={n}
      aria-label={t('duel.slotEffortAria', { n, label: picked.text })}
      className="mx-1.5 mb-1 mt-0.5 h-6 gap-1.5 self-start rounded-pill bg-well px-2 font-mono text-micro text-ink-2 hover:bg-well hover:text-ink"
      icon={<EffortGlyph fraction={picked.fraction} size={10} />}
    >
      {picked.text}
    </MenuButton>
  )

  return (
    /* each slot is a card: the model button on top, its effort pill beneath */
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-card bg-surface p-1.5 text-label shadow-ring',
        !pick && 'text-ink-3',
        repeated && 'text-danger shadow-[0_0_0_1px_var(--danger)]',
      )}
    >
      <ModelMenu
        runners={runners}
        value={pick}
        onModel={chooseModel}
        side="bottom"
        trigger={modelTrigger}
        footer={
          pick && (
            <>
              <DropdownMenuItem onSelect={() => onPick(undefined)}>{t('duel.clear', { n })}</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )
        }
      />
      {pick && (
        <EffortMenu
          runner={runner}
          effort={pick.effort}
          onEffort={chooseEffort}
          effortDefault
          side="bottom"
          trigger={effortTrigger}
        />
      )}
    </div>
  )
}

/** The composer's Duel: the brief goes to 2-3 picked models at once, each
 *  into its own empty frame beside the others, to compare and keep one.
 *  The dialog is the brief alone, the three model slots sitting in its foot
 *  the way the composer's model picker sits in the composer's. */
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
  const [slots, setSlots] = useState<(RunnerPick | undefined)[]>(() =>
    Array.from({ length: DUEL_MAX }, () => undefined),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const menuRunners = duelRunners(runners)
  const picks = slots.filter((pick): pick is RunnerPick => !!pick)
  const repeats = duelRepeats(slots)
  const problem = duelProblem(brief, picks)

  function setSlot(index: number, pick: RunnerPick | undefined) {
    setSlots((list) => list.map((old, i) => (i === index ? pick : old)))
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
      {/* the brief and its slots are one field, as in the composer */}
      <div className="mt-4">
        <Textarea
          rows={4}
          className="text-copy md:text-copy"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={t('duel.briefPlaceholder')}
          aria-label={t('duel.briefLabel')}
        />
        <div role="group" aria-label={t('duel.contestants')} className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {slots.map((pick, index) => (
            <DuelSlot
              key={index}
              index={index}
              runners={menuRunners}
              pick={pick}
              repeated={repeats.has(index)}
              onPick={(next) => setSlot(index, next)}
            />
          ))}
        </div>
      </div>
      {menuRunners && menuRunners.length === 0 && <p className="mt-2 text-body text-ink-2">{t('duel.noModels')}</p>}
      {[...repeats].map(([index, other]) => (
        <p key={index} role="alert" className="mt-2 text-body text-danger">
          !{t('duel.same', { n: index + 1, other: other + 1 })}
        </p>
      ))}
      {error && <p className="mt-2 text-body text-danger">! {error}</p>}
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
