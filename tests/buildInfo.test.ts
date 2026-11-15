import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { buildInfo, resetBuildInfo } from '../server/buildInfo.ts'
import { normalizeSha, shortSha } from '../shared/buildInfo.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/** The running build as GET /api/version reports it: the image's baked
 *  commit and date, else what git says in a dev checkout. */

const SHA = 'a'.repeat(40)

afterEach(() => {
  unstubAllEnvs()
  resetBuildInfo()
})

describe('build identity', () => {
  it('reports the baked commit, date and the package version', () => {
    stubEnv('DOOP_BUILD_SHA', SHA.toUpperCase())
    stubEnv('DOOP_BUILD_DATE', '2026-11-15T10:00:00Z')
    expect(buildInfo()).toEqual({ version: packageJson.version, sha: SHA, date: '2026-11-15T10:00:00.000Z' })
  })

  it('falls back to git in a checkout, and drops a date that does not parse', () => {
    stubEnv('DOOP_BUILD_SHA', 'dev')
    stubEnv('DOOP_BUILD_DATE', 'yesterday-ish')
    const info = buildInfo()
    /* this test runs inside the repository, so git knows HEAD */
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(info.date).toBeNull()
  })

  it('accepts only a full commit SHA', () => {
    expect(normalizeSha(` ${SHA}\n`)).toBe(SHA)
    expect(normalizeSha('abc1234')).toBeNull()
    expect(normalizeSha('')).toBeNull()
    expect(normalizeSha(undefined)).toBeNull()
    expect(shortSha(SHA)).toBe('aaaaaaa')
  })
})
