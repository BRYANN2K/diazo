import type { TokenUsage } from './usage.ts'

/**
 * The Claude Code run on the user's own desktop. Claude Code has no model
 * list to ask for, but `--model` takes an alias that always resolves to the
 * newest model the installed CLI knows, so the menu is the aliases: it stays
 * current with no network call and no desktop release. A full id can still be
 * typed to pin one. Keep the shape rule in sync with `valid_model` in
 * desktop/src-tauri/src/claude.rs, which checks it again before the id
 * becomes a CLI argument.
 */
export const CLAUDE_MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku'] as const
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number]

/** A pinned model: shaped like an Anthropic model id. */
export const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,98}$/

/** An alias, or a pinned `claude-*` id. */
export type ClaudeModel = string

export const DEFAULT_CLAUDE_MODEL: ClaudeModelAlias = 'sonnet'

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return (
    typeof value === 'string' && (CLAUDE_MODEL_ALIASES.some((alias) => alias === value) || CLAUDE_MODEL_ID.test(value))
  )
}

/** The aliases as the menus name them: "Latest Opus" follows every Opus
 *  release, where a pinned id below stays on one version. */
export const CLAUDE_MODELS: { id: ClaudeModelAlias; name: string; blurb: string }[] = [
  {
    id: 'fable',
    name: 'Latest Fable',
    blurb: 'The newest Fable your Claude Code knows — for the hardest, longest tasks.',
  },
  {
    id: 'opus',
    name: 'Latest Opus',
    blurb: 'The newest Opus — for complex layouts and demanding design or coding work.',
  },
  { id: 'sonnet', name: 'Latest Sonnet', blurb: 'The newest Sonnet — a balanced default for everyday design work.' },
  { id: 'haiku', name: 'Latest Haiku', blurb: 'The newest Haiku — for quick edits and straightforward tasks.' },
  { id: 'default', name: 'Claude Code default', blurb: 'Whatever model your Claude Code is set to.' },
]

/**
 * The pinned models `claude --model` accepts, newest first in each family:
 * the current generation and the earlier ones Anthropic still serves.
 * Checked against the Claude model list (2026-11); the verified-only Mythos
 * models are left out. A release adds a line here; the aliases above reach
 * it on their own meanwhile.
 */
export const CLAUDE_PINNED_MODELS: { id: string; name: string; blurb: string }[] = [
  { id: 'claude-fable-5-2', name: 'Fable 5.2', blurb: 'Anthropic’s most capable model, pinned.' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', blurb: 'The previous Fable, pinned.' },
  { id: 'claude-fable-5', name: 'Fable 5', blurb: 'The first Fable, pinned.' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', blurb: 'The current Opus, pinned.' },
  { id: 'claude-opus-5', name: 'Opus 5', blurb: 'The previous Opus, pinned.' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', blurb: 'An earlier Opus, pinned.' },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', blurb: 'An earlier Opus, pinned.' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', blurb: 'An earlier Opus, pinned.' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', blurb: 'The current Sonnet, pinned.' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', blurb: 'The previous Sonnet, pinned.' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', blurb: 'An earlier Sonnet, pinned.' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', blurb: 'The current Haiku, pinned.' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', blurb: 'The previous Haiku, pinned.' },
]

/** Everything the Plan's menus offer, the aliases first: what the composer,
 *  the duel and Settings list alike. */
export const CLAUDE_PLAN_MODELS: { id: ClaudeModel; name: string; blurb: string }[] = [
  ...CLAUDE_MODELS,
  ...CLAUDE_PINNED_MODELS,
]

export function isClaudeAlias(value: unknown): value is ClaudeModelAlias {
  return CLAUDE_MODEL_ALIASES.some((alias) => alias === value)
}

/** A stored preference as it will run: an alias or pinned id as is, anything
 *  older or unknown on the default. Ids saved before the aliases keep working. */
export function normalizeClaudeModel(model: unknown): ClaudeModel {
  return isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL
}

/** `claude --effort`: how hard it thinks per turn; unset leaves the CLI's own
 *  setting. Mirrored by `valid_effort` in claude.rs. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

export const CLAUDE_EFFORT_OPTIONS: { id: ClaudeEffort; name: string; blurb: string }[] = [
  { id: 'low', name: 'Low', blurb: 'Fastest — fine for small, mechanical edits' },
  { id: 'medium', name: 'Medium', blurb: 'A good everyday setting for design work' },
  { id: 'high', name: 'High', blurb: 'More thinking per turn — for layouts that have to be right' },
  { id: 'xhigh', name: 'Extra high', blurb: 'Deeper still; slower turns' },
  { id: 'max', name: 'Max', blurb: 'All the thinking it can do, and the slowest turns' },
]

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return CLAUDE_EFFORTS.some((effort) => effort === value)
}

export interface LocalAgentPreference {
  enabled: boolean
  model: ClaudeModel
  /** unset = the CLI's own effort setting */
  effort?: ClaudeEffort
}

export interface LocalAgentJob {
  id: string
  token: string
  prompt: string
  system: string
  model: ClaudeModel
  effort?: ClaudeEffort
  maxTurns: number
}

export interface LocalAgentResult {
  success: boolean
  text: string
  /** what the run consumed, per model, for the usage meter */
  usage?: TokenUsage[]
}

/** What the desktop shell's `claude_run` returns: the result, plus the CLI's
 *  raw usage figures from its final event (absent from older shells). */
export interface ClaudeRunOutput extends LocalAgentResult {
  cliUsage?: unknown
}
