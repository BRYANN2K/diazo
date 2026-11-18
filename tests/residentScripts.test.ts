import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Script tools in a resident run act as the person who asked: canvas role,
 * library reads and audit ownership follow the verified requester — never
 * the account that pays for the run, the canvas owner, or one of several
 * requesters picked at random. */

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
  loadFrameHtml: async () => [],
}))

/* a private library the payer can read and the asker cannot */
const lib = vi.hoisted(() => ({ canvasId: '' }))
vi.mock('../server/libraryQueries.ts', () => ({
  readableLibraries: vi.fn(async (userId: string) =>
    userId === 'payer' && lib.canvasId ? [{ id: lib.canvasId }] : [],
  ),
  searchLibraries: vi.fn(async (canvases: { id: string }[]) => ({
    hits: canvases.map((c) => ({
      item: { id: 'secret-item', label: 'payer-secret', category: 'component', tags: [] },
      libraryId: c.id,
    })),
  })),
  libraryFor: vi.fn(() => null),
  itemDetail: vi.fn(async () => null),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool } = await import('../server/resident.ts')
const { scriptRunDeps } = await import('../server/scriptRuns.ts')
type RunState = Parameters<typeof execTool>[3]
type StoredScriptRun = import('../server/scriptRuns.ts').StoredScriptRun

const actor = () => actions.resolveActor({ name: 'Diazo', kind: 'agent' })
const run = (over: Partial<RunState> = {}): RunState =>
  ({
    mutatedFrames: new Set<string>(),
    sourceFrames: new Set<string>(),
    verificationFrames: new Set<string>(),
    verifiedFrames: new Set<string>(),
    rewriteDrafts: new Map<string, string>(),
    vision: false,
    imagesGenerated: 0,
    repliedThreads: new Set<string>(),
    awaitingThreads: new Set<string>(),
    tokenWrites: 0,
    arrangeWrites: 0,
    ...over,
  }) as RunState
const call = (name: string, input: unknown = {}) => ({ type: 'tool_use' as const, id: 't1', name, input })
const text = (r: { content?: unknown }) => String(r.content)
const result = (r: { content?: unknown }) =>
  JSON.parse(text(r)) as { ok: boolean; error?: string; result?: unknown; run_id?: string }

let rows: Map<string, StoredScriptRun>
let canvasId: string
beforeEach(() => {
  rows = new Map()
  vi.spyOn(scriptRunDeps, 'save').mockImplementation(async (r) => {
    rows.set(r.record.id, structuredClone(r))
  })
  vi.spyOn(scriptRunDeps, 'get').mockImplementation(async (id) => structuredClone(rows.get(id)))
  vi.spyOn(scriptRunDeps, 'byKey').mockImplementation(async (canvas, key) =>
    structuredClone([...rows.values()].find((r) => r.record.canvasId === canvas && r.record.idempotencyKey === key)),
  )
  vi.spyOn(scriptRunDeps, 'release').mockImplementation(async (id) => {
    const r = rows.get(id)
    if (r) r.record.idempotencyKey = null
  })
  canvasId = store.createCanvas('Private', 'payer').id
  lib.canvasId = store.createCanvas('Payer library', 'payer').id
})

describe('resident script caller', () => {
  it('runs as the asker, not the payer — canvas permissions differ', async () => {
    /* the payer owns the canvas; the asker has no access to it at all */
    const state = run({ payerId: 'payer', askerId: 'asker' })
    const out = await execTool(call('run_script', { script: 'return 1' }), canvasId, actor(), state)
    expect(out.is_error).toBe(true)
    expect(text(out)).toMatch(/access refused|permission/i)
    expect(rows.size).toBe(0)
  })

  it('reads only the asker’s libraries, never the payer’s', async () => {
    store.setLinkAccess(canvasId, 'edit')
    const state = run({ payerId: 'payer', askerId: 'asker' })
    const out = await execTool(
      call('query_script', { script: 'return await diazo.libraries.search("payer-secret")' }),
      canvasId,
      actor(),
      state,
    )
    expect(out.is_error).toBeFalsy()
    expect(result(out).result).toEqual([])
  })

  it('records the run under the asker’s account', async () => {
    store.setLinkAccess(canvasId, 'edit')
    const state = run({ payerId: 'payer', askerId: 'asker' })
    const out = await execTool(call('run_script', { script: 'return 1' }), canvasId, actor(), state)
    expect(out.is_error).toBeFalsy()
    const res = result(out)
    expect(res.ok).toBe(true)
    expect(rows.get(res.run_id!)!.record.ownerId).toBe('asker')
  })

  it('refuses when the run serves several people', async () => {
    store.setLinkAccess(canvasId, 'edit')
    const state = run({ payerId: 'payer', mixedRequesters: true })
    for (const name of ['query_script', 'run_script', 'revert_script_run']) {
      const out = await execTool(
        call(name, name === 'revert_script_run' ? { run_id: 'r1' } : { script: 'return 1' }),
        canvasId,
        actor(),
        state,
      )
      expect(out.is_error).toBe(true)
      expect(text(out)).toMatch(/several people/)
    }
    expect(rows.size).toBe(0)
  })

  it('an anonymous asker runs as nobody — never as the canvas owner', async () => {
    /* no asker and no payer identity: the script gets anonymous access —
       canvasRole grants signed-out users nothing, so the run is refused
       instead of borrowing the owner's account */
    for (const link of ['none', 'edit'] as const) {
      store.setLinkAccess(canvasId, link)
      const out = await execTool(call('query_script', { script: 'return 1' }), canvasId, actor(), run({}))
      expect(out.is_error).toBe(true)
      expect(text(out)).toMatch(/access refused|permission/i)
    }
    expect(rows.size).toBe(0)
  })

  it('revert checks the asker’s edit access, not the payer’s', async () => {
    const state = run({ payerId: 'payer', askerId: 'asker' })
    const out = await execTool(call('revert_script_run', { run_id: 'r1' }), canvasId, actor(), state)
    expect(out.is_error).toBe(true)
    expect(text(out)).toMatch(/access/i)
  })
})
