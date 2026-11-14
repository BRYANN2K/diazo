import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runAnthropicTurn } from '../server/agentModel.ts'
import { _internal as responses, runOpenAiTurn } from '../server/openaiAgent.ts'
import {
  deepseekConfig,
  geminiConfig,
  openrouterConfig,
  runChatCompletionsTurn,
} from '../server/chatCompletionsAgent.ts'
import { runGeminiCli } from '../server/geminiCloudWorker.ts'
import { addUsage, fromClaudeCliResult, fromGeminiCliStats, tokenUsageListSchema } from '../shared/usage.ts'

/**
 * The usage meter reads `usage` off every model transport. Each provider
 * reports it in its own shape (cached input inside or outside the input
 * count, a billed cost or none), so each transport is pinned on its own: a
 * silent zero here is a run that looks free.
 */

const turn = {
  system: 'sys',
  tools: [],
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 1000,
}

afterEach(() => vi.restoreAllMocks())

describe('Anthropic transport', () => {
  const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  let server: http.Server
  let client: Anthropic

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const message = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
        }
        res.write(sse({ type: 'message_start', message }))
        res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
        res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }))
        res.write(sse({ type: 'content_block_stop', index: 0 }))
        res.write(
          sse({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 33 },
          }),
        )
        res.write(sse({ type: 'message_stop' }))
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
  })
  afterAll(() => server.close())

  it('reports fresh input, output and both cache counts under the model that ran', async () => {
    const result = await runAnthropicTurn(client, 'claude-sonnet-4-5', {
      ...turn,
      system: [{ text: 'sys', cache: true }],
    })
    expect(result.usage).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 33,
      cacheReadTokens: 900,
      cacheWriteTokens: 40,
    })
  })
})

describe('OpenAI Responses transport', () => {
  const account = { userId: 'u', kind: 'openai-key' as const, apiKey: 'sk-test', enabled: true, connectedAt: 0 }

  it('splits cached tokens out of the input count on an API-key turn', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'gpt-5.1-2025-11-13',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 50 },
        }),
        { status: 200 },
      ),
    )
    const result = await runOpenAiTurn(account, turn)
    expect(result.usage).toEqual({
      model: 'gpt-5.1-2025-11-13',
      inputTokens: 400,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    })
  })

  it('reads usage off the ChatGPT stream’s bookkeeping-only completed event', async () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } },
    ]
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')
    const final = await responses.readEventStream(new Response(body))
    expect(responses.fromResponse(final, 'gpt-5').usage).toEqual({
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('reports nothing rather than zeros when the provider sent no usage', () => {
    const result = responses.fromResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    })
    expect(result.usage).toBeUndefined()
  })
})

describe('Chat Completions transport', () => {
  function answer(body: Record<string, unknown>) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], ...body }), { status: 200 }),
      )
  }

  it('keeps OpenRouter’s billed cost and asks for its usage accounting', async () => {
    const fetchSpy = answer({
      model: 'moonshotai/kimi-k2.6',
      usage: { prompt_tokens: 500, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.0042 },
    })
    const result = await runChatCompletionsTurn(openrouterConfig('sk-or', 'moonshotai/kimi-k2.6', true), turn)
    expect(result.usage).toEqual({
      model: 'moonshotai/kimi-k2.6',
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      costUsd: 0.0042,
    })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(sent.usage).toEqual({ include: true })
  })

  it('reads DeepSeek’s cache-hit field and never sends the OpenRouter-only flag elsewhere', async () => {
    const fetchSpy = answer({ usage: { prompt_tokens: 300, completion_tokens: 20, prompt_cache_hit_tokens: 200 } })
    const result = await runChatCompletionsTurn(deepseekConfig('key', 'deepseek-chat', false), turn)
    expect(result.usage).toMatchObject({ model: 'deepseek-chat', inputTokens: 100, cacheReadTokens: 200 })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(sent.usage).toBeUndefined()
  })

  it('meters a Gemini API key, which rides this transport, under the requested model', async () => {
    answer({ usage: { prompt_tokens: 70, completion_tokens: 9 } })
    const result = await runChatCompletionsTurn(geminiConfig('key', 'gemini-2.5-pro', true), turn)
    expect(result.usage).toEqual({
      model: 'gemini-2.5-pro',
      inputTokens: 70,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

describe('Claude CLI transport', () => {
  it('reads per-model usage and the CLI’s own cost from the result event', () => {
    const usage = fromClaudeCliResult(
      {
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 40,
            outputTokens: 900,
            cacheReadInputTokens: 12000,
            cacheCreationInputTokens: 3000,
            costUSD: 0.21,
          },
          'claude-haiku-4-5': { inputTokens: 5, outputTokens: 7, costUSD: 0.001 },
        },
        usage: { input_tokens: 45 },
        total_cost_usd: 0.211,
      },
      'sonnet',
    )
    expect(usage).toEqual([
      {
        model: 'claude-sonnet-4-5',
        inputTokens: 40,
        outputTokens: 900,
        cacheReadTokens: 12000,
        cacheWriteTokens: 3000,
        costUsd: 0.21,
      },
      {
        model: 'claude-haiku-4-5',
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
    ])
    expect(tokenUsageListSchema.safeParse(usage).success).toBe(true)
  })

  it('falls back to the single usage block of an older CLI, under the alias it ran', () => {
    expect(fromClaudeCliResult({ usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.5 }, 'opus')).toEqual([
      { model: 'opus', inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
    ])
    expect(fromClaudeCliResult(undefined, 'opus')).toEqual([])
  })
})

describe('Gemini CLI transport', () => {
  const job = {
    id: '1b088126-e936-4339-8c2a-e0593b629865',
    token: 'a'.repeat(64),
    prompt: 'Make a card',
    system: 'Use Doop tools',
    maxTurns: 4,
  }
  const directories: string[] = []
  afterAll(() => Promise.all(directories.map((d) => rm(d, { recursive: true, force: true }))))

  it('returns the CLI’s per-model token stats with the result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemini-usage-'))
    directories.push(directory)
    const script = join(directory, 'cli.cjs')
    const stats = {
      models: {
        'gemini-2.5-pro': { tokens: { prompt: 2000, candidates: 300, cached: 500, thoughts: 100, total: 2400 } },
      },
      tools: { totalCalls: 3 },
    }
    await writeFile(
      script,
      `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ response: 'done', stats: ${JSON.stringify(stats)} })))`,
    )
    const result = await runGeminiCli(job, 'https://doop.example', new AbortController().signal, {
      executable: process.execPath,
      args: [script],
    })
    expect(result).toEqual({
      success: true,
      text: 'done',
      usage: [
        { model: 'gemini-2.5-pro', inputTokens: 1500, outputTokens: 400, cacheReadTokens: 500, cacheWriteTokens: 0 },
      ],
    })
  })

  it('reads nothing out of stats that have no models', () => {
    expect(fromGeminiCliStats({ tools: {} })).toEqual([])
    expect(fromGeminiCliStats(undefined)).toEqual([])
  })
})

describe('addUsage', () => {
  it('sums a run per model and keeps a provider cost only where one was reported', () => {
    const a = { model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    let totals = addUsage([], a)
    totals = addUsage(totals, a)
    totals = addUsage(totals, { ...a, model: 'n', costUsd: 0.1 })
    expect(totals).toEqual([
      { model: 'm', inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 },
      { ...a, model: 'n', costUsd: 0.1 },
    ])
  })
})
