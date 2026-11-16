import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { navigate } from '../App'
import { useAgentModels } from './ModelAccount'
import { effortLabel, effortOptions } from '../lib/effortLabels'
import {
  isLocalRunner,
  knownModelName,
  type AgentRunner,
  type RunnerOption,
  type RunnerPick,
} from '../../shared/agentRunner'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
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
import { ChevronRightIcon } from './ui/icons'
import { SearchField } from './ui/search-field'

/* the radio id standing for "no effort sent" */
const DEFAULT_EFFORT = '__default'

/** What a model pill shows for the current pick. */
export interface PickedModel {
  runner: AgentRunner
  /** the model's display name, from the live catalog once it has answered */
  name: string
}

/** What an effort pill shows for the current pick. */
export interface PickedEffort {
  /** the level's name ("High"), or "Default" where none is sent */
  text: string
  /** the dial's fill: 0 hollow (Default), 1 full */
  fraction: number
}

/** A connection's rows as the menu splits them: the flagged entries ("Latest
 *  Opus" aliases, live-confirmed recommendations) up front, the rest under an
 *  "Older" fold. A list with nothing flagged — a curated fallback, a custom
 *  provider — shows everything. A picked id the list does not know leads the
 *  group so the check has a row. */
function splitModels(
  provider: AgentRunner['provider'],
  models: RunnerOption[],
  pickedId: string | undefined,
): { shown: RunnerOption[]; older: RunnerOption[] } {
  const flagged = models.filter((m) => m.recommended)
  const shown = flagged.length > 0 ? flagged : models
  const older = flagged.length > 0 ? models.filter((m) => !m.recommended) : []
  if (pickedId && !models.some((m) => m.id === pickedId))
    shown.unshift({ id: pickedId, name: knownModelName(provider, pickedId), blurb: '' })
  return { shown, older }
}

/** The dial glyph an effort pill wears: a ring filled to the level's share of
 *  its scale (quarter, half, three-quarter, full). */
export function EffortGlyph({
  fraction,
  size = 12,
  className,
}: {
  fraction: number
  size?: number
  className?: string
}) {
  const angle = Math.min(Math.max(fraction, 0), 1) * Math.PI * 2
  const r = 4.5
  const c = 6
  const end = `${(c + r * Math.sin(angle)).toFixed(2)} ${(c - r * Math.cos(angle)).toFixed(2)}`
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className={cn('flex-none', className)}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeOpacity={0.4} />
      {angle >= Math.PI * 2 - 0.01 ? (
        <circle cx={c} cy={c} r={r} fill="currentColor" />
      ) : angle > 0.01 ? (
        <path d={`M${c},${c} L${c},${c - r} A${r},${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${end} Z`} fill="currentColor" />
      ) : null}
    </svg>
  )
}

/** The level's share of its scale, for the dial glyph. */
function effortFraction(effort: string | undefined, efforts: readonly RunnerOption[]): number {
  const index = effort ? efforts.findIndex((e) => e.id === effort) : -1
  return index < 0 ? 0 : (index + 1) / efforts.length
}

/**
 * The model menu every model pick opens: a search field that filters the rows
 * as it types (↑/↓/↩ work from it), then the connections, each under its name
 * (a desktop one that is not running says so beside it). Each group lists its
 * recommended entries and folds the rest under "Older (N)", which expands in
 * place. The pick wears a check; Model settings ends the menu.
 *
 * The picked connection's live catalog is asked for once the menu opens (a
 * desktop connection already carries what its CLI lists). Rows carry no
 * tooltips: on staging they covered the row below.
 */
export function ModelMenu({
  runners,
  value,
  onModel,
  trigger,
  footer,
  side = 'top',
  align = 'end',
}: {
  /** every connection, its models as this menu should list them; null while loading */
  runners: AgentRunner[] | null
  value: RunnerPick | undefined
  onModel: (runner: AgentRunner, model: string) => void
  /** the DropdownMenuTrigger's child, given what is picked */
  trigger: (picked: PickedModel | undefined) => ReactElement
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
  const picked: PickedModel | undefined =
    runner && value
      ? {
          runner,
          name: value.model
            ? (modelsOf(runner).find((m) => m.id === value.model)?.name ?? knownModelName(runner.provider, value.model))
            : '',
        }
      : undefined
  const connected = !!runners && runners.length > 0
  const searchRef = useRef<HTMLInputElement>(null)

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger(picked)}</DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        width="auto"
        /* ~420px cap: the groups scroll inside, the search and the foot stay */
        className="flex max-h-[min(420px,var(--radix-dropdown-menu-content-available-height,420px))] flex-col overflow-hidden"
      >
        {connected ? (
          <>
            <ModelMenuList
              runners={runners}
              value={value}
              onModel={onModel}
              modelsOf={modelsOf}
              searchRef={searchRef}
              catalogError={liveKind ? catalog?.error : undefined}
            />
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

/** The menu's body: the search field and the scroll of groups. Mounted per
 *  open, so the query and the folds reset each time. */
function ModelMenuList({
  runners,
  value,
  onModel,
  modelsOf,
  searchRef,
  catalogError,
}: {
  runners: AgentRunner[]
  value: RunnerPick | undefined
  onModel: (runner: AgentRunner, model: string) => void
  modelsOf: (runner: AgentRunner) => RunnerOption[]
  searchRef: RefObject<HTMLInputElement>
  catalogError: string | undefined
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  /* the typing hand is already on the keys: once Radix has put focus on the
     menu, it lands in the search field */
  useEffect(() => {
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [searchRef])
  const q = query.trim().toLowerCase()
  const groups = runners.map((r) => {
    const models = modelsOf(r)
    const picked = value?.provider === r.provider ? value.model : undefined
    const { shown, older } = splitModels(r.provider, models, picked)
    /* a search folds nothing: matches surface from the whole list */
    const matches = q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : []
    return { runner: r, shown, older, matches, olderHasPick: !!picked && older.some((m) => m.id === picked) }
  })
  /* a fold holding the pick opens with the menu */
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.filter((g) => g.olderHasPick).map((g) => g.runner.provider)),
  )
  const listRef = useRef<HTMLDivElement>(null)
  const visible = groups.filter((g) => (q ? g.matches.length : g.shown.length + g.older.length) > 0)

  const items = () =>
    [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])].filter(
      (el) => el.getAttribute('aria-disabled') !== 'true',
    )

  /* the menu's typeahead would steal focus, so every key but Escape and Tab
     stops here; arrows move into the list, Enter takes its first row */
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const list = items()
      ;(e.key === 'ArrowDown' ? list[0] : list[list.length - 1])?.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      items()[0]?.click()
    } else if (e.key !== 'Escape' && e.key !== 'Tab') {
      e.stopPropagation()
    }
  }

  const toggle = (provider: string) =>
    setExpanded((set) => {
      const next = new Set(set)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })

  return (
    <>
      <SearchField
        ref={searchRef}
        variant="ring"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKey}
        placeholder={t('panels.modelSearch')}
        aria-label={t('panels.modelSearch')}
        className="mx-0.5 mb-1 mt-0.5 flex-none"
      />
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {visible.map(({ runner: r, shown, older, matches }) => (
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
              {(q ? matches : shown).map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id}>
                  {m.name}
                </DropdownMenuRadioItem>
              ))}
              {!q && older.length > 0 && (
                <>
                  <DropdownMenuItem
                    aria-expanded={expanded.has(r.provider)}
                    onSelect={(e) => {
                      /* the fold opens in place; the menu stays */
                      e.preventDefault()
                      toggle(r.provider)
                    }}
                  >
                    <ChevronRightIcon
                      width={12}
                      height={12}
                      aria-hidden
                      className={cn(
                        'flex-none text-ink-faint transition-transform duration-fast',
                        expanded.has(r.provider) && 'rotate-90',
                      )}
                    />
                    {t('panels.modelOlder', { count: older.length })}
                  </DropdownMenuItem>
                  {expanded.has(r.provider) &&
                    older.map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={m.id}>
                        {m.name}
                      </DropdownMenuRadioItem>
                    ))}
                </>
              )}
            </DropdownMenuRadioGroup>
          </Fragment>
        ))}
        {q && visible.length === 0 && (
          <DropdownMenuCaption className="pb-2 text-ink-faint">
            {t('panels.modelNoMatch', { query: query.trim() })}
          </DropdownMenuCaption>
        )}
        {catalogError && <DropdownMenuCaption className="pb-2 text-ink-faint">{catalogError}</DropdownMenuCaption>}
      </div>
    </>
  )
}

/**
 * The effort pill's own popover: the connection's effort levels as a radio
 * list, each named and blurred in the active language, plus a "Default" row
 * when the connection has no effort of its own (nothing is sent and it runs
 * its own setting, which `onEffort(undefined)` reports). The Faster/Smarter
 * caption under the list says which way the scale runs. Renders nothing where
 * the picked connection has no dial.
 */
export function EffortMenu({
  runner,
  effort,
  onEffort,
  trigger,
  effortDefault = false,
  side = 'top',
  align = 'end',
}: {
  /** the picked connection; the pill hides when it has no effort dial */
  runner: AgentRunner | undefined
  effort: string | undefined
  onEffort: (effort: string | undefined) => void
  trigger: (picked: PickedEffort) => ReactElement
  effortDefault?: boolean
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}) {
  const t = useT()
  const efforts = runner?.efforts && runner.efforts.length > 0 ? runner.efforts : undefined
  const picked: PickedEffort = {
    text: effort && efforts ? effortLabel(effort, efforts, t) : t('panels.modelEffortDefault'),
    fraction: efforts ? effortFraction(effort, efforts) : 0,
  }
  if (!runner || !efforts) return null
  const withDefault = effortDefault && !runner.effort
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger(picked)}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width="lg">
        <DropdownMenuCaption>{t('models.reasoningEffort')}</DropdownMenuCaption>
        <DropdownMenuRadioGroup
          value={effort ?? (withDefault ? DEFAULT_EFFORT : '')}
          onValueChange={(id) => onEffort(id === DEFAULT_EFFORT ? undefined : id)}
        >
          {withDefault && (
            <DropdownMenuRadioItem value={DEFAULT_EFFORT} description={t('panels.modelEffortDefaultBlurb')}>
              {t('panels.modelEffortDefault')}
            </DropdownMenuRadioItem>
          )}
          {effortOptions(runner.provider, efforts, t).map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id} description={o.blurb}>
              {o.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1 text-caption text-ink-faint">
          <span>{t('panels.effortFaster')}</span>
          <span aria-hidden>◂ ▸</span>
          <span>{t('panels.effortSmarter')}</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
