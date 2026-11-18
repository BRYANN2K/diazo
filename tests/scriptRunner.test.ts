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
  saveFrameNow: vi.fn(async () => {}),
  loadFrameHtml: async () => [],
}))
vi.mock('../shared/canonicalJson.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../shared/canonicalJson.ts')>()
  return { ...orig, canonicalJson: vi.fn(orig.canonicalJson) }
})
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { canonicalJson } from '../shared/canonicalJson.ts'
import {
  executeScript,
  revertScriptRun,
  scriptCanvasQueue,
  scriptRunRate,
  serializeScript,
  type ScriptCaller,
} from '../server/scriptRunner.ts'
import { scriptRunDeps, type StoredScriptRun } from '../server/scriptRuns.ts'
import { reloadEnv } from '../server/env.ts'
import { canvasPages } from '../shared/pages.ts'
import * as motionJobs from '../server/motionJobs.ts'
import * as persist from '../server/db/persist.ts'

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

it('reverts a token theme change like any other write', async () => {
  actions.setTokenThemes(caller.canvasId, ['light', 'dark'], caller.actor)
  const result = await executeScript({ script: `await diazo.tokens.themes(['light', 'dark', 'sepia'])` }, caller, true)
  expect(result.ok).toBe(true)
  expect(store.getCanvas(caller.canvasId)!.tokenThemes).toEqual(['light', 'dark', 'sepia'])
  const out = await revertScriptRun(result.run_id, caller)
  expect(out.unreverted).toEqual([])
  expect(out.restored).toEqual(['tokenThemes'])
  expect(store.getCanvas(caller.canvasId)!.tokenThemes).toEqual(['light', 'dark'])
})

it('a failed run leaves no token theme write behind', async () => {
  const result = await executeScript(
    { script: `await diazo.tokens.themes(['sepia']); throw new Error('boom')` },
    caller,
    true,
  )
  expect(result).toMatchObject({ ok: false, error: 'boom' })
  expect(result.unreverted ?? []).toEqual([])
  expect(store.getCanvas(caller.canvasId)!.tokenThemes).toBeUndefined()
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

it('serialises only the entities a write touched for undo', async () => {
  /* a frame the run never changes: under the old whole-canvas diff its html
     was canonicalised twice for every write */
  actions.createFrame(
    caller.canvasId,
    { name: 'Other', html: '<p>x</p>'.repeat(500), width: 100, height: 100 },
    caller.actor,
  )
  const canon = vi.mocked(canonicalJson)
  canon.mockClear()
  const result = await executeScript({ script: edit() }, caller, true)
  expect(result.ok).toBe(true)
  /* the lazy pre-image never reaches JSON on a scalar-only change */
  expect(canon).not.toHaveBeenCalled()
})

it('reverts writes and frees the idempotency key when the audit row is refused', async () => {
  const before = store.getFrame(frameId)!.html
  /* an own account — the suite's shared caller would hit the per-minute rate */
  store.setLinkAccess(caller.canvasId, 'edit')
  const auditCaller: ScriptCaller = {
    ...caller,
    userId: 'audit-user',
    actor: { kind: 'user', name: 'Aud', color: '#000' },
  }
  /* the bare record lands, then the full row (response + undo) is refused.
     The refusal carries bound values — the response and the logs must show
     an opaque run reference, never the driver's parameters */
  let saves = 0
  vi.spyOn(scriptRunDeps, 'save').mockImplementation(async (run) => {
    saves++
    if (saves > 1) throw new Error('insert script_runs — params: ["SECRET-MARKER-42","<html>…"]')
    rows.set(run.record.id, structuredClone(run))
  })
  const released: string[] = []
  vi.spyOn(scriptRunDeps, 'release').mockImplementation(async (id) => {
    released.push(id)
    const row = rows.get(id)
    if (row) row.record.idempotencyKey = null
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = await executeScript({ script: edit(), idempotency_key: 'k1' }, auditCaller, true)
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/could not be audited/)
  expect(result.error).toContain(result.run_id)
  expect(result.error).not.toContain('SECRET-MARKER-42')
  for (const args of errorSpy.mock.calls) for (const arg of args) expect(String(arg)).not.toContain('SECRET-MARKER-42')
  expect(store.getFrame(frameId)!.html).toBe(before)
  expect(released).toEqual([result.run_id])
  /* the key is free — a retry is not locked out by the dead row */
  saves = 0
  const retry = await executeScript({ script: `return 7`, idempotency_key: 'k1' }, auditCaller, true)
  expect(retry.ok).toBe(false)
  expect(retry.error).not.toMatch(/interrupted|conflict/i)
  errorSpy.mockRestore()
})

it('refuses the run unaudited when the first audit save fails, without the parameters', async () => {
  vi.spyOn(scriptRunDeps, 'save').mockRejectedValue(
    new Error('insert script_runs — params: ["SECRET-MARKER-42","<html>…"]'),
  )
  store.setLinkAccess(caller.canvasId, 'edit')
  const firstSaveCaller: ScriptCaller = {
    ...caller,
    userId: 'first-save-user',
    actor: { kind: 'user', name: 'Fs', color: '#000' },
  }
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = await executeScript({ script: 'return 1' }, firstSaveCaller, true).catch((e: Error) => e)
  expect(error.message).toMatch(/could not be audited/)
  expect(error.message).not.toContain('SECRET-MARKER-42')
  for (const args of errorSpy.mock.calls) for (const arg of args) expect(String(arg)).not.toContain('SECRET-MARKER-42')
  errorSpy.mockRestore()
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

it('counts a run against the rate when it arrives, not when it starts', async () => {
  const owned = store.createCanvas('Queued', 'queue-user')
  const qCaller: ScriptCaller = {
    canvasId: owned.id,
    userId: 'queue-user',
    actor: { kind: 'user', name: 'Queuer', color: '#000' },
    source: 'mcp',
  }
  const max = scriptRunRate.max
  scriptRunRate.max = 2
  try {
    /* hold the canvas queue — the two runs below are still waiting when the
       third arrives, yet all three must count against the caller's minute */
    let release!: () => void
    const held = serializeScript(owned.id, () => new Promise<void>((resolve) => (release = resolve)))
    const r1 = executeScript({ script: 'return 1' }, qCaller, false)
    const r2 = executeScript({ script: 'return 2' }, qCaller, false)
    await expect(executeScript({ script: 'return 3' }, qCaller, false)).rejects.toThrow(/rate/i)
    release()
    expect((await r1).ok).toBe(true)
    expect((await r2).ok).toBe(true)
    await held
  } finally {
    scriptRunRate.max = max
  }
})

it('caps the runs pending on one canvas', async () => {
  const maxPending = scriptCanvasQueue.maxPending
  scriptCanvasQueue.maxPending = 2
  try {
    let release!: () => void
    const held = serializeScript(caller.canvasId, () => new Promise<void>((resolve) => (release = resolve)))
    const waiting = executeScript({ script: 'return 1' }, caller, false)
    /* the queue holds one running and one waiting run — the next is refused */
    await expect(executeScript({ script: 'return 2' }, caller, false)).rejects.toThrow(/queued/i)
    release()
    expect((await waiting).ok).toBe(true)
    await held
    /* a freed slot accepts the next run again */
    expect((await executeScript({ script: 'return 3' }, caller, false)).ok).toBe(true)
  } finally {
    scriptCanvasQueue.maxPending = maxPending
  }
})

it('reaches no network from the SDK in either script mode', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  try {
    /* the escape attempt: no diazo.search namespace exists to bridge out,
       and the guest itself still has no fetch */
    const query = await executeScript(
      { script: 'return {search: typeof diazo.search, fetch: typeof fetch}' },
      caller,
      false,
    )
    expect(query.result).toEqual({ search: 'undefined', fetch: 'undefined' })
    const write = await executeScript({ script: edit() + 'return typeof diazo.search' }, caller, true)
    expect(write.result).toBe('undefined')
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
  }
})

it('rejects an excluded render job on both script transports and queues none', async () => {
  /* give the page a real composition: a surviving handler would reach the
     job queue, so "no job" can only mean the path is gone */
  const canvas = store.getCanvas(caller.canvasId)!
  const pageId = canvasPages(canvas)[0]!.id
  canvas.compositions = [{ id: 'c1', canvasId: canvas.id, pageId, revision: 1 } as never]
  const created = vi
    .spyOn(motionJobs, 'createRenderJob')
    .mockImplementation(() => ({ ok: true, job: { id: 'j1' } }) as never)
  try {
    const query = await executeScript({ script: 'return typeof diazo.compositions.render' }, caller, false)
    expect(query.result).toBe('undefined')
    const write = await executeScript(
      { script: `await diazo.compositions.render(${JSON.stringify(pageId)})` },
      caller,
      true,
    )
    expect(write.ok).toBe(false)
    expect(write.error).toMatch(/render|not a function|undefined/i)
    expect(created).not.toHaveBeenCalled()
  } finally {
    created.mockRestore()
  }
})

it('an idempotency key replays only the identical request', async () => {
  /* a shared-edit canvas: every editor can read the key list, so replay is
     scoped by principal + mode + script — never by key alone */
  store.setLinkAccess(caller.canvasId, 'edit')
  const key = 'seen-in-usage'
  const script = edit() + 'return 1'
  const first = await executeScript({ script, idempotency_key: key }, caller, true)
  expect(first.ok).toBe(true)

  /* the identical request still deduplicates */
  expect(await executeScript({ script, idempotency_key: key }, caller, true)).toMatchObject({
    run_id: first.run_id,
    deduplicated: true,
  })

  /* a different principal reusing the key gets a conflict, not the cached
     result — the key was visible in the usage list either way */
  const other: ScriptCaller = {
    ...caller,
    userId: 'editor-2',
    actor: { kind: 'user', name: 'Ed', color: '#000' },
  }
  await expect(executeScript({ script, idempotency_key: key }, other, true)).rejects.toThrow(/different request/)

  /* mode changes are different requests too: a write key cannot satisfy a
     query or a dry run, nor the reverse */
  await expect(executeScript({ script, idempotency_key: key }, caller, false)).rejects.toThrow(/different request/)
  await expect(executeScript({ script, idempotency_key: key, dry_run: true }, caller, true)).rejects.toThrow(
    /different request/,
  )

  /* and a different script under the same key is a different request */
  await expect(executeScript({ script: 'return 2', idempotency_key: key }, caller, true)).rejects.toThrow(
    /different request/,
  )
})

it('an interleaved collaborator edit is not claimed by a motion run or its undo', async () => {
  /* an own account — the suite's shared caller would hit the per-minute rate */
  store.setLinkAccess(caller.canvasId, 'edit')
  const ilCaller: ScriptCaller = {
    ...caller,
    userId: 'interleave-user',
    actor: { kind: 'user', name: 'Il', color: '#000' },
  }
  const canvas = store.getCanvas(caller.canvasId)!
  const pageId = canvasPages(canvas)[0]!.id
  /* an unstamped target — the storyboard stamps it, which awaits a frame write */
  const shot = actions.createFrame(
    caller.canvasId,
    { name: 'Shot', html: '<html><body><h1>Headline</h1></body></html>', width: 400, height: 300 },
    caller.actor,
  )!
  const other = actions.createFrame(
    caller.canvasId,
    { name: 'Other', html: '<html><body>v1</body></html>', width: 100, height: 100 },
    caller.actor,
  )!

  /* hold the stamp's frame write open — the collaborator edits inside that wait */
  let release!: () => void
  vi.mocked(persist.saveFrameNow).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const running = executeScript(
    { script: `await diazo.compositions.storyboard(${JSON.stringify(pageId)})` },
    ilCaller,
    true,
  )
  await vi.waitFor(() => expect(release).toBeDefined())
  actions.updateFrame(
    other.id,
    { html: '<html><body>v2</body></html>' },
    {
      kind: 'user',
      name: 'Collab',
      color: '#111',
    },
  )
  release()
  const result = await running
  expect(result.ok).toBe(true)

  /* undo claims only what the run wrote — the page's composition and the
     frames it stamped (the unstamped target and the fixture frame share
     the page) — never the frame the collaborator touched */
  const undo = rows.get(result.run_id)!.undo ?? []
  expect(undo.map((e) => `${e.kind}:${e.id}`).sort()).toEqual(
    [`composition:${pageId}`, `frame:${shot.id}`, `frame:${frameId}`].sort(),
  )

  const report = await revertScriptRun(result.run_id, ilCaller)
  expect(report.unreverted).toEqual([])
  expect(store.getFrame(other.id)!.html).toContain('v2')
})
