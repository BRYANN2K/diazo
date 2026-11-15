import { isLocalRunner, type RunnerOption, type RunnerProvider } from '../../shared/agentRunner'
import type { PlainMessageKey, Translate } from './i18n'

/* the effort ids stay as sent to the server; only their names are translated */
const EFFORT_NAMES: Record<string, PlainMessageKey> = {
  low: 'models.effortLow',
  medium: 'models.effortMedium',
  high: 'models.effortHigh',
  xhigh: 'models.effortXhigh',
  max: 'models.effortMax',
}
const EFFORT_BLURBS: Record<string, PlainMessageKey> = {
  low: 'models.effortLowBlurb',
  medium: 'models.effortMediumBlurb',
  high: 'models.effortHighBlurb',
  xhigh: 'models.effortXhighBlurb',
}
/* a desktop agent's dial reads differently: it is the CLI's own levels */
const CLAUDE_EFFORT_BLURBS: Record<string, PlainMessageKey> = {
  low: 'models.claudeEffortLowBlurb',
  medium: 'models.claudeEffortMediumBlurb',
  high: 'models.claudeEffortHighBlurb',
  xhigh: 'models.claudeEffortXhighBlurb',
  max: 'models.claudeEffortMaxBlurb',
}

/** One effort id in the active language — its provider-given name when the
 *  i18n table does not know it (a server default like `none`), else the id. */
export function effortLabel(effort: string, options: readonly RunnerOption[] | undefined, t: Translate): string {
  const key = EFFORT_NAMES[effort]
  return key ? t(key) : (options?.find((option) => option.id === effort)?.name ?? effort)
}

/** A connection's effort options, named and blurred in the active language,
 *  for an effort dial. A step the table does not know is called the server's
 *  default, as the composer's picker always has. */
export function effortOptions(
  provider: RunnerProvider,
  options: readonly RunnerOption[],
  t: Translate,
): { id: string; name: string; blurb: string }[] {
  const blurbs = isLocalRunner(provider) ? CLAUDE_EFFORT_BLURBS : EFFORT_BLURBS
  return options.map((option) => {
    const name = EFFORT_NAMES[option.id]
    const blurb = blurbs[option.id]
    return {
      id: option.id,
      name: name ? t(name) : option.name,
      blurb: blurb ? t(blurb) : t('models.effortServerDefault'),
    }
  })
}
