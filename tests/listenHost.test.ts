import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenHost } from '../server/listenHost.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/listenHost.ts: which interface the server binds. The embedded
 * sidecar binds loopback, always — an explicit DOOP_LISTEN_HOST cannot
 * widen it, only warn — while every other install keeps the override
 * (unset = every interface, as the container needs).
 */

afterEach(unstubAllEnvs)

describe('server/listenHost.ts', () => {
  it('binds loopback for the embedded sidecar when no host is set', () => {
    stubEnv('DOOP_EMBEDDED', '1')
    stubEnv('DOOP_LISTEN_HOST', undefined)
    expect(listenHost()).toBe('127.0.0.1')
  })

  it('forces loopback in embedded mode even when DOOP_LISTEN_HOST says otherwise', () => {
    stubEnv('DOOP_EMBEDDED', '1')
    stubEnv('DOOP_LISTEN_HOST', '0.0.0.0')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(listenHost()).toBe('127.0.0.1')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0'))
    } finally {
      warn.mockRestore()
    }
  })

  it('lets an explicit DOOP_LISTEN_HOST win on other installs', () => {
    stubEnv('DOOP_EMBEDDED', undefined)
    stubEnv('DOOP_LISTEN_HOST', '0.0.0.0')
    expect(listenHost()).toBe('0.0.0.0')
  })

  it('stays unset for a plain install — every interface, as the container needs', () => {
    stubEnv('DOOP_EMBEDDED', undefined)
    stubEnv('DOOP_LISTEN_HOST', undefined)
    expect(listenHost()).toBeUndefined()
  })
})
