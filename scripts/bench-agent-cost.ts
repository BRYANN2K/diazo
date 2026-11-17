/**
 * bench:agent-cost — replays the agent-cost reference jobs against a stub
 * model from recorded transcripts and prices each run.
 *
 * A transcript (bench/transcripts/<job>.<mode>.json) is the assistant side of
 * a run: one entry per model turn with the text it wrote and the tool calls
 * it made. Every current transcript is hand-written — `"estimate":
 * "hand-written"` marks it, and this script prints its costs as estimates.
 * Replaying never calls a provider — the stub pops the next recorded turn,
 * the harness feeds the recorded tool results back, and token counts are
 * estimated at ~4 characters per token over the exact text the conversation
 * carries. Caching (AC-3) is simulated as the billing works: turn one pays
 * input price on the prefix, every later turn reads everything before its
 * newest message back at the model's cached-input rate.
 *
 *   bun run bench:agent-cost            # all jobs, both modes
 *   bun run bench:agent-cost landing    # one job
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { priceUsage } from '../shared/modelPrices.ts'
import type { TokenUsage } from '../shared/usage.ts'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const TRANSCRIPTS = path.join(HERE, '..', 'bench', 'transcripts')
const CHARS_PER_TOKEN = 4

export interface TranscriptTurn {
  /** the assistant's reply this turn: reasoning text plus tool_use blocks */
  assistant: string
  calls?: { name: string; input?: unknown; result: string }[]
}

export interface Transcript {
  job: string
  mode: 'tools' | 'script'
  /** priced with shared/modelPrices.ts */
  model: string
  /** 'hand-written' marks a transcript written by hand, not recorded from a
   *  provider run — its costs are estimates, never quoted as measured runs */
  estimate?: 'hand-written' | 'recorded'
  /** system block texts, joined in order */
  system: string[]
  /** rough size of the tool definitions the provider saw, in characters */
  toolsChars: number
  turns: TranscriptTurn[]
}

const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

export interface TurnCost {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** Replays one transcript into per-turn token counts. */
export function replay(t: Transcript): { turns: TurnCost[]; toolCalls: number } {
  const systemChars = t.system.join('\n').length + t.toolsChars
  const turns: TurnCost[] = []
  /* the conversation the model sees at each turn, as text */
  let conversationChars = systemChars
  let previousInput = 0
  let toolCalls = 0
  for (const turn of t.turns) {
    const assistant = turn.assistant
    const results = (turn.calls ?? []).map((c) => c.result).join('\n')
    toolCalls += turn.calls?.length ?? 0
    /* turn N's input is everything carried so far plus the newest message;
       with caching, everything but that newest message is a cache read —
       turn one has nothing to read and writes the whole prefix instead */
    const inputTokens = Math.ceil(conversationChars / CHARS_PER_TOKEN) + Math.ceil(results.length / CHARS_PER_TOKEN)
    const isFirst = turns.length === 0
    turns.push({
      input: isFirst ? inputTokens : Math.max(0, inputTokens - previousInput),
      cacheRead: isFirst ? 0 : previousInput,
      cacheWrite: isFirst ? inputTokens : 0,
      output: tokens(assistant),
    })
    previousInput = inputTokens
    /* the conversation grows by what the model wrote plus the tool results
       the client appended before the next turn */
    conversationChars += assistant.length + results.length
  }
  return { turns, toolCalls }
}

function money(usd: number | undefined): string {
  return usd === undefined ? '  n/a ' : `$${usd.toFixed(4)}`
}

export function report(t: Transcript): {
  usage: TokenUsage
  turns: number
  toolCalls: number
  cost?: number
} {
  const { turns, toolCalls } = replay(t)
  const usage: TokenUsage = {
    model: t.model,
    inputTokens: turns.reduce((s, x) => s + x.input, 0),
    cacheReadTokens: turns.reduce((s, x) => s + x.cacheRead, 0),
    cacheWriteTokens: turns.reduce((s, x) => s + x.cacheWrite, 0),
    outputTokens: turns.reduce((s, x) => s + x.output, 0),
  }
  return { usage, turns: turns.length, toolCalls, cost: priceUsage(usage).costUsd }
}

const filter = process.argv[2]
const files = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => !filter || f.startsWith(`${filter}.`))
  .sort()

if (files.length === 0) {
  console.error(`no transcripts under ${TRANSCRIPTS}${filter ? ` matching ${filter}.*` : ''}`)
  process.exit(1)
}

console.log('job          mode    turns  calls   input  cache-read cache-write  output      cost')
console.log('─'.repeat(88))
const byJob = new Map<string, { mode: string; r: ReturnType<typeof report> }[]>()
let handWritten = 0
for (const file of files) {
  const t = JSON.parse(readFileSync(path.join(TRANSCRIPTS, file), 'utf8')) as Transcript
  if (t.estimate === 'hand-written') handWritten++
  const r = report(t)
  const row = [
    t.job.padEnd(12),
    t.mode.padEnd(7),
    String(r.turns).padStart(5),
    String(r.toolCalls).padStart(6),
    String(r.usage.inputTokens).padStart(7),
    String(r.usage.cacheReadTokens).padStart(11),
    String(r.usage.cacheWriteTokens).padStart(12),
    String(r.usage.outputTokens).padStart(7),
    money(r.cost).padStart(10),
  ].join(' ')
  console.log(row)
  const list = byJob.get(t.job) ?? []
  list.push({ mode: t.mode, r })
  byJob.set(t.job, list)
}
console.log('─'.repeat(88))
if (handWritten)
  console.log(
    `${handWritten} of ${files.length} transcripts are hand-written — costs are estimates at ~4 chars/token, not measured runs`,
  )
for (const [job, runs] of byJob) {
  const tools = runs.find((r) => r.mode === 'tools')?.r
  const script = runs.find((r) => r.mode === 'script')?.r
  if (!tools || !script || tools.cost === undefined || script.cost === undefined) continue
  const saved = tools.cost - script.cost
  const tag = handWritten ? ' estimated' : ''
  console.log(
    `${job}: script saves${tag} ${money(saved).trim()} of ${money(tools.cost).trim()} (${Math.round((saved / tools.cost) * 100)}%), ` +
      `${tools.turns} -> ${script.turns} turns`,
  )
}
