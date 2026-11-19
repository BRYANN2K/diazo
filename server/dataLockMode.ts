import type { LockMode } from './dataLock.ts'
import { env } from './env.ts'

/** The lock mode this install runs under.
 *
 *  DOOP_DATA_LOCK wins when set. Without it: a managed install
 *  (DATABASE_URL — its state lives in Postgres and object storage, not
 *  the data dir) locks nothing; the embedded sidecar is strict because
 *  its data dir is the user's only copy and a silent takeover must ask
 *  first; a local checkout or a container install takes a dead claim
 *  over, which is the reboot path its operator expects. */
export function resolveLockMode(): LockMode | 'off' {
  if (env.DOOP_DATA_LOCK) return env.DOOP_DATA_LOCK
  if (env.DATABASE_URL) return 'off'
  return env.DOOP_EMBEDDED ? 'strict' : 'takeover'
}
