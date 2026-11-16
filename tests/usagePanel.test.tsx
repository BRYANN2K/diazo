// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { summarizeUsage, type AgentRunRecord } from '../shared/agentRuns'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { api } = await import('../src/lib/api')
const { UsagePanel } = await import('../src/components/UsagePanel')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const run: AgentRunRecord = {
  id: 'r1',
  canvasId: 'c1',
  kind: 'design',
  agent: 'Doop',
  label: 'Claude API (claude-sonnet-4-6)',
  provider: 'anthropic-key',
  models: [
    { model: 'claude-sonnet-4-6', inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ],
  inputTokens: 12_000,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.048,
  costEstimated: true,
  outcome: 'done',
  startedAt: Date.now() - 65_000,
  endedAt: Date.now() - 5_000,
}

it('shows the canvas total, the per-model line and each run', async () => {
  vi.spyOn(api, 'getUsage').mockResolvedValue(summarizeUsage([run]))
  await act(async () => root.render(<UsagePanel canvasId="c1" />))
  const text = container.textContent ?? ''
  expect(api.getUsage).toHaveBeenCalledWith('c1')
  expect(text).toContain('Total cost $0.048')
  expect(text).toContain('estimated from list prices')
  expect(text).toContain('claude-sonnet-4-6')
  expect(text).toContain('12k in · 800 out')
  expect(text).toContain('Claude API (claude-sonnet-4-6)')
  expect(text).toContain('1m 0s')
})

it('says so when no run has been metered yet', async () => {
  vi.spyOn(api, 'getUsage').mockResolvedValue(summarizeUsage([]))
  await act(async () => root.render(<UsagePanel canvasId="c1" />))
  expect(container.textContent).toContain('No agent runs on this canvas yet')
})

it('names every provider’s models as the menus do, not only Claude’s', async () => {
  const gpt: AgentRunRecord = {
    ...run,
    id: 'r2',
    label: 'OpenAI run',
    provider: 'openai-key',
    models: [{ model: 'gpt-6.1-sol', inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  }
  const kimi: AgentRunRecord = {
    ...run,
    id: 'r3',
    label: 'OpenRouter run',
    provider: 'openrouter-key',
    models: [
      { model: 'moonshotai/kimi-k3', inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
  }
  const custom: AgentRunRecord = {
    ...run,
    id: 'r4',
    label: 'Custom run',
    provider: 'custom:abc',
    models: [{ model: 'my-local-llm', inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  }
  vi.spyOn(api, 'getUsage').mockResolvedValue(summarizeUsage([run, gpt, kimi, custom]))
  await act(async () => root.render(<UsagePanel canvasId="c1" />))
  const text = container.textContent ?? ''
  expect(text).toContain('Sonnet 4.6')
  expect(text).toContain('GPT-6.1 Sol')
  expect(text).toContain('Kimi K3')
  expect(text).toContain('my-local-llm')
  expect(text).not.toContain('gpt-6.1-sol')
})
