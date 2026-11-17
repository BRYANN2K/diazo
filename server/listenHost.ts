import { env } from './env.ts'

/** The interface the server binds. An explicit DOOP_LISTEN_HOST always
 *  wins; the embedded sidecar defaults to loopback, so a shell that
 *  forgets the flag never exposes the server to the network; anything
 *  else keeps the container's all-interfaces default (undefined = bind
 *  every interface). */
export function listenHost(): string | undefined {
  return env.DOOP_LISTEN_HOST ?? (env.DOOP_EMBEDDED ? '127.0.0.1' : undefined)
}
