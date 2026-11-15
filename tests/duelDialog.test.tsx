// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
const mocks = vi.hoisted(() => ({ startDuel: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { agentRunners: vi.fn().mockResolvedValue({ runners: [] }), startDuel: mocks.startDuel },
  errorMessage: (err: unknown, fallback: string) => fallback,
}))
import { duelChoices } from '../src/components/DuelDialog'

const plan = {
  provider: 'claude-local' as const,
  name: 'Claude Plan',
  online: true,
  model: 'sonnet',
  models: [
    { id: 'fable', name: 'Fable', blurb: 'the newest Fable' },
    { id: 'opus', name: 'Opus', blurb: 'the newest Opus' },
    { id: 'sonnet', name: 'Sonnet', blurb: 'the newest Sonnet' },
    { id: 'haiku', name: 'Haiku', blurb: 'the newest Haiku' },
    { id: 'default', name: 'Claude Code default', blurb: 'whatever the CLI is set to' },
  ],
}
const chatgpt = {
  provider: 'chatgpt' as const,
  name: 'ChatGPT',
  email: 'alice@example.com',
  model: 'gpt-5.6-terra',
  effort: 'medium',
  models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', blurb: '' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: '' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', blurb: '' },
  ],
  efforts: [
    { id: 'low', name: 'Low', blurb: '' },
    { id: 'medium', name: 'Medium', blurb: '' },
    { id: 'high', name: 'High', blurb: '' },
    { id: 'xhigh', name: 'Extra high', blurb: '' },
  ],
}

describe('duelChoices', () => {
  it('offers each connected runner’s models, none of them meta entries', () => {
    const runners: AgentRunners = { runners: [plan, chatgpt], default: 'chatgpt' }
    const choices = duelChoices(runners)
    expect(choices.map((c) => c.pick.model)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'gpt-6-astra',
      'gpt-5.6-terra',
      'gpt-6.1-sol',
    ])
    /* "Claude Code default" is whatever the CLI is set to — not a model
       that could answer a brief differently from the alias beside it */
    expect(choices.some((c) => c.pick.model === 'default')).toBe(false)
    expect(choices[0]).toMatchObject({ label: 'Claude Plan · Fable' })
    expect(choices[6]).toMatchObject({ label: 'ChatGPT · GPT-6.1 Sol' })
  })
  it('keeps a pinned model id the Plan is set to as a choice', () => {
    const pinned = { ...plan, model: 'claude-fable-5-2' }
    const choices = duelChoices({ runners: [pinned] })
    expect(choices.map((c) => c.pick.model)).toContain('claude-fable-5-2')
    expect(choices.some((c) => c.pick.model === 'default')).toBe(false)
  })
  it('has nothing to offer with no connections, and never throws on a missing list', () => {
    expect(duelChoices(null)).toEqual([])
    expect(duelChoices({ runners: [] })).toEqual([])
  })
})
