/**
 * server/scriptWorker.ts — the guest half of the script sandbox (ADR 0015,
 * spec AC-7/8). One worker, one fresh QuickJS context, one script.
 *
 * The context is an empty WASM realm: no fetch, require, import(), process,
 * filesystem, timers or host objects. Its only capability is `diazo`, wired
 * to `__diazo_call` — a synchronous host function that returns a deferred
 * promise. Guest `await`s therefore never suspend the WASM module (asyncify
 * cannot suspend inside executePendingJobs); the run advances by pumping
 * pending jobs whenever the module is idle.
 *
 * Protocol (parent -> worker):   { source, deadline, memoryBytes, callLimit }
 * Protocol (worker -> parent):   { type:'sdk-call', seq, path, args }
 *                                { type:'done', json } | { type:'error', name, message, limit? }
 * The host answers each sdk-call with { type:'sdk-result', seq, ok, json }.
 */
import { parentPort } from 'node:worker_threads'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
} from 'quickjs-emscripten'

interface RunRequest {
  source: string
  /** epoch ms — the interrupt handler fails the run past it */
  deadline: number
  memoryBytes: number
  callLimit: number
  paths?: string[]
  runInfo?: unknown
}

interface SdkResult {
  type: 'sdk-result'
  seq: number
  ok: boolean
  json: string
}

if (!parentPort) throw new Error('scriptWorker must run inside a worker thread')
const port = parentPort

const pending = new Map<number, QuickJSDeferredPromise>()
let seq = 0
let callCount = 0
let callLimit = 0
let callsOpen = true
let deadline = 0

/** Builds `diazo` inside the guest: diazo.<ns>.<fn>(...args) -> Promise<value>. */
const PRELUDE = `
Object.defineProperty(globalThis, 'diazo', {
  writable: false, configurable: false, enumerable: false,
  value: new Proxy({}, {
    get: (t, ns) => new Proxy({}, {
      get: (t2, fn) => (...args) =>
        __diazo_call(String(ns) + '.' + String(fn), JSON.stringify(args))
          .then((json) => {
            const out = JSON.parse(json)
            if (out && out.__error) { const e = new Error(out.__error); e.name = 'DiazoError'; e.code = out.code || 'failed'; throw e }
            return out ? out.value : undefined
          }),
    }),
  }),
})`

function preludeFor(req: RunRequest): string {
  if (!req.paths) return PRELUDE
  return (
    `const diazo = Object.create(null);
` +
    req.paths
      .map((path) => {
        const [ns, fn] = path.split('.')
        return `diazo[${JSON.stringify(ns)}] ??= Object.create(null); diazo[${JSON.stringify(ns)}][${JSON.stringify(fn)}] = (...args) => __diazo_call(${JSON.stringify(path)}, JSON.stringify(args)).then(json => { const out = JSON.parse(json); if(out.__error) { const e = new Error(out.__error); e.name = 'DiazoError'; e.code = out.code; throw e } return out.value });`
      })
      .join('\n') +
    `\ndiazo.run = ${JSON.stringify(req.runInfo ?? {})}; Object.values(diazo).forEach(Object.freeze); Object.freeze(diazo);`
  )
}

function installDiazoCall(ctx: QuickJSContext): void {
  const fn = ctx.newFunction('__diazo_call', (pathH, argsH) => {
    const path = ctx.getString(pathH)
    const argsJson = ctx.getString(argsH)
    const deferred = ctx.newPromise()
    callCount += 1
    if (!callsOpen) {
      deferredJson(ctx, deferred, { __error: 'the run already ended' })
    } else if (callCount > callLimit) {
      callsOpen = false
      port.postMessage({ type: 'error', message: 'sdk_calls limit reached', limit: 'sdk_calls' })
      deferredJson(ctx, deferred, { __error: 'sdk_calls limit reached' })
    } else {
      pending.set(seq, deferred)
      port.postMessage({ type: 'sdk-call', seq, path, args: JSON.parse(argsJson) })
      seq += 1
    }
    return deferred.handle
  })
  ctx.setProp(ctx.global, '__diazo_call', fn)
  fn.dispose()
}

/* the deferred always resolves with a json string; the guest .then turns
   {__error} into a thrown DiazoError, keeping one error path */
function deferredJson(ctx: QuickJSContext, deferred: QuickJSDeferredPromise, payload: unknown): void {
  const handle = ctx.newString(JSON.stringify(payload))
  deferred.resolve(handle)
  handle.dispose()
}

const WASM_PAGE = 64 * 1024

async function run(req: RunRequest): Promise<void> {
  callLimit = req.callLimit
  deadline = req.deadline
  /* setMemoryLimit counts but does not enforce in this build — the hard wall
     is a linear memory with a fixed maximum: past it, wasm allocation fails
     and the guest sees a catchable "out of memory" it cannot grow around */
  /* the module itself needs 256 pages to boot — the real floor is 16 MB */
  const maxPages = Math.max(256, Math.ceil(req.memoryBytes / WASM_PAGE))
  const bounded = newVariant(variant, {
    wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: maxPages }),
  })
  const ctx = (await newQuickJSWASMModuleFromVariant(bounded)).newContext()
  try {
    /* one interrupt check per few ops: the wall clock is the backstop the
       host's kill reinforces */
    ctx.runtime.setInterruptHandler(() => Date.now() > deadline)
    installDiazoCall(ctx)

    /* the guest serializes its own return value: a plain string crosses the
       boundary without dump()'s deep traversal */
    const evalRes = ctx.evalCode(
      `${preludeFor(req)}\n;(async () => {\nconst __v = await (async () => {\n${req.source}\n})()\nreturn JSON.stringify(__v === undefined ? null : __v)\n})()`,
      'script.ts',
    )
    const handle = ctx.unwrapResult(evalRes)
    try {
      /* promise continuations run only when jobs are pumped; while a script
         awaits a diazo call the module is idle, so pumping is always legal */
      const settledP = ctx.resolvePromise(handle)
      let done = false
      void settledP.finally(() => {
        done = true
      })
      while (!done) {
        if (Date.now() > deadline) throw new Error('interrupted')
        const result = ctx.runtime.executePendingJobs()
        if (result.error) throw ctx.dump(result.error)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const settled = await settledP
      const final = ctx.unwrapResult(settled)
      try {
        port.postMessage({ type: 'done', json: ctx.getString(final) })
      } finally {
        final.dispose()
      }
    } finally {
      handle.dispose()
    }
  } catch (error) {
    reportError(error)
  } finally {
    callsOpen = false
    for (const deferred of pending.values()) deferredJson(ctx, deferred, { __error: 'the run ended' })
    pending.clear()
    try {
      ctx.dispose()
    } catch {
      /* an aborted VM may refuse disposal — the worker dies with it anyway */
    }
  }
}

function reportError(error: unknown): void {
  let name = 'Error'
  let message = String(error)
  /* QuickJS errors surface as {name,message,stack} when dumped */
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string }
    if (e.name) name = e.name
    if (e.message) message = e.message
  }
  const limit =
    Date.now() > deadline || /interrupted/i.test(message)
      ? 'wall'
      : /out of memory|memory/i.test(name + ' ' + message)
        ? 'memory'
        : undefined
  port.postMessage({ type: 'error', name, message, ...(limit ? { limit } : {}) })
}

port.on('message', (msg: RunRequest | SdkResult) => {
  if ((msg as SdkResult).type === 'sdk-result') {
    const res = msg as SdkResult
    const deferred = pending.get(res.seq)
    if (!deferred) return
    pending.delete(res.seq)
    const handle = deferred.context.newString(res.json)
    deferred.resolve(handle)
    handle.dispose()
    return
  }
  const req = msg as RunRequest
  if (req.source) void run(req)
})
