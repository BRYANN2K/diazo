import path from 'node:path'
import { HELP, parseDoopRef, parseInvocation, UsageError, type Invocation } from './args.ts'
import { callTool, DoopError, type Connection, type FetchLike } from './client.ts'
import {
  ConfigError,
  isAgentKey,
  realEnvironment,
  resolveSettings,
  userConfigPath,
  type Environment,
  type Settings,
} from './config.ts'
import { realIo, type Io } from './io.ts'
import { findProject, PROJECT_FILE, ProjectError, resolveCanvas, writeProjectFile, type Project } from './project.ts'

export const VERSION = '0.1.0'

/** Everything a command touches outside its arguments. */
export interface Context {
  environment: Environment
  io: Io
  fetch?: FetchLike
}

/** Runs one invocation and returns the exit code: 0 done, 1 failed, 2 bad usage. */
export async function main(argv: string[], context?: Partial<Context>): Promise<number> {
  const ctx: Context = { environment: realEnvironment(), io: realIo(), ...context }
  try {
    const invocation = parseInvocation(argv)
    if (invocation.flags.version) {
      ctx.io.out(VERSION)
      return 0
    }
    if (invocation.flags.help || invocation.command === 'help') {
      ctx.io.out(HELP)
      return 0
    }
    return await run(invocation, ctx)
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.io.err(`doop: ${error.message}\n\n${HELP}`)
      return 2
    }
    if (
      error instanceof DoopError ||
      error instanceof ConfigError ||
      error instanceof ProjectError ||
      error instanceof CommandError
    ) {
      ctx.io.err(`doop: ${error.message}`)
      return 1
    }
    throw error
  }
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
    if (!canvas) throw new CommandError(`no canvas; run \`doop link <canvas>\` here or pass --canvas`)
    return canvas
  }
}

type Command = (session: Session) => Promise<number>

const COMMANDS: Record<string, Command> = {
  config: showConfig,
  link,
  open,
}

function run(invocation: Invocation, ctx: Context): Promise<number> {
  const command = COMMANDS[invocation.command]
  if (!command) throw new UsageError(`unknown command "${invocation.command}"`)
  return command(new Session(invocation, ctx))
}

async function showConfig(session: Session): Promise<number> {
  const { io, environment } = session.ctx
  const { settings, project } = session
  io.out(`server     ${settings.url ?? '(not set)'}${settings.url ? ` (from ${settings.urlSource})` : ''}`)
  io.out(
    `agent key  ${settings.key ? `set (from ${settings.keySource === 'env' ? 'DOOP_AGENT_KEY' : 'file'})` : '(not set)'}`,
  )
  io.out(`config     ${userConfigPath(environment)}`)
  io.out(`project    ${project ? `${project.file} -> canvas ${project.data.canvas}` : '(no .doop.json)'}`)
  return 0
}

interface CanvasListing {
  id: string
  name: string
}

async function link(session: Session): Promise<number> {
  const { io, environment } = session.ctx
  const { canvas } = parseDoopRef(session.invocation.args[0] ?? '')
  if (!canvas) throw new CommandError('give a canvas id or link')
  const file = path.join(environment.cwd, PROJECT_FILE)
  let name: string | undefined
  if (session.settings.key && session.settings.url) {
    const canvases = await session.call<CanvasListing[]>('list_canvases', {})
    const match = Array.isArray(canvases) ? canvases.find((c) => c.id === canvas) : undefined
    if (!match) throw new CommandError(`canvas ${canvas} is not one this agent key can open`)
    name = match.name
  } else {
    io.err('doop: no server or agent key configured, so the canvas id was not checked')
  }
  const existing = session.project?.file === file ? session.project.data : null
  if (existing && existing.canvas !== canvas) {
    const ok =
      session.invocation.flags.yes ||
      (await io.confirm(`${PROJECT_FILE} links canvas ${existing.canvas}. Relink it to ${canvas}?`))
    if (!ok) {
      io.err('doop: left unchanged')
      return 1
    }
  }
  /* pulled files belong to the old canvas; drop them on a relink */
  const keepFrames = existing && existing.canvas === canvas ? existing.frames : undefined
  writeProjectFile(file, {
    canvas,
    ...(existing?.url ? { url: existing.url } : {}),
    ...(keepFrames ? { frames: keepFrames } : {}),
  })
  io.out(`linked ${environment.cwd} to canvas ${canvas}${name ? ` (${name})` : ''}`)
  return 0
}

async function open(session: Session): Promise<number> {
  const url = new URL(`/c/${encodeURIComponent(session.canvas())}`, session.serverUrl())
  const ref = session.invocation.args[0]
  if (ref) {
    const { frame } = parseDoopRef(ref)
    if (frame) url.searchParams.set('frame', frame)
  }
  await session.ctx.io.openUrl(url.toString())
  session.ctx.io.out(url.toString())
  return 0
}
