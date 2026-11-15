import { Fragment, useState, type ReactElement, type ReactNode } from 'react'
import { navigate } from '../App'
import { EffortSlider } from './ConnectionTable'
import { useAgentModels } from './ModelAccount'
import { effortLabel, effortOptions } from '../lib/effortLabels'
import { isLocalRunner, type AgentRunner, type RunnerOption, type RunnerPick } from '../../shared/agentRunner'
import { useT } from '@/lib/i18n'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/* the slider step standing for "no effort sent" */
const DEFAULT_EFFORT = '__default'

/** What a trigger shows for the current pick. */
export interface PickedModel {
  runner: AgentRunner
  /** the model's display name, from the live catalog once it has answered */
  name: string
  /** the effort's name ("High"), or "Default" where none is sent */
  effortText?: string
}

/**
 * The model menu every model pick opens: the connections, each under its
 * name (a desktop one that is not running says so beside it), their models
 * with the pick highlighted, the picked connection's reasoning effort as a
 * stepped slider, then Model settings. The composer's picker and each
 * duel slot render it; what a pick does is the caller's.
 *
 * The picked connection's live catalog is asked for once the menu opens
 * (a desktop connection already carries what its CLI lists). With
 * `effortDefault` a connection with no effort of its own offers "Default"
 * as the slider's first step: no effort is sent and it runs its own
 * setting, which `onEffort(undefined)` reports.
 */
export function ModelMenu({
  runners,
  value,
  onModel,
  onEffort,
  trigger,
  effortDefault = false,
  footer,
  side = 'top',
  align = 'end',
}: {
  /** every connection, its models as this menu should list them; null while loading */
  runners: AgentRunner[] | null
  value: RunnerPick | undefined
  onModel: (runner: AgentRunner, model: string) => void
  onEffort: (effort: string | undefined) => void
  /** the DropdownMenuTrigger's child, given what is picked */
  trigger: (picked: PickedModel | undefined) => ReactElement
  effortDefault?: boolean
  /** rows before Model settings (a duel slot's Clear) */
  footer?: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const runner = value ? runners?.find((r) => r.provider === value.provider) : undefined
  const liveKind = runner && !isLocalRunner(runner.provider) ? runner.provider : undefined
  const catalog = useAgentModels(liveKind, open)
  const modelsOf = (r: AgentRunner): RunnerOption[] =>
    r.provider === liveKind && catalog?.live ? catalog.models : r.models

  const withDefault = effortDefault && !!runner && !runner.effort
  const efforts = runner?.efforts && runner.efforts.length > 0 ? runner.efforts : undefined
  const effortText = !efforts
    ? undefined
    : value?.effort
      ? effortLabel(value.effort, efforts, t)
      : withDefault
        ? t('panels.modelEffortDefault')
        : undefined
  const picked: PickedModel | undefined =
    runner && value
      ? {
          runner,
          name: modelsOf(runner).find((m) => m.id === value.model)?.name ?? value.model ?? '',
          ...(effortText ? { effortText } : {}),
        }
      : undefined
  const connected = !!runners && runners.length > 0

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger(picked)}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width="auto">
        {connected ? (
          <>
            {runners.map((r) => (
              <Fragment key={r.provider}>
                {/* one connection needs no name; several are told apart by theirs */}
                <DropdownMenuCaption>
                  {runners.length > 1 ? r.name : t('models.model')}
                  {r.online === false && <span> · {t('panels.modelOffline')}</span>}
                </DropdownMenuCaption>
                <DropdownMenuRadioGroup
                  value={value?.provider === r.provider ? (value.model ?? '') : ''}
                  onValueChange={(model) => onModel(r, model)}
                >
                  {modelsOf(r).map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} title={m.blurb}>
                      {m.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </Fragment>
            ))}
            {catalog?.error && liveKind && (
              <DropdownMenuCaption className="pb-2 text-ink-faint">{catalog.error}</DropdownMenuCaption>
            )}
            {runner && efforts && (
              <>
                <DropdownMenuSeparator />
                <EffortSlider
                  efforts={[
                    ...(withDefault
                      ? [
                          {
                            id: DEFAULT_EFFORT,
                            name: t('panels.modelEffortDefault'),
                            blurb: t('panels.modelEffortDefaultBlurb'),
                          },
                        ]
                      : []),
                    ...effortOptions(runner.provider, efforts, t),
                  ]}
                  effort={value?.effort ?? (withDefault ? DEFAULT_EFFORT : undefined)}
                  onEffort={(id) => onEffort(id === DEFAULT_EFFORT ? undefined : id)}
                />
              </>
            )}
            <DropdownMenuSeparator />
          </>
        ) : (
          <DropdownMenuCaption className="pb-2 text-ink-soft">{t('panels.modelNoAccount')}</DropdownMenuCaption>
        )}
        {footer}
        <DropdownMenuItem onSelect={() => navigate('/settings?pane=agent')}>
          {connected ? t('panels.modelSettings') : t('panels.modelConnect')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
