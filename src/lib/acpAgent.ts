import { create } from 'zustand'
import { api, ApiError } from './api'
import { useStore } from './store'
import type { AcpRunOutput, LocalAgentJob, LocalAgentResult } from '../../shared/localAgent'
import {
  ACP_AGENTS,
  isAcpAgent,
  type AcpAgent,
  type AcpAgentPreference,
  type AcpCatalogModel,
} from '../../shared/acpAgent'
import { fromAcpUsage } from '../../shared/usage'

/**
 * The desktop agents spoken to over ACP (Devin, Grok), as the page drives
 * them: the shell's `acp_*` commands (desktop/src-tauri/src/acp.rs) and the
 * server's `/api/local-agent/acp/:agent` relay. Shaped after localAgent.ts,
 * which does the same for the Claude Plan, with one poller per agent.
 */

/** What the shell's `acp_status` says about one CLI on this computer. */
export interface AcpNativeStatus {
  installed: boolean
  /** signed in, as the CLI itself reports */
  connected: boolean
  /** this Doop account may run it on this device */
  enabled: boolean
  cliPath?: string
  cliVersion?: string
  models?: AcpCatalogModel[]
  loginCommand?: string
}

type Bridge = {
  __DOOP_ACP_AGENTS__?: unknown
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
    event: { listen: <T>(name: string, callback: (event: { payload: T }) => void) => Promise<() => void> }
  }
}
const bridge = globalThis as Bridge

/** The agents this desktop shell can run; none in a browser or an older shell. */
export function desktopAcpAgents(): AcpAgent[] {
  const listed = bridge.__DOOP_ACP_AGENTS__
  return Array.isArray(listed) ? listed.filter(isAcpAgent) : []
}

export const hasAcpAgent = (agent: AcpAgent) => desktopAcpAgents().includes(agent)

export function invokeAcp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge.__TAURI__ || desktopAcpAgents().length === 0)
    return Promise.reject(new Error('Update the Diazo desktop app to run local agents.'))
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

export interface AcpAgentState {
  preference: AcpAgentPreference | null
  native: AcpNativeStatus | null
  running: boolean
  progress: string
  error: string
}

const EMPTY: AcpAgentState = { preference: null, native: null, running: false, progress: '', error: '' }

export const useAcpAgents = create<Record<AcpAgent, AcpAgentState>>(
  () => Object.fromEntries(ACP_AGENTS.map((agent) => [agent, EMPTY])) as Record<AcpAgent, AcpAgentState>,
)

function patch(agent: AcpAgent, next: Partial<AcpAgentState> | ((s: AcpAgentState) => Partial<AcpAgentState>)) {
  useAcpAgents.setState((all) => ({
    [agent]: { ...all[agent], ...(typeof next === 'function' ? next(all[agent]) : next) },
  }))
}

/** `fresh` asks the login shell and the CLI again (the Refresh button).
 *  Each side is kept when it answered, even when the other failed: the row
 *  then still shows the half it knows next to the error. */
export async function refreshAcpAgent(userId: string, agent: AcpAgent, fresh = false) {
  const [preference, native] = await Promise.allSettled([
    api.acpAgent(agent),
    hasAcpAgent(agent) ? invokeAcp<AcpNativeStatus>('acp_status', { userId, agent, fresh }) : Promise.resolve(null),
  ])
  patch(agent, {
    ...(preference.status === 'fulfilled' ? { preference: preference.value } : {}),
    ...(native.status === 'fulfilled' ? { native: native.value } : {}),
  })
  /* the shell's own failure is what blocks connecting, so it is reported first */
  const failed = [native, preference].find((result) => result.status === 'rejected') as
    PromiseRejectedResult | undefined
  if (failed) throw failed.reason
  return {
    preference: preference.status === 'fulfilled' ? preference.value : null,
    native: native.status === 'fulfilled' ? native.value : null,
  }
}

export async function selectAcpAgent(userId: string, agent: AcpAgent, preference: AcpAgentPreference) {
  if (preference.enabled) await invokeAcp('acp_connect', { userId, agent, enabled: true })
  /* the server's routing is authoritative: switching off never waits on the CLI */
  const saved = await api.setAcpAgent(agent, preference)
  patch(agent, { preference: saved })
  if (preference.enabled) await refreshAcpAgent(userId, agent)
  useStore.getState().allowanceChanged()
}

export async function disconnectAcpAgent(userId: string, agent: AcpAgent) {
  const current = useAcpAgents.getState()[agent].preference
  await api.setAcpAgent(agent, { enabled: false, model: current?.model ?? 'default' })
  await invokeAcp('acp_stop', { agent })
  await invokeAcp('acp_connect', { userId, agent, enabled: false })
  await refreshAcpAgent(userId, agent)
  useStore.getState().allowanceChanged()
}

export async function stopAcpAgent(agent: AcpAgent) {
  await invokeAcp('acp_stop', { agent })
  await api.stopAcpAgent(agent)
}

/** The run's result for the server: the text and, when the agent said, what
 *  it consumed. */
export function acpResult(output: AcpRunOutput, model: string): LocalAgentResult {
  const { success, text } = output
  const usage = fromAcpUsage(output.acpUsage, model)
  return { success, text: text.slice(0, 100_000), ...(usage.length > 0 ? { usage } : {}) }
}

/** One agent's poller: claims its jobs for this webview, runs them through
 *  the shell and hands the result back. Lives above navigation, as the
 *  Plan's does; one random claimant per webview lifetime. */
function startOne(userId: string, agent: AcpAgent): () => void {
  const deviceId = crypto.randomUUID()
  let disposed = false
  let polling = false
  let activeId: string | null = null
  let completed: { id: string; result: LocalAgentResult } | null = null
  /* the CLI's model list rides on a poll now and then, not on every one */
  let catalogSentAt = 0
  let unlisten: (() => void) | undefined
  patch(agent, EMPTY)
  bridge
    .__TAURI__!.event.listen<{ agent: string; id: string; text: string }>('acp-progress', ({ payload }) => {
      if (!disposed && payload.agent === agent && payload.id === activeId)
        patch(agent, (s) => ({ progress: (s.progress + payload.text).slice(-6000) }))
    })
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {})

  const launch = async (job: LocalAgentJob) => {
    activeId = job.id
    patch(agent, { running: true, progress: '', error: '' })
    let result: LocalAgentResult
    try {
      result = acpResult(await invokeAcp<AcpRunOutput>('acp_run', { userId, job }), job.model)
    } catch (error) {
      result = { success: false, text: String(error).slice(0, 100_000) }
    }
    if (disposed) return
    completed = { id: job.id, result }
    patch(agent, { running: false, progress: result.text, error: result.success ? '' : result.text })
  }

  const poll = async () => {
    if (disposed || polling) return
    polling = true
    try {
      const native = useAcpAgents.getState()[agent].native
      if (!native) {
        await refreshAcpAgent(userId, agent)
        return
      }
      if (!native.enabled || !native.installed) return
      if (completed) {
        try {
          await api.finishLocalAgent(completed.id, deviceId, completed.result)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) throw error
        }
        completed = null
        activeId = null
      }
      const sendCatalog = !!native.models?.length && Date.now() - catalogSentAt > 60_000
      const { job, enabled } = await api.pollAcpAgent(agent, deviceId, sendCatalog ? native.models : undefined)
      if (sendCatalog) catalogSentAt = Date.now()
      if (disposed) return
      if ((!enabled || !job || job.id !== activeId) && activeId) {
        await invokeAcp('acp_stop', { agent })
        return
      }
      if (job && !activeId && job.agent === agent) void launch(job)
    } catch (error) {
      if (!disposed) patch(agent, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      polling = false
    }
  }
  void poll()
  const timer = window.setInterval(() => {
    void poll()
  }, 3000)
  return () => {
    disposed = true
    window.clearInterval(timer)
    unlisten?.()
    invokeAcp('acp_stop', { agent }).catch(() => {})
  }
}

/** Every ACP agent this shell can run, each polling for its own jobs. */
export function startAcpAgents(userId: string): () => void {
  const stops = desktopAcpAgents().map((agent) => startOne(userId, agent))
  return () => {
    for (const stop of stops) stop()
  }
}
