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
  sdkCalls: 200,
  frameWrites: 40,
  scriptBytes: 256 * 1024,
  resultBytes: 8 * 1024,
  resultBytesMax: 32 * 1024,
} as const

export type LimitName = 'wall' | 'memory' | 'sdk_calls' | 'frame_writes' | 'script_size' | 'result_size'

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
  const startedAt = Date.now()
  if (Buffer.byteLength(req.source, 'utf8') > SCRIPT_LIMITS.scriptBytes) {
    return {
      ok: false,
      error: 'the script is too large',
      name: 'ScriptSizeError',
      limit: 'script_size',
      ms: 0,
      calls: [],
    }
  }
  const timeout = Math.min(req.timeoutMs ?? SCRIPT_LIMITS.wallMs, SCRIPT_LIMITS.wallMsMax)
  const deadline = startedAt + timeout
  const calls: SdkCallRecord[] = []

  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  const entry = new URL('./scriptWorker.ts', import.meta.url).href
  const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(entry)});`
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(bootstrap)), { stderr: false })

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
            if (error && typeof error === 'object' && 'limit' in error && error.limit) {
              finish({
                ok: false,
                error: String(error.limit) + ' limit reached',
                limit: error.limit as LimitName,
                ms: Date.now() - startedAt,
                calls,
              })
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
      memoryBytes: req.memoryBytes ?? SCRIPT_LIMITS.memoryBytes,
      callLimit: req.callLimit ?? SCRIPT_LIMITS.sdkCalls,
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
