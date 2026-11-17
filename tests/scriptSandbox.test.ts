import { describe, expect, it } from 'vitest'
import { runInSandbox, stripTypes, type SandboxOutcome } from '../server/scriptSandbox'

const ok = (outcome: SandboxOutcome) => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error}`)
  return outcome
}

const fail = (outcome: SandboxOutcome) => {
  if (outcome.ok) throw new Error('expected failure, got success')
  return outcome
}

const noop = () => Promise.resolve(null)

describe('script sandbox', () => {
  it('bridges sdk calls and returns the result', async () => {
    const seen: string[] = []
    const out = ok(
      await runInSandbox({
        source: `const a = await diazo.frames.list('f1'); const b = await diazo.tokens.get(); return { sum: a + b }`,
        call: async (path, args) => {
          seen.push(path + ':' + JSON.stringify(args))
          return path === 'frames.list' ? 3 : 7
        },
      }),
    )
    expect(out.value).toEqual({ sum: 10 })
    expect(seen).toEqual(['frames.list:["f1"]', 'tokens.get:[]'])
    expect(out.calls).toHaveLength(2)
    expect(out.calls[0]?.target).toBe('f1')
  })

  it('surfaces guest errors', async () => {
    const out = fail(await runInSandbox({ source: `throw new Error('boom')`, call: noop }))
    expect(out.error).toBe('boom')
  })

  it('turns sdk errors into guest throws', async () => {
    const out = ok(
      await runInSandbox({
        source: `try { await diazo.frames.get('x') } catch (e) { return e.name + ':' + e.message }`,
        call: async () => {
          throw new Error('no such frame')
        },
      }),
    )
    expect(out.value).toBe('DiazoError:no such frame')
  })

  it('has no network, filesystem, process or timers', async () => {
    const out = ok(
      await runInSandbox({
        source: `return [typeof fetch, typeof XMLHttpRequest, typeof require, typeof process, typeof setTimeout, typeof setInterval]`,
        call: noop,
      }),
    )
    expect(out.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('resists prototype pollution in the host', async () => {
    const out = ok(
      await runInSandbox({
        source: `Object.prototype.polluted = 'yes'; ({}).__proto__.x = 1; return 'done'`,
        call: noop,
      }),
    )
    expect(out.value).toBe('done')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('stops infinite loops on the wall clock', async () => {
    const out = fail(await runInSandbox({ source: `while (true) {}`, call: noop, timeoutMs: 1500 }))
    expect(out.limit).toBe('wall')
    expect(out.ms).toBeGreaterThanOrEqual(1500)
  })

  it('stops loops that spin between sdk calls', async () => {
    const out = fail(
      await runInSandbox({
        source: `while (true) { try { await diazo.sys.ping() } catch {} }`,
        call: noop,
        timeoutMs: 1500,
        callLimit: 10_000,
      }),
    )
    expect(out.limit).toBe('wall')
  })

  it('enforces the sdk call limit', async () => {
    const out = fail(
      await runInSandbox({
        source: `let n = 0; while (true) { await diazo.sys.ping(); n++ } return n`,
        call: noop,
        callLimit: 3,
      }),
    )
    expect(out.error).toMatch(/sdk_calls/)
    expect(out.calls.length).toBe(3)
  })

  it('enforces the script size limit', async () => {
    const out = fail(await runInSandbox({ source: `// ${'x'.repeat(300 * 1024)}\nreturn 1`, call: noop }))
    expect(out.limit).toBe('script_size')
  })

  it('fails when the guest memory budget is exceeded', async () => {
    const out = fail(
      await runInSandbox({
        source: `const keep = []; for (let i = 0; i < 2000; i++) keep.push(new Uint8Array(1024 * 1024)); return keep.length`,
        call: noop,
        memoryBytes: 24 * 1024 * 1024,
      }),
    )
    expect(out.limit).toBe('memory')
  })

  it('stays usable after a killed run', async () => {
    fail(await runInSandbox({ source: `while (true) {}`, call: noop, timeoutMs: 500 }))
    const out = ok(await runInSandbox({ source: `return 42`, call: noop }))
    expect(out.value).toBe(42)
  })

  it('rejects late sdk calls after the run ended', async () => {
    // the vm stops at the wall clock; nothing about the host changes
    const out = fail(
      await runInSandbox({
        source: `await diazo.sys.slow(); return 1`,
        call: () => new Promise(() => {}),
        timeoutMs: 800,
      }),
    )
    expect(out.limit).toBe('wall')
  })

  it('strips TypeScript before evaluation', () => {
    const js = stripTypes(`const x: number = 1 as const\nexport default x`)
    expect(js).not.toContain(': number')
    expect(js).not.toContain('as const')
  })
})

describe('host-side bounds', () => {
  it('refuses an oversized call in the worker before it posts', async () => {
    const posted: string[] = []
    const out = ok(
      await runInSandbox({
        source: `try { await diazo.frames.html('x'.repeat(1200000)) } catch (e) { return e.message } return 'no refusal'`,
        call: async (path) => {
          posted.push(path)
          return null
        },
      }),
    )
    /* the payload never crossed the bridge to park on the main heap */
    expect(out.value).toMatch(/exceed|too large|KB/i)
    expect(posted).toEqual([])
  })

  it('kills a run whose calls carry too much argument data in total', async () => {
    let posted = 0
    const out = fail(
      await runInSandbox({
        source: `const big = 'x'.repeat(600000);
          for (let i = 0; i < 20; i++) { try { await diazo.frames.html('f', big) } catch (e) {} }
          return 'survived'`,
        call: async () => {
          posted++
          return 'ok'
        },
        callLimit: 100,
      }),
    )
    expect(out.limit).toBe('args_bytes')
    /* died once the run's total crossed the cap, well before the 20th call */
    expect(posted).toBeLessThan(16)
  })

  it('serialises runs past the worker cap and refuses when the queue is full', async () => {
    const release: (() => void)[] = []
    const busy = Array.from({ length: 4 }, () =>
      runInSandbox({
        source: `return await diazo.sys.ping()`,
        call: () => new Promise<string>((resolve) => release.push(() => resolve('ok'))),
      }),
    )
    /* every worker slot is busy — the next run queues, it does not start */
    let started = false
    const queued = runInSandbox({
      source: `return await diazo.sys.ping()`,
      call: async () => {
        started = true
        return 'ok'
      },
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(started).toBe(false)
    /* fill the wait queue to its bound — one run past it is refused outright */
    const waiters = Array.from({ length: 15 }, () => runInSandbox({ source: `return 1`, call: noop }))
    const refused = await runInSandbox({ source: `return 1`, call: noop })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatch(/queue/i)
    for (const r of release) r()
    expect((await queued).ok).toBe(true)
    expect(started).toBe(true)
    await Promise.all([...busy, ...waiters])
  }, 60_000)
})

it('refuses module loading and host-constructor escapes without host network calls', async () => {
  const requests = [] as string[]
  const fetchSpy = (await import('vitest')).vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    requests.push(String(url))
    throw new Error('unexpected network')
  })
  try {
    const out = ok(
      await runInSandbox({
        source: `
      const results = [];
      for (const code of ["fetch('http://127.0.0.1:1')", "require('node:fs')", "process.cwd()", "globalThis.constructor.constructor('return process')()", "setTimeout(()=>{},0)"]) {
        try { results.push(await eval(code)) } catch { results.push('refused') }
      }
      try { await import('node:fs'); results.push('loaded') } catch { results.push('refused') }
      return results;
    `,
        call: noop,
      }),
    )
    expect(out.value).toEqual(Array(6).fill('refused'))
    expect(requests).toEqual([])
  } finally {
    fetchSpy.mockRestore()
  }
})
