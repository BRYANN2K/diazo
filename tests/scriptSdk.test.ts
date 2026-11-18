import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveTask: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveComposition: vi.fn(),
  saveFrameNow: vi.fn(async () => {}),
}))

import { dispatchScriptCall, nameMatcher, sdkPaths, SdkError, type ScriptRunContext } from '../server/scriptSdk.ts'
import { store } from '../server/store.ts'
import { createFrame, updateFrame } from '../server/actions.ts'
import { reloadEnv } from '../server/env.ts'
import { canvasPages } from '../shared/pages.ts'
import * as motionJobs from '../server/motionJobs.ts'
import * as persist from '../server/db/persist.ts'

const OWNER = 'owner-1'
const ACTOR = { kind: 'agent' as const, name: 'Script', color: '#000', runId: 'run-1' }

let canvasId: string
let frameId: string

function runCtx(
  opts: Omit<Partial<ScriptRunContext>, 'budgets'> & { budgets?: Partial<ScriptRunContext['budgets']> } = {},
): ScriptRunContext {
  const { budgets, ...rest } = opts
  return {
    canvasId,
    userId: OWNER,
    actor: ACTOR,
    write: true,
    dryRun: false,
    runId: 'run-1',
    budgets: { frameWrites: 40, snapshotBytes: 64 * 1024 * 1024, ...budgets },
    snapshots: new Map(),
    writes: [],
    ...rest,
  }
}

const BODY = `<div data-doop-id="hero"><h1 data-doop-id="title">Hello</h1><button data-doop-id="cta">Go</button></div>`
const HTML = `<!doctype html><html><head><style>h1{color:#ff0000}</style></head><body>${BODY}</body></html>`

beforeEach(() => {
  const canvas = store.createCanvas('Sdk Canvas', OWNER)
  canvasId = canvas.id
  const frame = createFrame(canvasId, { name: 'Home', html: HTML, width: 1200, height: 800 }, ACTOR)
  frameId = frame!.id
})

const call = (ctx: ScriptRunContext, path: string, ...args: unknown[]) => dispatchScriptCall(ctx, path, args)

describe('diazo sdk dispatch', () => {
  it('lists frames on the run canvas only', async () => {
    const frames = (await call(runCtx(), 'frames.list')) as { id: string; name: string }[]
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: frameId, name: 'Home' })
  })

  it('outlines and finds elements in a frame', async () => {
    const ctx = runCtx()
    const outline = (await call(ctx, 'frames.outline', frameId)) as { children: { id: string }[] }
    expect(outline.children.map((o) => o.id)).toContain('hero')
    const hits = (await call(ctx, 'frames.find', frameId, 'css:button')) as { elementId: string }[]
    expect(hits[0]!.elementId).toBe('cta')
  })

  it('refuses cross-canvas frames', async () => {
    const other = store.createCanvas('Other', OWNER)
    const foreign = createFrame(other.id, { name: 'X', html: HTML, width: 100, height: 100 }, ACTOR)!
    await expect(call(runCtx(), 'frames.outline', foreign.id)).rejects.toThrowError(/not on this canvas/)
  })

  it('query mode refuses every write path', async () => {
    const ctx = runCtx({ write: false })
    await expect(call(ctx, 'frames.update', frameId, { name: 'Nope' })).rejects.toThrowError(/read-only/)
    await expect(call(ctx, 'tokens.set', '--a', '#fff')).rejects.toThrowError(/read-only/)
    /* reads still work */
    const frames = await call(ctx, 'frames.list')
    expect(frames).toHaveLength(1)
  })

  it('a caller without canvas access is denied', async () => {
    const ctx = runCtx({ userId: 'stranger' })
    await expect(call(ctx, 'frames.list')).rejects.toThrowError(/view access/)
    await expect(call(ctx, 'frames.update', frameId, { name: 'x' })).rejects.toThrowError(/edit access/)
  })

  it('rejects an unknown diazo path', async () => {
    await expect(call(runCtx(), 'frames.explode', frameId)).rejects.toThrowError(/unknown diazo function/)
  })

  it('frames.edit applies ops and returns a review', async () => {
    const out = (await call(runCtx(), 'frames.edit', frameId, [
      { op: 'text', element: 'title', text: 'Bonjour' },
      { op: 'style', element: 'cta', property: 'background', value: 'rebeccapurple' },
    ])) as { applied: number; failed: { index: number; reason: string }[]; review: { lint: { score: number } } }
    expect(out.applied).toBe(2)
    expect(out.failed).toHaveLength(0)
    expect(store.getFrame(frameId)!.html).toContain('Bonjour')
    expect(out.review.lint.score).toBeGreaterThan(0)
  })

  it('frames.edit reports the ops that missed without writing', async () => {
    const before = store.getFrame(frameId)!.html
    const out = (await call(runCtx(), 'frames.edit', frameId, [{ op: 'text', element: 'nope', text: 'x' }])) as {
      applied: number
      failed: { index: number; reason: string }[]
    }
    expect(out.applied).toBe(0)
    expect(out.failed[0]!.reason).toMatch(/nope/)
    expect(store.getFrame(frameId)!.html).toBe(before)
  })

  it('dry run computes the edit but leaves the frame alone', async () => {
    const before = store.getFrame(frameId)!.html
    const out = (await call(runCtx({ dryRun: true }), 'frames.edit', frameId, [
      { op: 'text', element: 'title', text: 'Ghost' },
    ])) as { applied: number }
    expect(out.applied).toBe(1)
    expect(store.getFrame(frameId)!.html).toBe(before)
  })

  it('frames.create requires edit access and returns a frame ref', async () => {
    const ref = (await call(runCtx(), 'frames.create', { name: 'About', html: HTML, width: 800, height: 600 })) as {
      id: string
      name: string
      htmlChars: number
    }
    expect(ref.name).toBe('About')
    expect(store.getFrame(ref.id)!.canvasId).toBe(canvasId)
  })

  it('the frame_writes budget exhausts', async () => {
    const ctx = runCtx({ budgets: { frameWrites: 1 } })
    await call(ctx, 'frames.edit', frameId, [{ op: 'text', element: 'title', text: 'one' }])
    await expect(
      call(ctx, 'frames.edit', frameId, [{ op: 'text', element: 'title', text: 'two' }]),
    ).rejects.toThrowError(/frame_writes/)
  })

  it('tokens.create, tokens.set and tokens.get round-trip', async () => {
    const ctx = runCtx()
    const created = (await call(ctx, 'tokens.create', [{ name: '--ink', type: 'color', value: '#112233' }])) as {
      created: string[]
      failed: unknown[]
    }
    expect(created.created).toEqual(['--ink'])
    await call(ctx, 'tokens.set', '--ink', '#445566')
    const tokens = (await call(ctx, 'tokens.get', { namePattern: 'ink' })) as { name: string; value: string }[]
    expect(tokens[0]).toMatchObject({ name: '--ink', value: '#445566' })
  })

  it('frames.replaceValues swaps literals for var(--token)', async () => {
    const ctx = runCtx()
    await call(ctx, 'tokens.create', [{ name: '--brand', type: 'color', value: '#ff0000' }])
    const out = (await call(ctx, 'frames.replaceValues', frameId, { kinds: ['color'], match: 'exact' })) as {
      count: number
      unmapped: unknown[]
    }
    expect(out.count).toBeGreaterThanOrEqual(1)
    expect(store.getFrame(frameId)!.html).toContain('var(--brand)')
  })

  it('records writes for the audit trail', async () => {
    const ctx = runCtx()
    await call(ctx, 'frames.edit', frameId, [{ op: 'text', element: 'title', text: 'hi' }])
    expect(ctx.writes).toEqual([{ path: 'frames.edit', frameId }])
  })

  it('exposes the catalogue for get_sdk_docs', () => {
    const paths = sdkPaths()
    expect(paths.length).toBeGreaterThanOrEqual(30)
    expect(paths.find((p) => p.path === 'frames.edit')!.write).toBe(true)
    expect(paths.find((p) => p.path === 'frames.list')!.write).toBe(false)
  })

  it('frames.stream chunks the html across the section boundary', async () => {
    const html = `<!doctype html><html><body><section data-doop-id="a">A</section><section data-doop-id="b">B</section></body></html>`
    const out = (await call(runCtx(), 'frames.stream', frameId, html)) as { ok: boolean; sections: number }
    expect(out.ok).toBe(true)
    expect(store.getFrame(frameId)!.html).toBe(html)
  })

  it('refuses every write for query and view roles before validating arguments', async () => {
    const before = JSON.stringify(store.getCanvas(canvasId))
    for (const { path, write } of sdkPaths()) {
      if (!write) continue
      await expect(call(runCtx({ write: false }), path)).rejects.toThrow(/read-only/)
    }
    store.getCanvas(canvasId)!.linkAccess = 'view'
    for (const { path, write } of sdkPaths()) {
      if (write) await expect(call(runCtx({ userId: 'viewer' }), path)).rejects.toThrow(/edit access/)
    }
    store.getCanvas(canvasId)!.linkAccess = undefined
    expect(JSON.stringify(store.getCanvas(canvasId))).toBe(before)
  })

  it('honours AGENT_LIBRARY_WRITES on a library canvas', async () => {
    /* AGENT_GUIDELINE_WRITES has no SDK write to refuse: guideline edits are
       excluded from the SDK entirely (shared/scriptToolCoverage.ts). */
    store.getCanvas(canvasId)!.library = { enabled: true } as never
    vi.stubEnv('AGENT_LIBRARY_WRITES', 'false')
    reloadEnv()
    try {
      await expect(call(runCtx(), 'frames.update', frameId, { name: 'x' })).rejects.toThrow(/AGENT_LIBRARY_WRITES/)
      expect(await call(runCtx(), 'frames.list')).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      reloadEnv()
    }
  })

  it('dry-run edits compose and reads observe them', async () => {
    const ctx = runCtx({ dryRun: true })
    await call(ctx, 'frames.edit', frameId, [{ op: 'text', element: 'title', text: 'Draft' }])
    expect(await call(ctx, 'frames.html', frameId)).toContain('Draft')
    expect(store.getFrame(frameId)!.html).not.toContain('Draft')
  })

  it('rejects inherited dispatcher properties', async () => {
    await expect(call(runCtx(), 'constructor')).rejects.toThrow(/unknown/)
    await expect(call(runCtx(), '__proto__')).rejects.toThrow(/unknown/)
  })

  it('sdk errors carry a code for the client', async () => {
    try {
      await call(runCtx(), 'frames.outline', 'missing')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SdkError)
      expect((error as SdkError).code).toBe('not_found')
    }
  })

  it('caps the ops count of one frames.edit call', async () => {
    const ops = Array.from({ length: 65 }, () => ({ op: 'text', element: 'title', text: 'x' }))
    await expect(call(runCtx(), 'frames.edit', frameId, ops)).rejects.toThrowError(/64/)
  })

  it('caps the argument size of one call', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1)
    await expect(call(runCtx(), 'frames.html', frameId, { query: big })).rejects.toThrowError(/KB/)
    /* a call under the cap still goes through */
    await call(runCtx(), 'frames.html', frameId, { query: 'title' })
  })
})

describe('nameMatcher', () => {
  it('never builds a RegExp from guest input — a killer pattern answers fast', () => {
    const name = 'a'.repeat(26)
    for (const pattern of ['^(a|a)*$', '^(a|aa)+$', '(x+x+)+y', 'a?'.repeat(26) + 'a'.repeat(26)]) {
      const at = performance.now()
      nameMatcher(pattern)(name)
      expect(performance.now() - at).toBeLessThan(50)
    }
  })

  it('matches a plain substring case-insensitively', () => {
    expect(nameMatcher('ink')('--inky')).toBe(true)
    expect(nameMatcher('INK')('--ink')).toBe(true)
    expect(nameMatcher('paper')('--ink')).toBe(false)
  })

  it('treats * as a glob over the whole name', () => {
    expect(nameMatcher('--brand-*')('--brand-ink')).toBe(true)
    expect(nameMatcher('--brand-*')('x--brand-ink')).toBe(false)
    expect(nameMatcher('*-color')('--text-color')).toBe(true)
    expect(nameMatcher('--*-color')('--text-color')).toBe(true)
    expect(nameMatcher('--*-color')('--text-size')).toBe(false)
    expect(nameMatcher('*')('anything')).toBe(true)
    expect(nameMatcher('**')('anything')).toBe(true)
  })
})

describe('excluded tools', () => {
  it('compositions.render has no dispatch path and queues no job', async () => {
    /* a page that DOES have a composition — so the pre-fix handler would
       have reached the job queue: the refusal must be the missing path */
    const canvas = store.getCanvas(canvasId)!
    const pageId = canvasPages(canvas)[0]!.id
    canvas.compositions = [{ id: 'c1', canvasId, pageId, revision: 1 } as never]
    const created = vi
      .spyOn(motionJobs, 'createRenderJob')
      .mockImplementation(() => ({ ok: true, job: { id: 'j1' } }) as never)

    await expect(dispatchScriptCall(runCtx(), 'compositions.render', [pageId])).rejects.toThrow(
      /unknown diazo function/,
    )
    expect(created).not.toHaveBeenCalled()
    created.mockRestore()
  })
})

describe('storyboard stamping budget', () => {
  /* a user actor leaves the frame still — an agent-created frame opens a
     reveal, and streaming frames are never stamped */
  const stampable = (name: string, text: string) =>
    createFrame(
      canvasId,
      { name, html: `<html><body><h1>${text}</h1></body></html>`, width: 100, height: 100 },
      { kind: 'user', name: 'Owner', color: '#000' },
    )!
  const pageId = () => canvasPages(store.getCanvas(canvasId)!)[0]!.id

  it('refuses a storyboard that would stamp past the frame-write budget, writing nothing', async () => {
    const first = stampable('S1', 'One')
    stampable('S2', 'Two')
    /* two stampable frames, one write left — the call is refused before
       any composition or stamp lands */
    const ctx = runCtx({ budgets: { frameWrites: 1 } })
    await expect(dispatchScriptCall(ctx, 'compositions.storyboard', [pageId()])).rejects.toThrow(/frame_writes/)
    expect(store.getComposition(canvasId, pageId())).toBeUndefined()
    expect(store.getFrame(first.id)!.html).not.toContain('data-doop-id')
  })

  it('spends exactly the counted budget', async () => {
    const first = stampable('S1', 'One')
    stampable('S2', 'Two')
    const ctx = runCtx({ budgets: { frameWrites: 2 } })
    const out = (await dispatchScriptCall(ctx, 'compositions.storyboard', [pageId()])) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(ctx.budgets.frameWrites).toBe(0)
    expect(store.getComposition(canvasId, pageId())).toBeTruthy()
    expect(store.getFrame(first.id)!.html).toContain('data-doop-id')
  })

  it('stops stamping when the run is cut at an async boundary', async () => {
    stampable('S1', 'One')
    stampable('S2', 'Two')
    const ctx = runCtx({ budgets: { frameWrites: 10 } })
    let release!: () => void
    vi.mocked(persist.saveFrameNow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const pending = dispatchScriptCall(ctx, 'compositions.storyboard', [pageId()])
    await vi.waitFor(() => expect(release).toBeDefined())
    ctx.active = false
    release()
    await expect(pending).rejects.toThrow(/cut/)
  })

  it('spends the reservation per actual stamp — a frame that grows unstamped content mid-op is skipped', async () => {
    /* one frame needs a stamp at preflight, one does not: while the first
       stamp's write is held open, a collaborator makes the second frame
       unstamped — the reservation was one, so that late content is never
       written past it */
    const first = createFrame(
      canvasId,
      { name: 'S1', html: '<html><body><h1>One</h1></body></html>', width: 100, height: 100, x: 0, y: 0 },
      { kind: 'user', name: 'Owner', color: '#000' },
    )!
    const second = createFrame(
      canvasId,
      {
        name: 'S2',
        /* a real element id (six alnum) — already stamped at preflight, so
           the reservation counts only the first frame */
        html: '<html><body><h1 data-doop-id="abc123">Two</h1></body></html>',
        width: 100,
        height: 100,
        x: 400,
        y: 0,
      },
      { kind: 'user', name: 'Owner', color: '#000' },
    )!
    const ctx = runCtx({ budgets: { frameWrites: 10 } })
    let release!: () => void
    vi.mocked(persist.saveFrameNow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const pending = dispatchScriptCall(ctx, 'compositions.storyboard', [pageId()])
    await vi.waitFor(() => {
      expect(release).toBeDefined()
      expect(persist.saveFrameNow).toHaveBeenCalled()
    })
    updateFrame(
      second.id,
      { html: '<html><body><h1>New</h1></body></html>' },
      { kind: 'user', name: 'Collab', color: '#111' },
    )
    release()
    const out = (await pending) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(store.getFrame(first.id)!.html).toContain('data-doop-id')
    expect(store.getFrame(second.id)!.html).toBe('<html><body><h1>New</h1></body></html>')
  })

  it('a run cut during the canvas load writes no composition at all', async () => {
    /* the op's own load is the third: preflight, mutateAsync, then the one
       inside the storyboard — the cut landing there must stop the
       composition mutation, not just a later stamp */
    stampable('S1', 'One')
    const ctx = runCtx({ budgets: { frameWrites: 10 } })
    vi.mocked(persist.saveFrameNow).mockClear()
    let loads = 0
    const loadSpy = vi.spyOn(store, 'load').mockImplementation(async (id) => {
      if (++loads >= 3) ctx.active = false
      return store.getCanvas(id)
    })
    await expect(dispatchScriptCall(ctx, 'compositions.storyboard', [pageId()])).rejects.toThrow(/cut/)
    loadSpy.mockRestore()
    expect(store.getComposition(canvasId, pageId())).toBeUndefined()
    expect(persist.saveFrameNow).not.toHaveBeenCalled()
  })
})
