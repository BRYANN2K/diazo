import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Where the CLI looks things up. Injected so tests never touch the real home. */
export interface Environment {
  env: Record<string, string | undefined>
  home: string
  cwd: string
}

export function realEnvironment(): Environment {
  return { env: process.env, home: homedir(), cwd: process.cwd() }
}

/** The user file, outside every repo: $XDG_CONFIG_HOME/doop/config.json or ~/.config/doop/config.json. */
export function userConfigPath(environment: Environment): string {
  const base = environment.env.XDG_CONFIG_HOME || path.join(environment.home, '.config')
  return path.join(base, 'doop', 'config.json')
}

export interface UserConfig {
  url?: string
  agentKey?: string
}

export class ConfigError extends Error {}

/** Reads the user config. A missing file is an empty config; a key in a file others can read is refused. */
export function readUserConfig(environment: Environment): UserConfig {
  const file = userConfigPath(environment)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`cannot read ${file}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    /* JSON.parse errors can quote the file, and the file can hold the key */
    throw new ConfigError(`${file} is not valid JSON`)
  }
  if (!data || typeof data !== 'object') throw new ConfigError(`${file} must hold a JSON object`)
  const record = data as Record<string, unknown>
  const config: UserConfig = {}
  if (typeof record.url === 'string') config.url = record.url
  if (typeof record.agentKey === 'string') {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
      throw new ConfigError(`${file} holds an agent key but others can read it; run chmod 600 on it`)
    }
    config.agentKey = record.agentKey
  }
  return config
}

/** Normalises a server URL: http(s) only, no credentials, no trailing slash, no path. */
export function normaliseServerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ConfigError(`"${raw}" is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError('the server URL must be http(s)')
  if (url.username || url.password) throw new ConfigError('the server URL must not carry credentials')
  return url.origin
}

export type KeySource = 'env' | 'file' | 'none'

export interface Settings {
  url?: string
  urlSource: 'flag' | 'env' | 'project' | 'file' | 'none'
  key?: string
  keySource: KeySource
}

/** Server URL: --url, then DOOP_URL, then .doop.json, then the user file. Key: DOOP_AGENT_KEY, then the file. */
export function resolveSettings(environment: Environment, options: { flagUrl?: string; projectUrl?: string }) {
  const file = readUserConfig(environment)
  const settings: Settings = { urlSource: 'none', keySource: 'none' }
  const candidates: Array<[Settings['urlSource'], string | undefined]> = [
    ['flag', options.flagUrl],
    ['env', environment.env.DOOP_URL],
    ['project', options.projectUrl],
    ['file', file.url],
  ]
  const found = candidates.find(([, value]) => value)
  if (found?.[1]) {
    settings.url = normaliseServerUrl(found[1])
    settings.urlSource = found[0]
  }
  const envKey = environment.env.DOOP_AGENT_KEY?.trim()
  if (envKey) {
    settings.key = envKey
    settings.keySource = 'env'
  } else if (file.agentKey) {
    settings.key = file.agentKey.trim()
    settings.keySource = 'file'
  }
  return settings
}

/** Agent keys look like `dpk_` plus at least 20 url-safe characters (server/agentKeys.ts). */
export function isAgentKey(value: string): boolean {
  return /^dpk_[\w-]{20,}$/.test(value)
}
