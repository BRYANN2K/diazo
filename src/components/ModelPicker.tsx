import { posthog } from '../lib/posthog'
import { BrandMark } from './ui/brand-mark'
import { RUNNER_BRAND } from '../lib/runnerMarks'
import { DiazoAgentMark } from './Logo'
import { EffortGlyph, EffortMenu, ModelMenu } from './ModelMenu'
import { useAgentRunners, useRunnerPick } from '../lib/runnerPick'
import { resolveRunnerPick, type AgentRunner } from '../../shared/agentRunner'
import { useT } from '@/lib/i18n'
import { MenuButton } from './ui/menu-button'

/**
 * Where the next task goes: every connection the person has — the Claude
 * Plan on their desktop, their ChatGPT or API key — as two quiet pills beside
 * the composer's send button: the model, and the effort its connection
 * supports. The pick rides on the card (this browser remembers it) and is
 * independent of the Settings default, which is what comments, @mentions and
 * automations run on. With nothing connected there is nothing to choose
 * between, so the model pill says so and links to Settings. The menus
 * themselves are `ModelMenu` and `EffortMenu`, shared with the duel.
 */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const runners = useAgentRunners()
  const stored = useRunnerPick((s) => s.stored)
  const setPick = useRunnerPick((s) => s.setPick)
  const resolved = resolveRunnerPick(runners, stored)

  function choose(runner: AgentRunner, model: string) {
    const effort = resolved?.runner.provider === runner.provider ? resolved.pick.effort : runner.effort
    setPick({ provider: runner.provider, model, ...(effort ? { effort } : {}) })
    posthog.capture('agent_runner_picked', { provider: runner.provider, model, via: 'composer' })
  }

  function chooseEffort(effort: string | undefined) {
    if (!resolved) return
    /* "Default" is a real choice: the pick stops carrying an effort */
    const { effort: _effort, ...rest } = resolved.pick
    setPick(effort ? { ...rest, effort } : rest)
    posthog.capture('agent_effort_changed', {
      effort: effort ?? 'default',
      provider: resolved.runner.provider,
      via: 'composer',
    })
  }

  const pill = 'h-[26px] min-w-0 gap-[5px] rounded-pill px-[9px] text-ink shadow-ring hover:bg-well'
  /* the model pill is the one that gives way in a narrow foot: MenuButton is
     flex-none, so it opts back into shrinking and its label truncates down
     to its mark; the effort pill and the send button keep their size */
  /* min-w keeps the mark, one letter and the chevron in view */
  const modelPill = `${pill} flex-initial min-w-[52px]`
  return (
    <>
      <ModelMenu
        runners={runners?.runners ?? null}
        value={resolved?.pick}
        onModel={choose}
        trigger={(picked) => {
          const label = picked?.name ?? 'Diazo Agent'
          const mark = picked ? RUNNER_BRAND[picked.runner.provider] : undefined
          return (
            <MenuButton
              variant="quiet"
              disabled={disabled || !runners}
              aria-label={t('panels.modelAria', { label })}
              title={label}
              className={modelPill}
              icon={
                <span className="grid size-3 flex-none place-items-center">
                  {mark ? (
                    <BrandMark brand={mark} size={12} />
                  ) : (
                    /* no connection behind it: the Diazo Agent's own face */
                    <DiazoAgentMark size={12} className="block" />
                  )}
                </span>
              }
            >
              <span className="truncate">{label}</span>
            </MenuButton>
          )
        }}
      />
      <EffortMenu
        runner={resolved?.runner}
        effort={resolved?.pick.effort}
        onEffort={chooseEffort}
        effortDefault
        trigger={(picked) => (
          <MenuButton
            variant="quiet"
            disabled={disabled || !runners}
            aria-label={t('panels.modelEffortAria', { label: picked.text })}
            title={picked.text}
            className={pill}
            icon={
              <span className="grid size-3 flex-none place-items-center text-ink-2">
                <EffortGlyph fraction={picked.fraction} />
              </span>
            }
          >
            {/* in a narrow composer foot (a `@container/foot`) the dial alone
                stands for the level, which the label and title still name */}
            <span className="truncate @max-[330px]/foot:hidden">{picked.text}</span>
          </MenuButton>
        )}
      />
    </>
  )
}
