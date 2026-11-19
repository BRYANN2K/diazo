import { env } from './env.ts'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import { pglite } from './db/index.ts'

/**
 * The way down: flush debounced frame writes, close the render browser and
 * the embedded database before the process dies — with a hard-exit timeout
 * so a wedged DB can never keep the process (and the port) alive. The
 * browser's process group is also reaped by an `exit` hook in
 * server/browserGuard.ts and, off containers, by its kill -9 watchdog.
 */

let started = false

export function installShutdown(): void {
  const shutdown = (): void => {
    if (started) return
    started = true
    setTimeout(() => process.exit(0), 1500).unref()
    void settleShutdown(
      persist.flush((id) => store.getFrame(id)),
      import('./screenshot.ts').then((m) => m.shutdownRenderer()),
    ).then(() => process.exit(0))
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, shutdown)

  /* the desktop shell spawns the server as a sidecar over piped stdio: the
     app dying closes our stdin — leave with it, through the same flush the
     signals get (DOOP_EMBEDDED). The flag is for that piped sidecar only:
     under systemd, launchd or nohup stdin is /dev/null and 'end' fires at
     once, ending the server as soon as it starts */
  if (env.DOOP_EMBEDDED) {
    process.stdin.resume()
    process.stdin.once('end', shutdown)
    process.stdin.once('close', shutdown)
  }
}

/** The last frame writes and the renderer close settle together — the db
 *  close waits for both, since closing mid-flush drops the writes the
 *  flush exists to save. A flush failure is logged, not swallowed: a bare
 *  Promise.allSettled would hide it behind a clean exit. */
export function settleShutdown(flush: Promise<unknown>, closeRenderer: Promise<unknown>): Promise<unknown> {
  return Promise.allSettled([
    flush.catch((error: unknown) => console.error('[persist] flush on shutdown failed', error)),
    closeRenderer,
  ]).then(() => (pglite()?.close() ?? Promise.resolve()).catch(() => {}))
}
