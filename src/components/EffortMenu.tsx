import type { RunnerOption, RunnerProvider } from '../../shared/agentRunner'
import { effortLabel, effortOptions } from '../lib/effortLabels'
import { useT } from '../lib/i18n'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { MenuButton } from './ui/menu-button'

/* the radio value standing for "no effort sent": a Radix value cannot be empty */
const DEFAULT_VALUE = '__default'

/**
 * A compact effort pick beside a model: the level's name, a chevron, and the
 * connection's own levels in a menu. Driven entirely by the runner's effort
 * list, so a new provider's levels show up without a change here. With
 * `withDefault` the first row is "Default" (`undefined`): no effort is sent
 * and the connection runs on its own setting, which is what a connection
 * with no configured effort means.
 */
export function EffortMenu({
  provider,
  efforts,
  value,
  onChange,
  label,
  withDefault = false,
}: {
  provider: RunnerProvider
  efforts: readonly RunnerOption[]
  value: string | undefined
  onChange: (effort: string | undefined) => void
  /** the trigger's accessible name, e.g. "Reasoning effort for ChatGPT · GPT-6.1 Sol" */
  label: string
  withDefault?: boolean
}) {
  const t = useT()
  const options = effortOptions(provider, efforts, t)
  const shown = value ? effortLabel(value, efforts, t) : t('duel.effortDefault')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <MenuButton variant="quiet" aria-label={label} title={label} className="text-ink">
          {shown}
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="md">
        <DropdownMenuCaption>{t('models.reasoningEffort')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup
          value={value ?? DEFAULT_VALUE}
          onValueChange={(next) => onChange(next === DEFAULT_VALUE ? undefined : next)}
        >
          {withDefault && (
            <DropdownMenuRadioItem value={DEFAULT_VALUE} description={t('duel.effortDefaultBlurb')}>
              {t('duel.effortDefault')}
            </DropdownMenuRadioItem>
          )}
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} description={option.blurb}>
              {option.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
