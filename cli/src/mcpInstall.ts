import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Environment } from './config.ts'
import { lineDiff } from './diff.ts'
import { CommandError, type Session } from './session.ts'

/**
 * `doop mcp install`: registers this server's /mcp URL with local agent
 * clients, the way the README's connect flow does it (`claude mcp add`,
 * `codex mcp add`, `devin mcp add`): URL only, no token. Each client then
 * runs its own OAuth sign-in and stores its own credentials.
 */

export type ClientName = 'claude' | 'codex' | 'devin'

export const CLIENTS: ClientName[] = ['claude', 'codex', 'devin']

interface Client {
  label: string
  file: (environment: Environment) => string
  edit: (text: string | null, url: string) => string
  login: string
}

export const CLIENT_SETUP: Record<ClientName, Client> = {
  claude: {
    label: 'Claude Code',
    /* user scope, where `claude mcp add --scope user` writes */
    file: (environment) => path.join(environment.home, '.claude.json'),
    edit: (text, url) => editJsonServers(text, url, { type: 'http', url }),
    login: 'run /mcp in Claude Code and pick doop',
  },
  codex: {
    label: 'Codex',
    file: (environment) =>
      path.join(environment.env.CODEX_HOME || path.join(environment.home, '.codex'), 'config.toml'),
    edit: (text, url) => editCodexToml(text ?? '', url),
    login: 'codex mcp login doop',
  },
  devin: {
    label: 'Devin',
    /* user scope, where `devin mcp add --scope user` writes */
    file: (environment) =>
      path.join(environment.env.XDG_CONFIG_HOME || path.join(environment.home, '.config'), 'devin', 'mcp_config.json'),
    edit: (text, url) => editJsonServers(text, url, { url, transport: 'http' }),
    login: 'devin mcp login doop',
  },
}

export class InstallError extends Error {}

/** Sets mcpServers.doop in a JSON config, keeping every other key and the doop entry's extra settings. */
export function editJsonServers(text: string | null, url: string, entry: Record<string, string>): string {
  let data: Record<string, unknown> = {}
  if (text?.trim()) {
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* the parse error could quote a credential; say only where */
      throw new InstallError('is not valid JSON; fix it first')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InstallError('must hold a JSON object')
  }
  const servers = data.mcpServers ?? {}
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new InstallError('has an mcpServers that is not an object')
  }
  const existing = (servers as Record<string, unknown>).doop
  if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
    throw new InstallError('has a doop entry that is not a server; rename or remove it first')
  }
  const current = (existing ?? {}) as Record<string, unknown>
  if ('command' in current) throw new InstallError('has a doop entry that runs a command; rename or remove it first')
  if (Object.entries(entry).every(([key, value]) => current[key] === value)) return text ?? ''
  const indent = /^\s*\{\s*\n([ \t]+)"/.exec(text ?? '')?.[1] ?? '  '
  const out = JSON.stringify({ ...data, mcpServers: { ...servers, doop: { ...current, ...entry } } }, null, indent)
  return !text || text.endsWith('\n') ? `${out}\n` : out
}

const DOOP_TABLE = /^\s*\[\s*mcp_servers\.(doop|"doop"|'doop')\s*\]\s*(#.*)?$/
const DOOP_SUBTABLE = /^\s*\[\s*mcp_servers\.(doop|"doop"|'doop')\./

/** The raw value of `key = value` among a table's lines, comment stripped. */
function tomlValue(block: string[], key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(#.*)?$`)
  for (const line of block) {
    const match = pattern.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * Adds `[mcp_servers.doop]` to a Codex config.toml, with the same rules as the
 * desktop app's "Add to Codex" (desktop/src-tauri/src/codex.rs): a doop entry
 * with this URL is kept (re-enabled if disabled), a different one is refused,
 * and nothing else in the file changes. Without a TOML parser, layouts this
 * text edit cannot read safely (inline or dotted mcp_servers) are refused.
 */
export function editCodexToml(text: string, url: string): string {
  const lines = text.split('\n')
  if (lines.some((line) => /^\s*mcp_servers\s*[=.]/.test(line))) {
    throw new InstallError('defines mcp_servers inline; add doop with `codex mcp add doop --url …` instead')
  }
  const header = lines.findIndex((line) => DOOP_TABLE.test(line))
  if (header === -1) {
    if (lines.some((line) => DOOP_SUBTABLE.test(line))) {
      throw new InstallError('has doop sub-tables without a [mcp_servers.doop] table; fix it first')
    }
    const body = text.length && !text.endsWith('\n') ? `${text}\n` : text
    return `${body}${body.trim() ? '\n' : ''}[mcp_servers.doop]\nurl = ${JSON.stringify(url)}\n`
  }
  let end = header + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) end++
  const block = lines.slice(header + 1, end)
  const existingUrl = tomlValue(block, 'url')?.replace(/^(["'])(.*)\1$/, '$2')
  if (existingUrl !== url || tomlValue(block, 'command') !== undefined || tomlValue(block, 'args') !== undefined) {
    throw new InstallError('already has a different doop connection; rename or remove it first')
  }
  const disabled = block.findIndex((line) => /^\s*enabled\s*=\s*false\b/.test(line))
  if (disabled === -1) return text
  const next = [...lines]
  next[header + 1 + disabled] = (block[disabled] ?? '').replace('false', 'true')
  return next.join('\n')
}

/** Follows a dotfile symlink so the link itself is never replaced. */
function targetPath(file: string): string {
  return existsSync(file) ? realpathSync(file) : file
}

function readOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Writes through a temp file in the same folder, keeping the old file's mode (0600 for a new one). */
function writeAtomically(file: string, text: string, before: string | null): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.doop-tmp-${process.pid}`
  writeFileSync(temp, text, { mode: before === null ? 0o600 : statSync(file).mode & 0o777 })
  if (readOrNull(file) !== before) throw new CommandError(`${file} changed while doop was editing it; run again`)
  renameSync(temp, file)
}

export function backupName(file: string, now: Date): string {
  return `${file}.bak-doop-${now.toISOString().replace(/[:.]/g, '-')}`
}

export function parseClients(args: string[]): ClientName[] {
  if (!args.length) return CLIENTS
  return args.map((arg) => {
    const name = arg.toLowerCase().replace(/[-_ ]?code$/, '')
    const client = CLIENTS.find((c) => c === name)
    if (!client) throw new CommandError(`unknown client "${arg}"; pick from ${CLIENTS.join(', ')}`)
    return client
  })
}

/** Shows each change, asks, backs the file up, then writes. */
export async function mcpInstall(session: Session, now: () => Date = () => new Date()): Promise<number> {
  const { io, environment } = session.ctx
  const { flags, args } = session.invocation
  const url = `${session.serverUrl()}/mcp`
  let failures = 0
  for (const name of parseClients(args)) {
    const client = CLIENT_SETUP[name]
    const file = targetPath(client.file(environment))
    const before = readOrNull(file)
    let after: string
    try {
      after = client.edit(before, url)
    } catch (error) {
      if (!(error instanceof InstallError)) throw error
      io.err(`diazo: ${client.label}: ${file} ${error.message}`)
      failures++
      continue
    }
    if (after === (before ?? '')) {
      io.out(`${client.label}: already set up in ${file}`)
      continue
    }
    io.out(`${client.label}: ${file}`)
    io.out(lineDiff(before ?? '', after, [before === null ? '(new file)' : file, file]).text)
    if (flags.dryRun) continue
    if (!flags.yes && !(await io.confirm(`Write this to ${file}?`))) {
      io.out(`${client.label}: skipped`)
      continue
    }
    if (before !== null) {
      const backup = backupName(file, now())
      copyFileSync(file, backup)
      chmodSync(backup, statSync(file).mode & 0o777)
      io.out(`${client.label}: backup at ${backup}`)
    }
    writeAtomically(file, after, before)
    io.out(`${client.label}: added doop. Sign in: ${client.login}`)
  }
  return failures ? 1 : 0
}
