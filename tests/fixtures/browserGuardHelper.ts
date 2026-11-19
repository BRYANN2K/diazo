/**
 * Fixture for tests/browserGuard.test.ts — not a test itself.
 * Spawns a detached long-lived child (the stand-in "browser"), registers it
 * with the real guard, prints `guarded=<pid>` on stdout, then either
 *   exit-hook : exits immediately — the `exit` hook must reap the child
 *   watchdog  : stays alive — the test kills it with SIGKILL so only the
 *               detached watchdog can reap the child
 * Run under tsx: `tsx tests/fixtures/browserGuardHelper.ts <mode>`.
 */
import { spawn } from 'node:child_process'
import { guardProcessTree } from '../../server/browserGuard.ts'

const mode = process.argv[2] ?? 'exit-hook'

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  detached: true,
  stdio: 'ignore',
})
if (mode !== 'no-guard') guardProcessTree(child)
/* our own pid too: .bin/tsx is a shim that re-executes node as a child, so
   the pid a spawner knows is NOT the process the watchdog must outlive */
console.log(`helper=${process.pid} guarded=${child.pid}`)

/* brief stay so the test can observe the live child before we exit —
   the exit hook (or the watchdog) is what must reap it afterwards */
if (mode !== 'watchdog') setTimeout(() => process.exit(0), 500)
setInterval(() => {}, 60000)
