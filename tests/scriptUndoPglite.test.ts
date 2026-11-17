import { beforeEach, afterAll, expect, it, vi } from 'vitest'
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: vi.fn(),
  saveFrame: vi.fn(),
  saveActivity: vi.fn(),
  saveTask: vi.fn(),
  saveFrameVersion: vi.fn(),
  deleteFrame: vi.fn(),
  saveToken: vi.fn(),
  deleteToken: vi.fn(),
  saveComponent: vi.fn(),
  deleteComponent: vi.fn(),
  saveComposition: vi.fn(),
  deleteComposition: vi.fn(),
  saveCompositionVersion: vi.fn(),
  loadFrameHtml: async () => [],
}))
/* undo goes through the real JSONB round trip — Postgres and PGlite do not
   guarantee key order inside jsonb, which is exactly what order-sensitive
   equality used to choke on */
import type { PGlite } from '@electric-sql/pglite'
const holder = vi.hoisted(() => ({ client: undefined as unknown as PGlite }))
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  holder.client = new PGlite()
  return { db: drizzle(holder.client, { schema }), initDb: async () => {} }
})
import { readFile } from 'node:fs/promises'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { executeScript, revertScriptRun, type ScriptCaller } from '../server/scriptRunner.ts'
import { scriptRunDeps } from '../server/scriptRuns.ts'

beforeEach(async () => {
  await holder.client.exec('DROP TABLE IF EXISTS script_runs')
  await holder.client.exec(await readFile('server/db/migrations/0082_script_runs.sql', 'utf8'))
})
afterAll(async () => {
  await holder.client.close()
})

it('persists only touched entities and undoes them after the JSONB round trip', async () => {
  const canvas = store.createCanvas('Undo ' + Math.random(), 'owner')
  const actor = { kind: 'user' as const, name: 'Owner', color: '#000' }
  const caller: ScriptCaller = { canvasId: canvas.id, userId: 'owner', actor, source: 'mcp' }
  const frameId = actions.createFrame(
    canvas.id,
    {
      name: 'Home',
      html: '<html><body><h1 data-doop-id="title">Before</h1></body></html>',
      width: 800,
      height: 600,
    },
    actor,
  )!.id

  const result = await executeScript(
    {
      script: `await diazo.frames.edit(${JSON.stringify(frameId)}, [{op:'text',element:'title',text:'After'}]); await diazo.tokens.create([{name:'--ink',type:'color',value:'#123456'}])`,
    },
    caller,
    true,
  )
  expect(result.ok).toBe(true)

  /* what the durable row carries: the touched entities, no canvas snapshot */
  const stored = await scriptRunDeps.get(result.run_id)
  expect(stored?.undo?.map((e) => `${e.kind}:${e.id}`).sort()).toEqual([`frame:${frameId}`, 'token:--ink'])
  const { rows } = await holder.client.query<{ record: { sourceScript: string } }>(
    `SELECT record FROM script_runs WHERE id = $1`,
    [result.run_id],
  )
  expect(rows[0]!.record.sourceScript).toContain('frames.edit')

  /* a read-only run leaves no undo payload behind */
  const query = await executeScript({ script: `return await diazo.frames.list()` }, caller, false)
  expect((await scriptRunDeps.get(query.run_id))?.undo ?? null).toBeNull()

  const undoRows = await scriptRunDeps.list(canvas.id)
  expect(undoRows.map((r) => r.id)).toContain(result.run_id)

  /* the revert itself reads the JSONB-parsed entities back */
  const out = await revertScriptRun(result.run_id, caller)
  expect(out.unreverted).toEqual([])
  expect(store.getFrame(frameId)!.html).toContain('Before')
  expect(store.getTokens(canvas.id)).toEqual([])
  expect((await scriptRunDeps.get(result.run_id))?.record.outcome).toBe('reverted')
}, 60_000)

it("deletes a canvas's script runs when the canvas is deleted", async () => {
  const canvas = store.createCanvas('Cascade ' + Math.random(), 'owner')
  const actor = { kind: 'user' as const, name: 'Owner', color: '#000' }
  const caller: ScriptCaller = { canvasId: canvas.id, userId: 'owner', actor, source: 'mcp' }
  const run = await executeScript({ script: `return 1` }, caller, false)
  expect(run.ok).toBe(true)
  const { rows: before } = await holder.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_runs WHERE canvas_id = $1`,
    [canvas.id],
  )
  expect(before[0]!.n).toBeGreaterThan(0)
  /* persist.ts is mocked above — take the real module so the cascade runs */
  const real = await vi.importActual<typeof import('../server/db/persist.ts')>('../server/db/persist.ts')
  real.deleteCanvas(canvas.id)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const { rows: after } = await holder.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_runs WHERE canvas_id = $1`,
    [canvas.id],
  )
  expect(after[0]!.n).toBe(0)
})
