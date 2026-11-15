// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), startDuel: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { agentRunners: mocks.runners, startDuel: mocks.startDuel },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
import { DuelDialog, duelChoices } from '../src/components/DuelDialog'
import { useRunnerPick } from '../src/lib/runnerPick'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  efforts: [
    { id: 'low', name: 'Low', blurb: '' },
    { id: 'medium', name: 'Medium', blurb: '' },
    { id: 'high', name: 'High', blurb: '' },
    { id: 'xhigh', name: 'Extra high', blurb: '' },
    { id: 'max', name: 'Max', blurb: '' },
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
/* an API key with no effort dial */
const claudeKey = {
  provider: 'anthropic-key' as const,
  name: 'Claude API',
  model: 'claude-sonnet-5',
  models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', blurb: '' }],
}
const runners: AgentRunners = { runners: [plan, chatgpt, claudeKey], default: 'chatgpt' }

let root: Root
let container: HTMLDivElement
const settle = () => act(async () => {})

beforeEach(() => {
  vi.resetAllMocks()
  useRunnerPick.setState({ stored: null, runners: null })
  mocks.runners.mockResolvedValue(runners)
  mocks.startDuel.mockResolvedValue({})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const dialog = () => document.querySelector('[role="dialog"]')!
const check = (label: string) =>
  act(() => {
    const row = [...dialog().querySelectorAll('label')].find((el) => el.textContent === label)!
    row.querySelector('input')!.click()
  })
const slider = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="Reasoning effort for ${label}"]`)
/* React's controlled input needs the native setter for a scripted drag */
const dragTo = (input: HTMLInputElement, step: number) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(step))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
const button = (text: string) => [...dialog().querySelectorAll('button')].find((el) => el.textContent === text)!

describe('duelChoices', () => {
  it('offers each connected runner’s models, none of them meta entries', () => {
    const choices = duelChoices({ runners: [plan, chatgpt], default: 'chatgpt' })
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

describe('the duel dialog', () => {
  it('gives each checked contestant its own effort dial, none to a connection without one', async () => {
    await act(async () =>
      root.render(<DuelDialog canvasId="c1" brief="A pricing hero" onClose={() => {}} onStarted={() => {}} />),
    )
    await settle()
    expect(dialog().textContent).not.toContain('Claude Code default')
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0)
    check('Claude Plan · Opus')
    check('ChatGPT · GPT-5.6 Terra')
    check('Claude API · Claude Sonnet 5')
    /* the two connections with an effort dial show one, the key does not */
    expect(slider('Claude Plan · Opus')).toBeTruthy()
    expect(slider('ChatGPT · GPT-5.6 Terra')).toBeTruthy()
    expect(slider('Claude API · Claude Sonnet 5')).toBeNull()
  })

  it('sends each contestant’s pick with the effort its dial was left on', async () => {
    const onClose = vi.fn()
    const onStarted = vi.fn()
    await act(async () =>
      root.render(<DuelDialog canvasId="c1" brief="A pricing hero" onClose={onClose} onStarted={onStarted} />),
    )
    await settle()
    check('Claude Plan · Opus')
    check('ChatGPT · GPT-5.6 Terra')
    /* the Plan carries no configured effort until its dial moves to Max;
       the ChatGPT account's medium is overridden to Extra high */
    await dragTo(slider('Claude Plan · Opus')!, 4)
    await dragTo(slider('ChatGPT · GPT-5.6 Terra')!, 3)
    await act(async () => button('Start with 2 models').click())
    expect(mocks.startDuel).toHaveBeenCalledWith(
      'c1',
      'A pricing hero',
      [
        { provider: 'claude-local', model: 'opus', effort: 'max' },
        { provider: 'chatgpt', model: 'gpt-5.6-terra', effort: 'xhigh' },
      ],
      undefined,
    )
    expect(onStarted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the connection’s configured effort when the dial is not touched', async () => {
    await act(async () =>
      root.render(<DuelDialog canvasId="c1" brief="A hero" onClose={() => {}} onStarted={() => {}} />),
    )
    await settle()
    check('ChatGPT · GPT-6 Astra')
    check('ChatGPT · GPT-6.1 Sol')
    await act(async () => button('Start with 2 models').click())
    expect(mocks.startDuel).toHaveBeenCalledWith(
      'c1',
      'A hero',
      [
        { provider: 'chatgpt', model: 'gpt-6-astra', effort: 'medium' },
        { provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'medium' },
      ],
      undefined,
    )
  })
})
