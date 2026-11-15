import { randomBytes, randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { LocalAgentJob, LocalAgentResult } from '../shared/localAgent.ts'
import type { AcpAgent, AcpCatalogModel } from '../shared/acpAgent.ts'

/** Which desktop agent a run goes to: the Claude Plan, or an ACP agent. */
export type LocalAgentKind = 'claude' | AcpAgent

/** What one run is started with on the desktop. */
export interface LocalRunSettings {
  agent?: LocalAgentKind
  model: string
  effort?: LocalAgentJob['effort']
}

export interface LocalHarnessRequest {
  canvasId: string
  prompt: string
  system: string
  tools: Anthropic.Tool[]
  maxTurns: number
  /** Stops this canvas run without canceling other work for the account. */
  isCanceled?: () => boolean
  /** fires when the run's work is stopped, so the run ends now rather than
   *  on the next expiry sweep */
  signal?: AbortSignal
  execute: (block: Anthropic.ToolUseBlockParam) => Promise<Anthropic.ToolResultBlockParam>
}

interface Run {
  userId: string
  agent: LocalAgentKind
  deviceId?: string
  job: LocalAgentJob
  request: LocalHarnessRequest
  lastSeen: number
  startedAt: number
  closing: boolean
  tail: Promise<unknown>
  resolve: (result: LocalAgentResult) => void
}

/** Devices poll per agent, so a desktop running Devin is not the one
 *  holding the Claude Plan by accident. */
const deviceKey = (userId: string, agent: LocalAgentKind) => (agent === 'claude' ? userId : `${agent}:${userId}`)

/** A single server process owns each live canvas sweep, as with resident.ts.
 * Tokens expire with the run. No CLI credentials pass through this relay. */
export class LocalAgentRuns {
  private runs = new Map<string, Run>()
  private devices = new Map<string, { id: string; at: number }>()
  /** the models each desktop's ACP CLI lists, as it last reported them */
  private catalogs = new Map<string, { models: AcpCatalogModel[]; at: number }>()

  online(userId: string, now = Date.now(), agent: LocalAgentKind = 'claude') {
    return now - (this.devices.get(deviceKey(userId, agent))?.at ?? 0) < 30_000
  }

  /** What the desktop's CLI listed, while that desktop is online. */
  catalog(userId: string, agent: AcpAgent, now = Date.now()): AcpCatalogModel[] {
    return this.online(userId, now, agent) ? (this.catalogs.get(deviceKey(userId, agent))?.models ?? []) : []
  }

  poll(
    userId: string,
    deviceId: string,
    now = Date.now(),
    agent: LocalAgentKind = 'claude',
    catalog?: AcpCatalogModel[],
  ): LocalAgentJob | null {
    const key = deviceKey(userId, agent)
    const device = this.devices.get(key)
    if (device && device.id !== deviceId && this.online(userId, now, agent)) return null
    this.devices.set(key, { id: deviceId, at: now })
    if (catalog) this.catalogs.set(key, { models: catalog, at: now })
    const run = [...this.runs.values()].find(
      (r) => r.userId === userId && r.agent === agent && !r.closing && !r.request.isCanceled?.(),
    )
    if (!run || (run.deviceId && run.deviceId !== deviceId)) return null
    run.deviceId = deviceId
    run.lastSeen = now
    return run.job
  }

  start(
    userId: string,
    { agent = 'claude', model, effort }: LocalRunSettings,
    request: LocalHarnessRequest,
  ): Promise<LocalAgentResult> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const run: Run = {
        userId,
        agent,
        request,
        resolve,
        lastSeen: Date.now(),
        startedAt: Date.now(),
        closing: false,
        tail: Promise.resolve(),
        job: {
          id,
          token: randomBytes(32).toString('hex'),
          model,
          ...(effort ? { effort } : {}),
          prompt: request.prompt,
          system: request.system,
          maxTurns: request.maxTurns,
          /* absent for the Plan, so a shell from before ACP reads it unchanged */
          ...(agent !== 'claude' ? { agent, tools: request.tools.map((tool) => tool.name) } : {}),
        },
      }
      this.runs.set(id, run)
      request.signal?.addEventListener('abort', () => void this.close(run, { success: false, text: 'Task stopped.' }), {
        once: true,
      })
    })
  }

  authorized(id: string, token: string): Run | undefined {
    const run = this.runs.get(id)
    return run && !run.closing && !run.request.isCanceled?.() && run.deviceId && token === run.job.token
      ? run
      : undefined
  }

  async execute(id: string, token: string, name: string, input: Record<string, unknown>) {
    const run = this.authorized(id, token)
    if (!run || !run.request.tools.some((tool) => tool.name === name)) throw new Error('Run or tool unavailable')
    const result = run.tail.then(() => {
      if (run.closing || run.request.isCanceled?.()) throw new Error('Run ended')
      return run.request.execute({ type: 'tool_use', id: randomUUID(), name, input })
    })
    run.tail = result.catch(() => {})
    return result
  }

  async finish(id: string, userId: string, deviceId: string, result: LocalAgentResult) {
    const run = this.runs.get(id)
    if (!run || run.userId !== userId || run.deviceId !== deviceId || run.closing) return false
    await this.close(run, shellResult(result))
    return true
  }

  private async close(run: Run, result: LocalAgentResult) {
    if (run.closing) return
    run.closing = true
    await run.tail
    this.runs.delete(run.job.id)
    run.resolve(result)
  }

  async cancel(userId: string, agent: LocalAgentKind = 'claude') {
    this.devices.delete(deviceKey(userId, agent))
    this.catalogs.delete(deviceKey(userId, agent))
    const name = agent === 'claude' ? 'Claude' : agent === 'devin' ? 'Devin' : 'Grok'
    await Promise.all(
      [...this.runs.values()]
        .filter((r) => r.userId === userId && r.agent === agent && !r.closing)
        .map((r) => this.close(r, { success: false, text: `Local ${name} run stopped.` })),
    )
  }

  async expire(now = Date.now()) {
    await Promise.all(
      [...this.runs.values()]
        .filter(
          (r) =>
            !r.closing &&
            (r.request.isCanceled?.() ||
              (r.deviceId ? now - r.lastSeen > 45_000 : !this.online(r.userId, now, r.agent)) ||
              now - r.startedAt > 30 * 60_000),
        )
        .map((r) =>
          this.close(r, {
            success: false,
            text: r.request.isCanceled?.()
              ? 'Task stopped.'
              : 'Desktop disconnected or local run timed out. Retry the task.',
          }),
        ),
    )
    for (const [key, device] of this.devices)
      if (now - device.at > 60_000) {
        this.devices.delete(key)
        this.catalogs.delete(key)
      }
  }
}

/** A desktop shell from before the model aliases refuses them with a bare
 *  "Invalid model"; say what the person can do about it. */
function shellResult(result: LocalAgentResult): LocalAgentResult {
  if (result.success || !/^invalid model$/i.test(result.text.trim())) return result
  return {
    success: false,
    text: 'The Doop desktop app on this device is too old for that model. Update it, or pick a pinned model id in Settings.',
  }
}

export const localAgentRuns = new LocalAgentRuns()
const cleanup = setInterval(() => {
  void localAgentRuns.expire()
}, 5_000)
cleanup.unref()
