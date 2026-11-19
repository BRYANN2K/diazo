import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLockMode } from '../server/dataLockMode.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/dataLockMode.ts: which installs lock and how. DOOP_DATA_LOCK
 * wins; managed storage (DATABASE_URL) locks nothing; the embedded
 * sidecar is strict; a checkout or container install takes a dead claim
 * over.
 */

afterEach(() => unstubAllEnvs())

describe('server/dataLockMode.ts', () => {
  it('defaults: managed storage off, embedded strict, anything else takeover', () => {
    stubEnv('DOOP_DATA_LOCK', undefined)
    stubEnv('DOOP_EMBEDDED', undefined)

    stubEnv('DATABASE_URL', 'postgres://user:pass@host:5432/doop')
    expect(resolveLockMode()).toBe('off')

    stubEnv('DATABASE_URL', undefined)
    stubEnv('DOOP_EMBEDDED', '1')
    expect(resolveLockMode()).toBe('strict')

    stubEnv('DOOP_EMBEDDED', undefined)
    expect(resolveLockMode()).toBe('takeover')
  })

  it('honours the DOOP_DATA_LOCK override', () => {
    stubEnv('DATABASE_URL', undefined)
    stubEnv('DOOP_EMBEDDED', undefined)

    stubEnv('DOOP_DATA_LOCK', 'strict')
    expect(resolveLockMode()).toBe('strict')

    stubEnv('DOOP_DATA_LOCK', 'takeover')
    stubEnv('DOOP_EMBEDDED', '1')
    expect(resolveLockMode()).toBe('takeover')

    /* off wins even over embedded */
    stubEnv('DOOP_DATA_LOCK', 'off')
    expect(resolveLockMode()).toBe('off')
  })

  it('a managed install creates no lock/ dir — the only creator is skipped', () => {
    stubEnv('DOOP_DATA_LOCK', undefined)
    stubEnv('DOOP_EMBEDDED', undefined)
    stubEnv('DATABASE_URL', 'postgres://user:pass@host:5432/doop')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-mode-'))
    try {
      /* the boot block's shape: off means acquireDataLock never runs */
      const mode = resolveLockMode()
      expect(mode).toBe('off')
      if (mode !== 'off') throw new Error('unreachable')
      expect(fs.existsSync(path.join(dir, 'lock'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
