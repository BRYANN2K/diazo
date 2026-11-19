import { describe, expect, it, vi } from 'vitest'
import { settleShutdown } from '../server/shutdown.ts'

/**
 * server/shutdown.ts: the flush that runs on the way out. A failed flush
 * must be logged — Promise.allSettled alone would swallow it behind a
 * clean exit — and must never keep the process (or the db close) waiting.
 */
describe('server/shutdown.ts', () => {
  it('logs a failed shutdown flush instead of swallowing it', async () => {
    const boom = new Error('disk gone mid-flush')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await settleShutdown(Promise.reject(boom), Promise.resolve())
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('flush'), boom)
    } finally {
      spy.mockRestore()
    }
  })

  it('still settles when the flush fails — the exit is never held back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(settleShutdown(Promise.reject(new Error('nope')), Promise.resolve())).resolves.toBeUndefined()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
