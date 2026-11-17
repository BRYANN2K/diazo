import { afterEach, describe, expect, it } from 'vitest'
import { listenHost } from '../server/listenHost.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/listenHost.ts: which interface the server binds. The embedded
 * sidecar must never end up on every interface just because the shell
 * forgot DOOP_LISTEN_HOST — loopback is its default, every other install
 * keeps the container's all-interfaces bind.
 */

afterEach(unstubAllEnvs)

describe('server/listenHost.ts', () => {
  it('binds loopback for the embedded sidecar when no host is set', () => {
    stubEnv('DOOP_EMBEDDED', '1')
    stubEnv('DOOP_LISTEN_HOST', undefined)
    expect(listenHost()).toBe('127.0.0.1')
  })

  it('lets an explicit DOOP_LISTEN_HOST win, embedded or not', () => {
    stubEnv('DOOP_EMBEDDED', '1')
    stubEnv('DOOP_LISTEN_HOST', '0.0.0.0')
    expect(listenHost()).toBe('0.0.0.0')
    stubEnv('DOOP_EMBEDDED', undefined)
    expect(listenHost()).toBe('0.0.0.0')
  })

  it('stays unset for a plain install — every interface, as the container needs', () => {
    stubEnv('DOOP_EMBEDDED', undefined)
    stubEnv('DOOP_LISTEN_HOST', undefined)
    expect(listenHost()).toBeUndefined()
  })
})
