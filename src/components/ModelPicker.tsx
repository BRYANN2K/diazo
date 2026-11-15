import { posthog } from '../lib/posthog'
import { BrandMark } from './ui/brand-mark'
import { RUNNER_BRAND } from '../lib/runnerMarks'
import { DiazoAgentMark } from './Logo'
import { ModelMenu } from './ModelMenu'
import { useAgentRunners, useRunnerPick } from '../lib/runnerPick'
import { resolveRunnerPick, type AgentRunner } from '../../shared/agentRunner'
import { useT } from '@/lib/i18n'
import { MenuButton } from './ui/menu-button'

/**
 * Where the next task goes: every connection the person has — the Claude
 * Plan on their desktop, their ChatGPT or API key — with its models, as a
 * quiet dropdown beside the composer's send button. The pick rides on the
 * card (this browser remembers it) and is independent of the Settings
 * default, which is what comments, @mentions and automations run on. With
 * nothing connected there is nothing to choose between, so it says so and
 * links to Settings. The menu itself is `ModelMenu`, shared with the duel.
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
    if (!resolved || !effort) return
    setPick({ ...resolved.pick, effort })
    posthog.capture('agent_effort_changed', { effort, provider: resolved.runner.provider, via: 'composer' })
  }

  return (
    <ModelMenu
      runners={runners?.runners ?? null}
      value={resolved?.pick}
      onModel={choose}
      onEffort={chooseEffort}
      trigger={(picked) => {
        const label = picked?.name ?? 'Diazo Agent'
        const mark = picked ? RUNNER_BRAND[picked.runner.provider] : undefined
        return (
          <MenuButton
            variant="quiet"
            disabled={disabled || !runners}
            aria-label={t('panels.modelAria', { label })}
            className="min-w-0 gap-[5px]"
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
            {/* the effort reads after the model, lighter, as in Settings */}
            {picked?.effortText && <span className="flex-none text-ink-faint">{picked.effortText}</span>}
          </MenuButton>
        )
      }}
    />
  )
}
