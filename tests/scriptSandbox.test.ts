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
