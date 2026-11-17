import type { TokenUsage } from './usage.ts'

/**
 * List prices per million tokens, used to estimate a run's cost when the
 * provider did not report one itself (OpenRouter and the Claude CLI do; their
 * figure always wins). Edit this table when a provider changes its prices:
 * a model missing from it shows its tokens with an unknown cost, never a
 * made-up one.
 *
 * Matching is by prefix on the id the provider returned, longest first, so
 * a dated snapshot (`claude-haiku-4-5-20251001`) or a provider route
 * (`anthropic/claude-sonnet-4-6`) finds its family.
 */
export interface ModelPrice {
  /** USD per 1M fresh input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache-read tokens; 10% of input when unset */
  cacheRead?: number
  /** USD per 1M cache-write tokens; 125% of input when unset */
  cacheWrite?: number
}

/** Anthropic first-party rates, 2026-11. */
const ANTHROPIC: Record<string, ModelPrice> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** OpenAI and Google list rates; cached input as the providers bill it. */
const OTHERS: Record<string, ModelPrice> = {
  'gpt-5.6-terra': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = { ...ANTHROPIC, ...OTHERS }

const BY_LENGTH = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length)

/** The price row for a model id, or undefined when the table has none. */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.toLowerCase().replace(/^[a-z0-9-]+\//, '')
  const key = BY_LENGTH.find((prefix) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`))
  return key ? MODEL_PRICES[key] : undefined
}

export interface PricedUsage {
  /** undefined = no provider figure and no price row */
  costUsd?: number
  /** true = computed from the table, not reported by the provider */
  estimated: boolean
}

/** One model's cost: the provider's figure, else the table's estimate. */
export function priceUsage(usage: TokenUsage): PricedUsage {
  if (usage.costUsd !== undefined) return { costUsd: usage.costUsd, estimated: false }
  const price = priceFor(usage.model)
  if (!price) return { estimated: false }
  const perToken = (rate: number, tokens: number) => (rate * tokens) / 1_000_000
  const costUsd =
    perToken(price.input, usage.inputTokens) +
    perToken(price.output, usage.outputTokens) +
    perToken(price.cacheRead ?? price.input * 0.1, usage.cacheReadTokens) +
    perToken(price.cacheWrite ?? price.input * 1.25, usage.cacheWriteTokens)
  return { costUsd, estimated: true }
}

/** A run's cost over all its models. Unknown when any model is unpriced:
 *  a partial sum would read as the whole bill. */
export function priceRun(models: readonly TokenUsage[]): PricedUsage {
  let total = 0
  let estimated = false
  for (const usage of models) {
    const priced = priceUsage(usage)
    if (priced.costUsd === undefined) return { estimated: false }
    total += priced.costUsd
    estimated ||= priced.estimated
  }
  return models.length > 0 ? { costUsd: total, estimated } : { estimated: false }
}
