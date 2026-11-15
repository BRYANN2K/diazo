import type { Invocation } from './args.ts'
import { callTool, type Connection, type FetchLike } from './client.ts'
import { isAgentKey, resolveSettings, userConfigPath, type Environment, type Settings } from './config.ts'
import type { Io } from './io.ts'
import { findProject, resolveCanvas, type Project } from './project.ts'

/** Everything a command touches outside its arguments. */
export interface Context {
  environment: Environment
  io: Io
  fetch?: FetchLike
}

export class CommandError extends Error {}

/** State shared by the commands of one run. */
export class Session {
  readonly project: Project | null
  readonly settings: Settings

  constructor(
    readonly invocation: Invocation,
    readonly ctx: Context,
  ) {
    this.project = findProject(ctx.environment.cwd)
    this.settings = resolveSettings(ctx.environment, {
      flagUrl: invocation.flags.url,
      projectUrl: this.project?.data.url,
    })
  }

  serverUrl(): string {
    if (!this.settings.url) {
      throw new CommandError(
        `no server URL; pass --url, set DOOP_URL, or put {"url": "https://…"} in ${userConfigPath(this.ctx.environment)}`,
      )
    }
    return this.settings.url
  }

  connection(): Connection {
    const url = this.serverUrl()
    const key = this.settings.key
    if (!key) {
      throw new CommandError(
        `no agent key; set DOOP_AGENT_KEY or put {"agentKey": "dpk_…"} in ${userConfigPath(this.ctx.environment)} (chmod 600)`,
      )
    }
    if (!isAgentKey(key)) throw new CommandError(`the agent key from ${this.settings.keySource} is not a dpk_ key`)
    return { url, key, ...(this.ctx.fetch ? { fetch: this.ctx.fetch } : {}) }
  }

  call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return callTool<T>(this.connection(), name, args)
  }

  canvas(): string {
    const canvas = resolveCanvas(this.project, this.invocation.flags.canvas)
    if (!canvas) throw new CommandError(`no canvas; run \`diazo link <canvas>\` here or pass --canvas`)
    return canvas
  }
}
