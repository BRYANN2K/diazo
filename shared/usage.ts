import { z } from 'zod'

/**
 * What one model call (or one harness run, for the Claude and Gemini CLIs)
 * consumed, in the one shape every transport reports. Input is split the way
 * providers bill it: fresh input, cache reads and cache writes are priced
 * apart, so `inputTokens` never includes the cached part.
 */
export interface TokenUsage {
  /** the model id the provider says it ran, or the one that was asked for */
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** the provider's own figure (OpenRouter, the Claude CLI): wins over the
   *  price table, which only estimates */
  costUsd?: number
}

const count = z.number().int().nonnegative().max(1e12)

/** The wire shape a desktop or worker sends back; also the db's json column. */
export const tokenUsageSchema = z.object({
  model: z.string().min(1).max(200),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: z.number().nonnegative().max(1e6).optional(),
})

export const tokenUsageListSchema = z.array(tokenUsageSchema).max(50)

/** A non-negative integer out of whatever a provider put in the field. */
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function usage(model: string, parts: Omit<TokenUsage, 'model' | 'costUsd'>, costUsd?: number): TokenUsage {
  return { model, ...parts, ...(costUsd !== undefined ? { costUsd } : {}) }
}

/** Anthropic Messages `usage`: input already excludes the cached parts. */
export function fromAnthropicUsage(model: string, raw: unknown): TokenUsage {
  const u = record(raw)
  return usage(model, {
    inputTokens: tokens(u.input_tokens),
    outputTokens: tokens(u.output_tokens),
    cacheReadTokens: tokens(u.cache_read_input_tokens),
    cacheWriteTokens: tokens(u.cache_creation_input_tokens),
  })
}

/** OpenAI Responses `usage`: input_tokens includes the cached tokens. */
export function fromResponsesUsage(model: string, raw: unknown): TokenUsage {
  const u = record(raw)
  const cached = tokens(record(u.input_tokens_details).cached_tokens)
  return usage(model, {
    inputTokens: Math.max(0, tokens(u.input_tokens) - cached),
    outputTokens: tokens(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  })
}

/** Chat Completions `usage`: prompt_tokens includes the cached tokens, which
 *  OpenAI-style hosts report in prompt_tokens_details and DeepSeek as
 *  prompt_cache_hit_tokens. OpenRouter adds its billed `cost`. */
export function fromChatCompletionsUsage(model: string, raw: unknown): TokenUsage {
  const u = record(raw)
  const cached = tokens(record(u.prompt_tokens_details).cached_tokens) || tokens(u.prompt_cache_hit_tokens)
  return usage(
    model,
    {
      inputTokens: Math.max(0, tokens(u.prompt_tokens) - cached),
      outputTokens: tokens(u.completion_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    money(u.cost),
  )
}

/**
 * The Claude CLI's final `result` event: `modelUsage` per model with its
 * own cost, or, from an older CLI, one `usage` block and `total_cost_usd`.
 */
export function fromClaudeCliResult(raw: unknown, fallbackModel: string): TokenUsage[] {
  const event = record(raw)
  const perModel = Object.entries(record(event.modelUsage))
  if (perModel.length > 0) {
    return perModel.map(([model, value]) => {
      const u = record(value)
      return usage(
        model,
        {
          inputTokens: tokens(u.inputTokens),
          outputTokens: tokens(u.outputTokens),
          cacheReadTokens: tokens(u.cacheReadInputTokens),
          cacheWriteTokens: tokens(u.cacheCreationInputTokens),
        },
        money(u.costUSD),
      )
    })
  }
  if (!event.usage) return []
  const single = fromAnthropicUsage(fallbackModel, event.usage)
  const cost = money(event.total_cost_usd)
  return [cost !== undefined ? { ...single, costUsd: cost } : single]
}

/** The Gemini CLI's `--output-format json` stats: per model, prompt counts
 *  the cached tokens and thoughts are billed as output. */
export function fromGeminiCliStats(raw: unknown): TokenUsage[] {
  return Object.entries(record(record(raw).models)).map(([model, value]) => {
    const t = record(record(value).tokens)
    const cached = tokens(t.cached)
    return usage(model, {
      inputTokens: Math.max(0, tokens(t.prompt) - cached),
      outputTokens: tokens(t.candidates) + tokens(t.thoughts),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    })
  })
}

/** Fold one call's usage into a run's per-model totals. */
export function addUsage(totals: TokenUsage[], next: TokenUsage): TokenUsage[] {
  const at = totals.findIndex((u) => u.model === next.model)
  if (at < 0) return [...totals, next]
  const prev = totals[at]!
  const costUsd =
    prev.costUsd !== undefined || next.costUsd !== undefined ? (prev.costUsd ?? 0) + (next.costUsd ?? 0) : undefined
  const merged = usage(
    prev.model,
    {
      inputTokens: prev.inputTokens + next.inputTokens,
      outputTokens: prev.outputTokens + next.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + next.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + next.cacheWriteTokens,
    },
    costUsd,
  )
  return totals.map((u, i) => (i === at ? merged : u))
}
