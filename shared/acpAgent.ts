/**
 * Local agents over the Agent Client Protocol: the Devin CLI and the Grok CLI
 * run on the person's own desktop, the way the Claude Plan runs Claude Code
 * (shared/localAgent.ts). The desktop shell is the ACP client
 * (desktop/src-tauri/src/acp.rs); the server hands it jobs through the same
 * relay as the Plan (server/localAgentRuns.ts), keyed by agent.
 *
 * Each agent is a connection of its own (`devin-local`, `grok-local`) with
 * a model menu and, where the CLI has one, an effort dial. The menus are
 * curated here and widened by what the desktop's CLI lists (`devin models`,
 * `grok models`), which the desktop reports while it polls.
 */
import type { RunnerOption } from './agentRunner.ts'

export const ACP_AGENTS = ['devin', 'grok'] as const
export type AcpAgent = (typeof ACP_AGENTS)[number]

export type AcpRunnerProvider = 'devin-local' | 'grok-local'

export const ACP_RUNNER: Record<AcpAgent, AcpRunnerProvider> = {
  devin: 'devin-local',
  grok: 'grok-local',
}

export const ACP_RUNNER_PROVIDERS: readonly AcpRunnerProvider[] = ACP_AGENTS.map((agent) => ACP_RUNNER[agent])

/** What the composer, Settings and the meter call each one. */
export const ACP_AGENT_NAMES: Record<AcpAgent, string> = {
  devin: 'Devin (desktop)',
  grok: 'Grok (desktop)',
}

/** What the person runs in a terminal to sign the CLI in; the shell says the same. */
export const ACP_LOGIN_COMMANDS: Record<AcpAgent, string> = {
  devin: 'devin auth login',
  grok: 'grok login',
}

export function isAcpAgent(value: unknown): value is AcpAgent {
  return ACP_AGENTS.some((agent) => agent === value)
}

export function isAcpRunnerProvider(value: unknown): value is AcpRunnerProvider {
  return ACP_RUNNER_PROVIDERS.some((provider) => provider === value)
}

export function acpAgentOf(provider: AcpRunnerProvider): AcpAgent {
  return provider === 'devin-local' ? 'devin' : 'grok'
}

/** A model id as the CLI takes it. Mirrors `valid_model` in acp.rs, which
 *  checks it again before it becomes an argument: it can never be a flag. */
export const ACP_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/

/** `default` is the CLI's own model: no flag. */
export function isAcpModel(value: unknown): value is string {
  return typeof value === 'string' && ACP_MODEL_ID.test(value)
}

/** The effort levels, in order. Devin encodes its effort in the model id
 *  (`swe-2-high`); Grok takes `--reasoning-effort` (mirrored by
 *  `valid_effort` in acp.rs), whose levels its ACP handshake lists. */
export const ACP_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AcpEffort = (typeof ACP_EFFORT_ORDER)[number]
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly AcpEffort[]

const EFFORT_NAMES: Record<AcpEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
const EFFORT_BLURBS: Record<AcpEffort, string> = {
  low: 'Fastest — fine for small, mechanical edits',
  medium: 'A good everyday setting for design work',
  high: 'More thinking per turn — for layouts that have to be right',
  xhigh: 'Deeper still; slower turns',
  max: 'All the thinking it can do, and the slowest turns',
}

function effortOptions(levels: readonly AcpEffort[]): RunnerOption[] {
  return levels.map((id) => ({ id, name: EFFORT_NAMES[id], blurb: EFFORT_BLURBS[id] }))
}

export function isAcpEffort(agent: AcpAgent, value: unknown): value is AcpEffort {
  const levels: readonly string[] = agent === 'grok' ? GROK_EFFORTS : ACP_EFFORT_ORDER
  return typeof value === 'string' && levels.includes(value)
}

export interface AcpAgentPreference {
  enabled: boolean
  /** `default`, a menu id (a Devin family, a Grok model) or a pinned CLI id */
  model: string
  /** unset = the CLI's own setting (Grok), the family's middle step (Devin) */
  effort?: AcpEffort
}

export const DEFAULT_ACP_MODEL = 'default'

export function normalizeAcpModel(model: unknown): string {
  return isAcpModel(model) ? model : DEFAULT_ACP_MODEL
}

/** One model as the desktop's CLI lists it (acp.rs `parse_*_models`). */
export interface AcpCatalogModel {
  id: string
  name: string
  /** Devin: the family's display name the variant sits under */
  family?: string
}

export const ACP_CATALOG_MAX = 400

/* ---------------------------------------------------------------- */
/* Devin: a family per menu entry, its effort a suffix               */
/* ---------------------------------------------------------------- */

/** A Devin model family: the menu entry. `efforts` are the variants that
 *  exist as `<id>-<effort>`; none means the id runs as is. */
export interface DevinFamily {
  id: string
  name: string
  blurb: string
  efforts: readonly AcpEffort[]
}

/** The families worth a designer's pick, as `devin models` listed them
 *  (Devin 3000.12). Whatever else the desktop's CLI lists joins after them. */
export const DEVIN_FAMILIES: readonly DevinFamily[] = [
  { id: 'default', name: 'Devin default', blurb: 'Whatever model your Devin is set to.', efforts: [] },
  {
    id: 'swe-2',
    name: 'SWE-2',
    blurb: "Cognition's agent model — free on Devin plans.",
    efforts: ['medium', 'high', 'max'],
  },
  {
    id: 'swe-2-flash',
    name: 'SWE-2 Flash',
    blurb: 'The fast SWE-2, for quick edits.',
    efforts: ['medium', 'high', 'max'],
  },
  {
    id: 'claude-fable-5-2',
    name: 'Claude Fable 5.2',
    blurb: 'For the hardest, longest tasks, on your Devin usage.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    blurb: 'For complex layouts, on your Devin usage.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    blurb: "OpenAI's frontier model, on your Devin usage.",
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
]

const EFFORT_SUFFIX = new RegExp(`^(.+)-(${ACP_EFFORT_ORDER.join('|')})$`)

/** `devin models`' variants folded into families: `swe-2-high` is SWE-2 at
 *  high; a variant with another suffix (`-fast`, `-lightning`) or none is a
 *  model of its own with no dial. Curated families come first, keeping
 *  their names and blurbs and taking the effort steps the CLI really has. */
export function devinFamilies(catalog: readonly AcpCatalogModel[] = []): DevinFamily[] {
  const found = new Map<string, { name: string; efforts: Set<AcpEffort> }>()
  for (const model of catalog) {
    if (!isAcpModel(model.id)) continue
    const match = EFFORT_SUFFIX.exec(model.id)
    const id = match?.[1] ?? model.id
    const effort = match?.[2] as AcpEffort | undefined
    const entry = found.get(id) ?? { name: (match ? model.family : model.name) || id, efforts: new Set<AcpEffort>() }
    if (effort) entry.efforts.add(effort)
    found.set(id, entry)
  }
  const ordered = (efforts: Set<AcpEffort>) => ACP_EFFORT_ORDER.filter((effort) => efforts.has(effort))
  const curated = DEVIN_FAMILIES.map((family) => {
    const live = found.get(family.id)
    return live && live.efforts.size > 0 ? { ...family, efforts: ordered(live.efforts) } : family
  })
  const extra = [...found.entries()]
    .filter(([id]) => !DEVIN_FAMILIES.some((family) => family.id === id))
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      blurb: 'Listed by your Devin CLI.',
      efforts: ordered(entry.efforts),
    }))
  return [...curated, ...extra]
}

/** The step of `levels` nearest `effort`, the higher one on a tie; the
 *  middle step when nothing was asked for. */
function nearestEffort(levels: readonly AcpEffort[], effort: AcpEffort | undefined): AcpEffort | undefined {
  if (levels.length === 0) return undefined
  if (!effort) return levels[Math.floor((levels.length - 1) / 2)]
  const rank = (e: AcpEffort) => ACP_EFFORT_ORDER.indexOf(e)
  const want = rank(effort)
  return [...levels].sort((a, b) => Math.abs(rank(a) - want) - Math.abs(rank(b) - want) || rank(b) - rank(a))[0]
}

/** The `--model` a Devin run gets: a family at the effort step nearest the
 *  pick (`swe-2` + `xhigh` -> `swe-2-max`), a pinned variant id as is, the
 *  CLI's own default as `default` (no flag). */
export function devinModelId(model: string, effort: AcpEffort | undefined, families: readonly DevinFamily[]): string {
  if (model === DEFAULT_ACP_MODEL) return DEFAULT_ACP_MODEL
  const family = families.find((f) => f.id === model)
  if (!family) return model
  const step = nearestEffort(family.efforts, effort)
  return step ? `${family.id}-${step}` : family.id
}

/* ---------------------------------------------------------------- */
/* Grok: models as listed, effort a flag                             */
/* ---------------------------------------------------------------- */

export const GROK_MODELS: readonly RunnerOption[] = [
  { id: 'default', name: 'Grok default', blurb: 'Whatever model your Grok CLI is set to.' },
  { id: 'grok-4.7', name: 'Grok 4.7', blurb: "xAI's latest frontier model." },
  { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', blurb: 'The fast variant, at twice the price.' },
  { id: 'grok-4.6', name: 'Grok 4.6', blurb: 'The previous generation.' },
]

/** The curated Grok menu, then whatever else the desktop's CLI lists. */
export function grokModels(catalog: readonly AcpCatalogModel[] = []): RunnerOption[] {
  const extra = catalog
    .filter((model) => isAcpModel(model.id) && !GROK_MODELS.some((known) => known.id === model.id))
    .map((model) => ({ id: model.id, name: model.name || model.id, blurb: 'Listed by your Grok CLI.' }))
  return [...GROK_MODELS, ...extra]
}

/* ---------------------------------------------------------------- */
/* the menus, and what a pick runs as                                */
/* ---------------------------------------------------------------- */

export interface AcpMenu {
  models: RunnerOption[]
  efforts: RunnerOption[]
}

/** The menu each agent's pickers show: the curated entries flagged as the
 *  recommendations, what the CLI lists beyond them folded under Older. */
export function acpMenu(agent: AcpAgent, catalog: readonly AcpCatalogModel[] = []): AcpMenu {
  const recommended =
    (ids: readonly { id: string }[]) =>
    (model: RunnerOption): RunnerOption =>
      ids.some((known) => known.id === model.id) ? { ...model, recommended: true } : model
  if (agent === 'grok')
    return { models: grokModels(catalog).map(recommended(GROK_MODELS)), efforts: effortOptions(GROK_EFFORTS) }
  const families = devinFamilies(catalog)
  return {
    models: families.map(({ id, name, blurb }) => ({ id, name, blurb })).map(recommended(DEVIN_FAMILIES)),
    /* the dial covers every step some family has; each run snaps to its own */
    efforts: effortOptions(ACP_EFFORT_ORDER.filter((e) => families.some((f) => f.efforts.includes(e)))),
  }
}

/** What one run hands the desktop: the CLI's `--model` (`default` for
 *  none) and, for Grok, its `--reasoning-effort`. */
export function acpRunArgs(
  agent: AcpAgent,
  model: string,
  effort: AcpEffort | undefined,
  catalog: readonly AcpCatalogModel[] = [],
): { model: string; effort?: AcpEffort } {
  if (agent === 'devin') return { model: devinModelId(model, effort, devinFamilies(catalog)) }
  return { model, ...(effort && isAcpEffort('grok', effort) ? { effort } : {}) }
}
