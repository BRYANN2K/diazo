// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LocalServerRow } from '../src/components/LocalServerRow'
import { canReadLocalServer, isLocalServerStatus, wantsServerChoice } from '../src/lib/localServer'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Settings → About's row for this Mac's server, read from the desktop
   shell's Local Server menu (desktop/src-tauri/src/local_server.rs). */

type Handler = (event: { payload: unknown }) => void
type Bridge = { __DIAZO_LOCAL_SERVER__?: boolean; __DOOP_SERVER_CHOOSE__?: boolean; __TAURI__?: unknown }
const g = globalThis as Bridge

let container: HTMLDivElement
let root: Root
let handlers: Record<string, Handler>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  handlers = {}
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete g.__DIAZO_LOCAL_SERVER__
  delete g.__DOOP_SERVER_CHOOSE__
  delete g.__TAURI__
  history.replaceState(null, '', '/')
})

function shell(status: unknown) {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'local_server_status') return status
    if (command === 'server_status')
      return { url: 'http://127.0.0.1:4400', defaultUrl: 'https://doop.design', custom: true }
    throw new Error(`unexpected ${command}`)
  })
  const listen = vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return () => delete handlers[name]
  })
  g.__DIAZO_LOCAL_SERVER__ = true
  g.__DOOP_SERVER_CHOOSE__ = true
  g.__TAURI__ = { core: { invoke }, event: { listen } }
  return invoke
}

describe('the local server row', () => {
  it('draws nothing outside a shell with the menu', async () => {
    expect(canReadLocalServer()).toBe(false)
    await act(async () => root.render(<LocalServerRow />))
    expect(container.textContent).toBe('')
  })

  it('shows the status, then every change the shell sends', async () => {
    const invoke = shell({ state: 'running', url: 'http://127.0.0.1:4400', inUse: true })
    await act(async () => root.render(<LocalServerRow />))
    expect(invoke).toHaveBeenCalledWith('local_server_status')
    expect(container.textContent).toContain('This Mac’s server')
    expect(container.textContent).toContain('Running at http://127.0.0.1:4400 · This app uses it')

    await act(async () =>
      handlers['local-server']?.({ payload: { state: 'stopped', url: 'http://127.0.0.1:4400', inUse: true } }),
    )
    expect(container.textContent).toContain('Stopped')
    /* anything else on the event is ignored */
    await act(async () => handlers['local-server']?.({ payload: { state: 'exploded' } }))
    expect(container.textContent).toContain('Stopped')
  })

  it('opens the server settings from the menu’s Use Another Server…', async () => {
    history.replaceState(null, '', '/settings?pane=general&server=choose')
    shell({ state: 'not-installed', url: 'http://127.0.0.1:4400', inUse: false })
    await act(async () => root.render(<LocalServerRow />))
    expect(container.textContent).toContain('Not installed on this Mac')
    expect(document.querySelector('input[aria-label="Server address"]')).not.toBeNull()
  })

  it('checks what the shell sends', () => {
    expect(isLocalServerStatus({ state: 'starting', url: 'http://127.0.0.1:4400', inUse: false })).toBe(true)
    expect(isLocalServerStatus({ state: 'running', url: 1, inUse: false })).toBe(false)
    expect(isLocalServerStatus(null)).toBe(false)
    expect(wantsServerChoice('?pane=general&server=choose')).toBe(true)
    expect(wantsServerChoice('?pane=general')).toBe(false)
  })
})
