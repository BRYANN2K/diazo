// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunner, AgentRunners } from '../shared/agentRunner.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), models: vi.fn(), capture: vi.fn(), acp: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { agentRunners: mocks.runners, agentModels: mocks.models, acpAgent: mocks.acp },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
import { ModelPicker } from '../src/components/ModelPicker'
import { duelChoices } from '../src/components/DuelDialog'
import { currentRunnerPick, useRunnerPick } from '../src/lib/runnerPick'
import { acpResult, desktopAcpAgents, refreshAcpAgent, useAcpAgents } from '../src/lib/acpAgent'
import { acpMenu } from '../shared/acpAgent.ts'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* the runners as listRunners serves them for the two desktop agents */
const grok: AgentRunner = {
  provider: 'grok-local',
  name: 'Grok (desktop)',
  online: true,
  model: 'grok-4.7',
  effort: 'high',
  ...acpMenu('grok'),
}
const devin: AgentRunner = {
  provider: 'devin-local',
  name: 'Devin (desktop)',
  online: true,
  model: 'swe-2',
  ...acpMenu('devin'),
}
const runners: AgentRunners = { runners: [grok, devin], default: 'grok-local' }

let root: Root
let container: HTMLDivElement
const buttons = () => [...container.querySelectorAll('button')]
/* two pills: the model, then the effort */
const trigger = () => buttons()[0]!
const effortButton = () => buttons()[1]
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith(label))

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useRunnerPick.setState({ stored: null, runners: null })
  mocks.runners.mockResolvedValue(runners)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as { __DOOP_ACP_AGENTS__?: unknown }).__DOOP_ACP_AGENTS__
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
})

describe('the desktop agents in the composer and the duel', () => {
  it('offers both agents with their models, and asks no provider catalog for them', async () => {
    await act(async () => root.render(<ModelPicker />))
    await act(async () => {})
    expect(trigger().textContent).toBe('Grok 4.7')
    expect(effortButton()?.textContent).toBe('High')
    expect(currentRunnerPick()).toEqual({ provider: 'grok-local', model: 'grok-4.7', effort: 'high' })
    act(() => {
      trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Grok (desktop)')
    expect(text).toContain('Devin (desktop)')
    expect(radio('SWE-2 Flash')).toBeTruthy()
    expect(mocks.models).not.toHaveBeenCalled()
  })
  it('makes every model a duel contestant, leaving out each CLI’s own default', () => {
    const choices = duelChoices(runners)
    const keys = choices.map((c) => c.key)
    expect(keys).toContain('grok-local|grok-4.7')
    expect(keys).toContain('devin-local|swe-2')
    expect(keys).not.toContain('grok-local|default')
    expect(keys).not.toContain('devin-local|default')
    expect(choices.find((c) => c.key === 'grok-local|grok-4.7')).toMatchObject({
      pick: { provider: 'grok-local', model: 'grok-4.7', effort: 'high' },
      label: 'Grok (desktop) · Grok 4.7',
    })
    expect(choices.find((c) => c.key === 'devin-local|swe-2')?.efforts?.map((e) => e.id)).toContain('max')
  })
})

describe('the page bridge', () => {
  it('reads the agents the shell advertises, keeping only known ones', () => {
    expect(desktopAcpAgents()).toEqual([])
    ;(globalThis as { __DOOP_ACP_AGENTS__?: unknown }).__DOOP_ACP_AGENTS__ = ['devin', 'grok', 'evil']
    expect(desktopAcpAgents()).toEqual(['devin', 'grok'])
  })
  it('keeps whichever side of a status answered when the other fails', async () => {
    ;(globalThis as { __DOOP_ACP_AGENTS__?: unknown }).__DOOP_ACP_AGENTS__ = ['devin']
    const invoke = vi.fn()
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn() } }
    /* the shell refuses: the account's saved preference still lands */
    invoke.mockRejectedValue(new Error('acp_status is not allowed'))
    mocks.acp.mockResolvedValue({ enabled: false, model: 'swe-2' })
    await expect(refreshAcpAgent('alice', 'devin')).rejects.toThrow('acp_status is not allowed')
    expect(useAcpAgents.getState().devin.preference?.model).toBe('swe-2')
    expect(useAcpAgents.getState().devin.native).toBeNull()
    /* the server is down: the shell's status still lands */
    const native = { installed: true, connected: true, enabled: false, cliVersion: '3000.12.57' }
    invoke.mockResolvedValue(native)
    mocks.acp.mockRejectedValue(new Error('Server unreachable'))
    await expect(refreshAcpAgent('alice', 'devin')).rejects.toThrow('Server unreachable')
    expect(useAcpAgents.getState().devin.native).toEqual(native)
  })
  it('turns a run into the result the server records', () => {
    expect(
      acpResult(
        { success: true, text: 'Made it', acpUsage: { usage: { inputTokens: 10, outputTokens: 2 }, cost: null } },
        'grok-4.7',
      ),
    ).toEqual({
      success: true,
      text: 'Made it',
      usage: [{ model: 'grok-4.7', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    })
    expect(acpResult({ success: false, text: 'x'.repeat(200_000) }, 'swe-2-high').text).toHaveLength(100_000)
  })
})
