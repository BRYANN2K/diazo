import { env } from './env.ts'

/** The interface the server binds. The embedded sidecar binds loopback,
 *  always — DOOP_LISTEN_HOST cannot widen it: the piped shell is exactly
 *  where a forgotten or inherited flag would expose the server to the
 *  network, so a conflicting value is warned about and ignored. Every
 *  other install keeps the override, unset meaning every interface, as
 *  the container needs. */
export function listenHost(): string | undefined {
  if (env.DOOP_EMBEDDED) {
    const want = env.DOOP_LISTEN_HOST
    if (want && want !== '127.0.0.1' && want !== '::1' && want !== 'localhost') {
      console.warn(`[server] DOOP_LISTEN_HOST=${want} ignored — the embedded server binds loopback only`)
    }
    return '127.0.0.1'
  }
  return env.DOOP_LISTEN_HOST ?? undefined
}
