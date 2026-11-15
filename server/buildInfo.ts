import { execFileSync } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }
import { type BuildInfo, normalizeSha } from '../shared/buildInfo.ts'
import { env } from './env.ts'

/**
 * The running build. An image carries `DOOP_BUILD_SHA` / `DOOP_BUILD_DATE`
 * (Dockerfile build args, filled by .github/workflows/docker.yml); a dev
 * checkout has neither and asks git once, and anything else (an image built
 * without the args, a tarball) reports the SHA as unknown.
 */
let cached: BuildInfo | undefined

export function buildInfo(): BuildInfo {
  cached ??= {
    version: packageJson.version,
    sha: normalizeSha(env.DOOP_BUILD_SHA) ?? gitHead(),
    date: validDate(env.DOOP_BUILD_DATE),
  }
  return cached
}

/** For tests that change the build variables. */
export function resetBuildInfo(): void {
  cached = undefined
}

function gitHead(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return normalizeSha(out)
  } catch {
    return null
  }
}

function validDate(value: string | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}
