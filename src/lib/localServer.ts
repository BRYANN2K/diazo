/**
 * This Mac's Diazo server, as scripts/install.sh sets it up and the desktop
 * shell's Local Server menu drives it (desktop/src-tauri/src/local_server.rs).
 * The page only reads its status: `local_server_status` once, then every
 * change as a `local-server` event. Starting and stopping stay in the native
 * menu, behind its confirmations. Shells advertise this with
 * `__DIAZO_LOCAL_SERVER__` (macOS, 0.16 and later).
 */

export type LocalServerState = 'running' | 'starting' | 'stopped' | 'not-installed'

export interface LocalServerStatus {
  state: LocalServerState
  /** where it answers, e.g. http://127.0.0.1:4400 */
  url: string
  /** the app has this server open */
  inUse: boolean
}

export const LOCAL_SERVER_EVENT = 'local-server'

type Bridge = {
  __DIAZO_LOCAL_SERVER__?: boolean
  __TAURI__?: {
    core?: { invoke?: (command: string) => Promise<unknown> }
    event?: { listen?: <T>(name: string, handler: (event: { payload: T }) => void) => Promise<() => void> }
  }
}

const bridge = globalThis as Bridge

export const canReadLocalServer = () => bridge.__DIAZO_LOCAL_SERVER__ === true && !!bridge.__TAURI__?.core?.invoke

const STATES: readonly string[] = ['running', 'starting', 'stopped', 'not-installed']

export function isLocalServerStatus(value: unknown): value is LocalServerStatus {
  const status = value as Partial<LocalServerStatus> | null
  return (
    typeof status?.state === 'string' &&
    STATES.includes(status.state) &&
    typeof status.url === 'string' &&
    typeof status.inUse === 'boolean'
  )
}

/** Hands the status to `onStatus` now and on every change; returns the
 *  unsubscribe. Outside a shell that has the menu, nothing happens. */
export function watchLocalServer(onStatus: (status: LocalServerStatus) => void): () => void {
  if (!canReadLocalServer()) return () => {}
  const tauri = bridge.__TAURI__
  let stopped = false
  let unlisten: (() => void) | undefined
  tauri?.event
    ?.listen?.<unknown>(LOCAL_SERVER_EVENT, (event) => {
      if (!stopped && isLocalServerStatus(event.payload)) onStatus(event.payload)
    })
    .then((off) => {
      if (stopped) off()
      else unlisten = off
    })
    .catch(console.error)
  tauri?.core
    ?.invoke?.('local_server_status')
    .then((status) => {
      if (!stopped && isLocalServerStatus(status)) onStatus(status)
    })
    .catch(console.error)
  return () => {
    stopped = true
    unlisten?.()
  }
}

/** The Local Server menu's "Use Another Server…" opens Settings with
 *  `?server=choose`, which opens the server settings. */
export function wantsServerChoice(search: string): boolean {
  return new URLSearchParams(search).get('server') === 'choose'
}
