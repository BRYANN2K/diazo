import { expect, it, vi } from 'vitest'

/* captures the options the sandbox hands to `new Worker` — the QuickJS
   guest's wasm memory is bounded separately, but the worker thread's own
   V8 heap must be too */
const captured = vi.hoisted(() => ({ opts: undefined as unknown }))

vi.mock('node:worker_threads', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:worker_threads')>()
  class FakeWorker {
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    constructor(_url: unknown, opts: unknown) {
      captured.opts = opts
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    postMessage() {
      setTimeout(() => {
        for (const fn of this.handlers.get('error') ?? []) fn(new Error('fake worker'))
      }, 0)
    }
    terminate() {
      return Promise.resolve(0)
    }
  }
  return { ...orig, Worker: FakeWorker }
})

import { runInSandbox } from '../server/scriptSandbox.ts'

it('bounds the worker thread heap via resourceLimits', async () => {
  await runInSandbox({ source: 'return 1', call: async () => null })
  const opts = captured.opts as {
    resourceLimits?: { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number }
  }
  expect(opts.resourceLimits?.maxOldGenerationSizeMb).toBeGreaterThan(0)
  expect(opts.resourceLimits?.maxOldGenerationSizeMb).toBeLessThanOrEqual(512)
  expect(opts.resourceLimits?.maxYoungGenerationSizeMb).toBeGreaterThan(0)
})
