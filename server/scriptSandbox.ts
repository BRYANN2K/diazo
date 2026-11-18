/**
 * server/scriptSandbox.ts — the host half of the script sandbox (ADR 0015,
 * spec AC-7/8). Spawns the QuickJS worker, bridges its SDK calls to the
 * server's own functions, and owns the hard limits the guest cannot see:
 * the wall-clock deadline and the worker kill.
 *
 * Every run is one fresh worker — nothing carries between scripts. The
 * worker has no network, filesystem, process, module loader or timers; its
 * only capability is the `diazo` calls this file serves.
 */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

export const SCRIPT_LIMITS = {
  wallMs: 30_000,
  wallMsMax: 60_000,
  memoryBytes: 64 * 1024 * 1024,
  /** a caller may ask for more guest heap, never past this ceiling */
  memoryBytesMax: 256 * 1024 * 1024,
  sdkCalls: 200,
  frameWrites: 40,
  scriptBytes: 256 * 1024,
  resultBytes: 8 * 1024,
  resultBytesMax: 32 * 1024,
  /** serialized size of one SDK call's argument list */
  argsBytes: 1024 * 1024,
  /** serialized argument bytes across a whole run — the per-call cap alone
   *  lets a guest park unbounded payloads on the host heap */
  argsTotalBytes: 8 * 1024 * 1024,
  /** host-side memory for the PNGs checks.snapshot retains — compressed
   *  bytes plus raw pixels, per run */
  snapshotBytes: 64 * 1024 * 1024,
  /** operations in one frames.edit call */
  editOps: 64,
  /** QuickJS workers alive at once, across all canvases */
  workers: 4,
  /** runs waiting for a worker slot — past it, refuse instead of queueing */
  queueRuns: 16,
} as const

export type LimitName =
  'wall' | 'memory' | 'sdk_calls' | 'frame_writes' | 'script_size' | 'result_size' | 'args_bytes' | 'snapshot_bytes'

/** The limits that kill a run when an SDK call reports them. Anything else
 *  an SdkError carries — renderer, search, args_bytes, ops — is an ordinary
 *  call failure the script can catch, not a run-level kill. snapshot_bytes
 *  is host memory the guest heap never sees: exhausting it ends the run the
 *  same way `memory` does — the guest must not catch it and write on. */
const RUN_LIMITS = new Set<LimitName>([
  'wall',
  'memory',
  'sdk_calls',
  'frame_writes',
  'script_size',
  'result_size',
  'snapshot_bytes',
])

/** Global worker pool: per-canvas serialization does not stop N canvases
 *  from spawning N QuickJS workers at once, so the host caps them here. */
let liveWorkers = 0
const workerWaiters: (() => void)[] = []

function acquireWorker(): boolean | Promise<boolean> {
  if (liveWorkers < SCRIPT_LIMITS.workers) {
    liveWorkers++
    return true
  }
  /* the wait queue is bounded too — an unbounded queue is an unbounded
     promise list a single busy caller can grow without limit */
  if (workerWaiters.length >= SCRIPT_LIMITS.queueRuns) return false
  return new Promise<boolean>((resolve) => workerWaiters.push(() => resolve(true)))
}

function releaseWorker(): void {
  const next = workerWaiters.shift()
  if (next) next()
  else liveWorkers--
}

export interface SdkCallRecord {
  path: string
  /** the first string argument — the frame/token/etc. the call aimed at */
  target?: string
  ms: number
  ok: boolean
}

export interface SandboxRequest {
  /** JavaScript the worker evaluates inside one async function body */
  source: string
  /** bridge to server/scriptSdk.ts — resolves the call's return value */
  call: (path: string, args: unknown[]) => Promise<unknown>
  timeoutMs?: number
  memoryBytes?: number
  callLimit?: number
  paths?: string[]
  runInfo?: { runId: string; canvasId: string; dryRun: boolean }
  onClose?: () => void
}

export type SandboxOutcome =
  | { ok: true; value: unknown; ms: number; calls: SdkCallRecord[] }
  | { ok: false; error: string; name?: string; limit?: LimitName; ms: number; calls: SdkCallRecord[] }

/* scripts go through the render/browser queue the same way tool renders do —
   nothing here is a hot loop, so a shared pool is wasted machinery; one
   worker per run, created on demand */

export async function runInSandbox(req: SandboxRequest): Promise<SandboxOutcome> {
  /* a queued run's wall clock starts when its worker starts, not while it
     waits for a slot — and past the queue bound it is refused outright */
  if (!(await acquireWorker())) {
    return { ok: false, error: 'the script run queue is full', name: 'QueueFull', ms: 0, calls: [] }
  }
  const startedAt = Date.now()
  if (Buffer.byteLength(req.source, 'utf8') > SCRIPT_LIMITS.scriptBytes) {
    releaseWorker()
    return {
      ok: false,
      error: 'the script is too large',
      name: 'ScriptSizeError',
      limit: 'script_size',
      ms: 0,
      calls: [],
    }
  }
  const timeout = Math.max(250, Math.min(req.timeoutMs ?? SCRIPT_LIMITS.wallMs, SCRIPT_LIMITS.wallMsMax))
  const deadline = startedAt + timeout
  const calls: SdkCallRecord[] = []

  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  const entry = new URL('./scriptWorker.ts', import.meta.url).href
  const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(entry)});`
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(bootstrap)), {
    stderr: false,
    /* the worker thread's own V8 heap is bounded too: the wasm linear
       memory is capped separately, but tsx, the module and every posted
       payload still live on this heap */
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  })

  return new Promise<SandboxOutcome>((resolve) => {
    let settled = false
    /* grace after the in-VM deadline, then the worker is killed outright */
    const kill = setTimeout(
      () => finish({ ok: false, error: 'wall', limit: 'wall', ms: Date.now() - startedAt, calls }),
      timeout + 500,
    )

    const finish = (outcome: SandboxOutcome) => {
      if (settled) return
      settled = true
      req.onClose?.()
      clearTimeout(kill)
      void worker.terminate()
      releaseWorker()
      resolve(outcome)
    }

    worker.on('message', (msg: { type: string; [k: string]: unknown }) => {
      if (msg.type === 'sdk-call') {
        if (settled) return
        if (Date.now() >= deadline) {
          finish({ ok: false, error: 'wall limit reached', limit: 'wall', ms: Date.now() - startedAt, calls })
          return
        }
        if (calls.length >= (req.callLimit ?? SCRIPT_LIMITS.sdkCalls)) {
          finish({ ok: false, error: 'sdk_calls limit reached', limit: 'sdk_calls', ms: Date.now() - startedAt, calls })
          return
        }
        const seq = msg.seq as number
        const path = msg.path as string
        const args = (msg.args as unknown[]) ?? []
        const at = Date.now()
        req
          .call(path, args)
          .then((value) => {
            calls.push({
              path,
              target: typeof args[0] === 'string' ? args[0] : undefined,
              ms: Date.now() - at,
              ok: true,
            })
            safePost({
              type: 'sdk-result',
              seq,
              ok: true,
              json: JSON.stringify({ value: value === undefined ? null : value }),
            })
          })
          .catch((error: unknown) => {
            /* only a run-level limit kills the run — a renderer, search or
               argument failure is this call's error and the script sees it */
            const limit =
              error && typeof error === 'object' && 'limit' in error && error.limit
                ? (error.limit as LimitName)
                : undefined
            if (limit && RUN_LIMITS.has(limit)) {
              calls.push({
                path,
                target: typeof args[0] === 'string' ? args[0] : undefined,
                ms: Date.now() - at,
                ok: false,
              })
              finish({
                ok: false,
                error: String(limit) + ' limit reached',
                limit,
                ms: Date.now() - startedAt,
                calls,
              })
              return
            }
            calls.push({
              path,
              target: typeof args[0] === 'string' ? args[0] : undefined,
              ms: Date.now() - at,
              ok: false,
            })
            safePost({
              type: 'sdk-result',
              seq,
              ok: false,
              json: JSON.stringify({
                __error: errorMessage(error),
                code: error && typeof error === 'object' && 'code' in error ? error.code : 'failed',
              }),
            })
          })
        return
      }
      if (msg.type === 'done') {
        let value: unknown = null
        try {
          value = JSON.parse(String(msg.json ?? 'null'))
        } catch {
          /* a broken payload means a bad script result — the run still succeeded */
        }
        finish({ ok: true, value, ms: Date.now() - startedAt, calls })
        return
      }
      if (msg.type === 'error') {
        finish({
          ok: false,
          error: String(msg.message ?? 'the script failed'),
          ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
          ...(typeof msg.limit === 'string' ? { limit: msg.limit as LimitName } : {}),
          ms: Date.now() - startedAt,
          calls,
        })
      }
    })
    worker.on('error', (error) => {
      finish({ ok: false, error: errorMessage(error), ms: Date.now() - startedAt, calls })
    })
    worker.on('exit', (code) => {
      if (code !== 0 && !settled) {
        finish({
          ok: false,
          error: 'the sandbox worker exited',
          ...(Date.now() > deadline ? { limit: 'wall' as const } : {}),
          ms: Date.now() - startedAt,
          calls,
        })
      }
    })
    const safePost = (msg: unknown) => {
      try {
        worker.postMessage(msg)
      } catch {
        /* the worker is already gone — the run is finishing anyway */
      }
    }
    worker.postMessage({
      source: req.source,
      paths: req.paths,
      runInfo: req.runInfo,
      deadline,
      memoryBytes: Math.min(req.memoryBytes ?? SCRIPT_LIMITS.memoryBytes, SCRIPT_LIMITS.memoryBytesMax),
      callLimit: req.callLimit ?? SCRIPT_LIMITS.sdkCalls,
      argsBytes: SCRIPT_LIMITS.argsBytes,
      argsTotalBytes: SCRIPT_LIMITS.argsTotalBytes,
    } satisfies Record<string, unknown>)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Scripts are TypeScript for agents — esbuild strips the annotations once,
 *  before the sandbox ever sees the source. */
export function stripTypes(source: string): string {
  return transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code
}
