// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  select: vi.fn(),
  disconnect: vi.fn(),
  invoke: vi.fn(),
  shell: true,
  agents: ['devin', 'grok'] as string[],
  state: {} as Record<string, unknown>,
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => mocks.shell }))
vi.mock('../src/lib/acpAgent', () => ({
  useAcpAgents: (pick: (all: Record<string, unknown>) => unknown) => pick({ devin: mocks.state, grok: mocks.state }),
  hasAcpAgent: (agent: string) => mocks.agents.includes(agent),
  refreshAcpAgent: mocks.refresh,
  selectAcpAgent: mocks.select,
  disconnectAcpAgent: mocks.disconnect,
  stopAcpAgent: vi.fn(),
  invokeAcp: mocks.invoke,
}))
import { AcpAgentRow } from '../src/components/LocalAcpAgent'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
const idle = { running: false, progress: '', error: '' }
const mount = async (agent: 'devin' | 'grok' = 'grok') => {
  await act(async () => root.render(<AcpAgentRow agent={agent} />))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.shell = true
  mocks.agents = ['devin', 'grok']
  mocks.state = {
    ...idle,
    preference: { enabled: false, model: 'default' },
    native: { installed: true, connected: true, enabled: false, cliVersion: '1.0.77', cliPath: '/u/.local/bin/grok' },
  }
  mocks.refresh.mockResolvedValue({ native: { installed: true, connected: true } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('a desktop agent over ACP in Settings', () => {
  it('offers Connect under its name and turns it on after rechecking the CLI', async () => {
    await mount('grok')
    expect(container.textContent).toContain('Grok (desktop)')
    expect(container.textContent).toContain('Your Grok login, on this computer')
    mocks.refresh.mockClear()
    await act(async () => button('Connect')!.click())
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('alice', 'grok', true)
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', 'grok', { enabled: true, model: 'default' })
  })
  it('shows Connecting while it waits, then the refusal under the row when the shell has no status', async () => {
    mocks.state = { ...idle, preference: null, native: null }
    await mount('grok')
    let refuse!: (error: Error) => void
    mocks.refresh.mockClear()
    mocks.refresh.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    act(() => button('Connect')!.click())
    expect(button('Connecting…')).toBeTruthy()
    expect(button('Connect')).toBeUndefined()
    await act(async () => refuse(new Error('acp_status is not allowed')))
    expect(button('Connect')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('acp_status is not allowed')
    expect(button('Refresh')).toBeTruthy()
  })
  it('opens the row with the error when connecting fails', async () => {
    mocks.select.mockRejectedValueOnce(new Error('Server unreachable'))
    await mount('grok')
    await act(async () => button('Connect')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Server unreachable')
  })
  it('says how to sign in when the CLI is signed out, and does not connect', async () => {
    mocks.state = { ...mocks.state, native: { installed: true, connected: false, enabled: false } }
    await mount('devin')
    expect(container.textContent).toContain('devin auth login')
    mocks.refresh.mockResolvedValueOnce({ native: { installed: true, connected: false } })
    await act(async () => button('Connect')!.click())
    expect(mocks.select).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Sign in to the Devin (desktop) CLI to connect.')
  })
  it('is not listed by a shell that cannot run it, nor in a browser while it is off', async () => {
    mocks.agents = ['devin']
    await mount('grok')
    expect(container.textContent).toBe('')
    mocks.shell = false
    mocks.agents = []
    await mount('devin')
    expect(container.textContent).toBe('')
    /* on for the account: a browser shows it waiting for the desktop */
    mocks.state = { ...mocks.state, preference: { enabled: true, model: 'swe-2' } }
    await mount('devin')
    expect(container.textContent).toContain('Waiting for a connected desktop.')
    expect(button('Connect')).toBeUndefined()
  })
  it('shows a connected agent with its model and the switch', async () => {
    mocks.state = {
      ...mocks.state,
      preference: { enabled: true, model: 'grok-4.7', effort: 'high' },
      native: { installed: true, connected: true, enabled: true, cliVersion: '1.0.77' },
    }
    await mount('grok')
    expect(container.textContent).toContain('Grok 4.7')
    expect(container.textContent).toContain('High')
    expect(container.querySelector('[role="switch"]')).not.toBeNull()
    expect(button('Connect')).toBeUndefined()
  })
})
