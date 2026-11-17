import { beforeEach, expect, it, vi } from 'vitest'
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
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { executeScript, revertScriptRun, scriptRunRate, type ScriptCaller } from '../server/scriptRunner.ts'
import { scriptRunDeps, type StoredScriptRun } from '../server/scriptRuns.ts'
import { reloadEnv } from '../server/env.ts'

let caller: ScriptCaller
let frameId: string
let rows: Map<string, StoredScriptRun>
beforeEach(() => {
  rows = new Map()
  vi.spyOn(scriptRunDeps, 'save').mockImplementation(async (run) => {
    rows.set(run.record.id, structuredClone(run))
  })
  vi.spyOn(scriptRunDeps, 'get').mockImplementation(async (id) => structuredClone(rows.get(id)))
  vi.spyOn(scriptRunDeps, 'byKey').mockImplementation(async (canvas, key) =>
    structuredClone([...rows.values()].find((r) => r.record.canvasId === canvas && r.record.idempotencyKey === key)),
  )
  const canvas = store.createCanvas('Scripts', 'owner')
  const actor = { kind: 'user' as const, name: 'Owner', color: '#000' }
  frameId = actions.createFrame(
    canvas.id,
    { name: 'Home', html: '<html><body><h1 data-doop-id="title">Before</h1></body></html>', width: 800, height: 600 },
    actor,
  )!.id
  caller = { canvasId: canvas.id, userId: 'owner', actor, source: 'mcp' }
})
const edit = () => `await diazo.frames.edit(${JSON.stringify(frameId)}, [{op:'text',element:'title',text:'After'}]);`

it('executes TypeScript, audits, reviews and undoes the whole run', async () => {
  const before = store.getFrame(frameId)!.html
  const result = await executeScript({ script: edit() + ' const answer: number = 42; return answer' }, caller, true)
  expect(result).toMatchObject({ ok: true, result: 42, truncated: false })
  expect(result.checks[frameId]).toHaveProperty('lint')
  expect(store.getFrame(frameId)!.html).toContain('After')
  expect(rows.get(result.run_id)!.record.calls[0]!.fn).toBe('frames.edit')
  expect(actions.getActivity(caller.canvasId).filter((a) => a.scriptRunId === result.run_id)).toHaveLength(1)
  await revertScriptRun(result.run_id, caller)
  expect(store.getFrame(frameId)!.html).toBe(before)
  expect(rows.get(result.run_id)!.record.outcome).toBe('reverted')
})

it('automatically restores frame and token changes on an exception', async () => {
  const before = structuredClone(store.getCanvas(caller.canvasId))
  const result = await executeScript(
    {
      script:
        edit() + `await diazo.tokens.create([{name:'--ink',type:'color',value:'#123456'}]); throw new Error('boom')`,
    },
    caller,
    true,
  )
  expect(result).toMatchObject({ ok: false, error: 'boom' })
  expect(store.getFrame(frameId)!.html).toBe(before!.frames[0]!.html)
  expect(store.getTokens(caller.canvasId)).toEqual([])
})

it('serializes concurrent idempotent calls and reuses the durable response', async () => {
  const input = { script: edit() + ' return 1', idempotency_key: 'same' }
  const results = await Promise.all([executeScript(input, caller, true), executeScript(input, caller, true)])
  expect(results[0]!.ok).toBe(true)
  expect(results[1]).toMatchObject({ run_id: results[0]!.run_id, deduplicated: true })
  expect(rows.size).toBe(1)
})

it('dry-run edits compose without store writes', async () => {
  const before = JSON.stringify(store.getCanvas(caller.canvasId))
  const result = await executeScript(
    { script: edit() + `return await diazo.frames.html('${frameId}')`, dry_run: true },
    caller,
    true,
  )
  expect(result).toMatchObject({ ok: true, dry_run: true })
  expect(result.result).toContain('After')
  expect(result.writes).toHaveLength(1)
  expect(JSON.stringify(store.getCanvas(caller.canvasId))).toBe(before)
})

it('query has no write function and even the raw bridge refuses writes', async () => {
  const result = await executeScript({ script: 'return typeof diazo.frames.edit' }, caller, false)
  expect(result.result).toBe('undefined')
  const raw = await executeScript(
    {
      script: `return await __diazo_call('frames.edit', '${JSON.stringify([frameId, [{ op: 'text', element: 'title', text: 'No' }]])}')`,
    },
    caller,
    false,
  )
  expect(raw.result).toContain('read-only')
  expect(store.getFrame(frameId)!.html).toContain('Before')
})

it('reports a later edit as unreverted while restoring what it can', async () => {
  const result = await executeScript(
    {
      script: edit() + `await diazo.tokens.create([{name:'--ink',type:'color',value:'#123456'}])`,
    },
    caller,
    true,
  )
  expect(result.ok).toBe(true)
  const before = rows.get(result.run_id)!.undo!
  expect(before.map((e) => `${e.kind}:${e.id}`).sort()).toEqual([`frame:${frameId}`, 'token:--ink'])
  /* the collaborator touched only the token — the frame still reverts */
  const canvas = store.getCanvas(caller.canvasId)!
  canvas.tokens = canvas.tokens!.map((t) => (t.name === '--ink' ? { ...t, value: '#654321' } : t))
  const out = await revertScriptRun(result.run_id, caller)
  expect(out.unreverted).toEqual(['token:--ink'])
  expect(out.restored).toEqual([`frame:${frameId}`])
  expect(store.getFrame(frameId)!.html).toContain('Before')
  expect(store.getTokens(caller.canvasId).find((t) => t.name === '--ink')?.value).toBe('#654321')
  expect(rows.get(result.run_id)!.record.outcome).toBe('reverted_partial')
})

it('bounds multibyte results, records full bytes and validates a raised cap', async () => {
  const result = await executeScript({ script: `return 'é'.repeat(9000)`, result_cap: 100 }, caller, false)
  expect(result.truncated).toBe(true)
  expect(rows.get(result.run_id)!.record.resultBytes).toBe(18002)
  await expect(executeScript({ script: 'return 1', result_cap: 32769 }, caller, false)).rejects.toThrow(/result_cap/)
})

it('rolls back writes after wall and frame-write limits', async () => {
  const before = store.getFrame(frameId)!.html
  const wall = await executeScript({ script: edit() + ' while(true) {}', timeout_ms: 1000 }, caller, true)
  expect(wall).toMatchObject({ ok: false, code: 'limit' })
  expect(store.getFrame(frameId)!.html).toBe(before)
  const writes = await executeScript({ script: `for(let i=0;i<41;i++) { ${edit()} }` }, caller, true)
  expect(writes).toMatchObject({ ok: false, code: 'limit' })
  expect(writes.error).toMatch(/frame_writes/)
  expect(store.getFrame(frameId)!.html).toBe(before)
})

it('refuses scripts when disabled and canvas access after revocation', async () => {
  vi.stubEnv('DOOP_AGENT_SCRIPTS', 'false')
  reloadEnv()
  await expect(executeScript({ script: 'return 1' }, caller, false)).rejects.toThrow(/disabled/)
  vi.unstubAllEnvs()
  reloadEnv()
  await expect(executeScript({ script: 'return 1' }, { ...caller, userId: 'stranger' }, false)).rejects.toThrow(
    /access/,
  )
})

it('refuses runs past the per-account rate', async () => {
  const other = store.createCanvas('Rate', 'rate-user')
  const rateCaller: ScriptCaller = { ...caller, canvasId: other.id, userId: 'rate-user' }
  const max = scriptRunRate.max
  scriptRunRate.max = 2
  try {
    expect((await executeScript({ script: 'return 1' }, rateCaller, false)).ok).toBe(true)
    expect((await executeScript({ script: 'return 1' }, rateCaller, false)).ok).toBe(true)
    await expect(executeScript({ script: 'return 1' }, rateCaller, false)).rejects.toThrow(/rate/i)
  } finally {
    scriptRunRate.max = max
  }
})
