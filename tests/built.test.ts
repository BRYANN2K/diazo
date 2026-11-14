import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/* The Built page engine with its seams stubbed (capture, design render,
   asset store, drift record): matching, placement on the Built page and
   re-delivery in place, without a browser or a database. Same store/persist
   stubs as drift.test.ts. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: () => Promise.resolve(),
  saveFrameVersion: () => {},
  deleteFrame: () => {},
}))
vi.mock('../server/db/index.ts', () => ({
  db: {
    insert: () => ({ values: () => Promise.resolve() }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}))

const shared = await import('../shared/built.ts')
const { matchDesignFrame, runDelivery, newDelivery, signBuilt, signatureProblem, enqueue } =
  await import('../server/built.ts')
const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const { canvasPages, framePageId } = await import('../shared/pages.ts')

type Deps = Parameters<typeof runDelivery>[1] & object

const png = (width: number, height: number, background = '#ffffff') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer()

describe('shared/built', () => {
  it('normalizes route paths', () => {
    expect(shared.normalizeRoute('/')).toBe('/')
    expect(shared.normalizeRoute('/pricing/')).toBe('/pricing')
    expect(shared.normalizeRoute('/a/b?x=1#top')).toBe('/a/b?x=1')
    expect(shared.normalizeRoute('pricing')).toBeNull()
    expect(shared.normalizeRoute('//evil.example/x')).toBeNull()
    expect(shared.normalizeRoute('https://evil.example')).toBeNull()
    expect(shared.normalizeRoute('/a b')).toBeNull()
    expect(shared.normalizeRoute(42)).toBeNull()
  })

  it('folds routes and frame names to the same keys', () => {
    expect(shared.routeNameKeys('/')).toContain('home')
    expect(shared.routeNameKeys('/docs/getting-started')).toEqual(
      expect.arrayContaining(['docs getting started', 'getting started']),
    )
    expect(shared.frameNameKey('Pricing page')).toBe('pricing')
    expect(shared.frameNameKey('Getting Started')).toBe('getting started')
  })

  it('appends routes to the deploy path and keeps them on its origin', () => {
    expect(shared.routeUrl('https://x.example/repo/', '/pricing').href).toBe('https://x.example/repo/pricing')
    expect(shared.routeUrl('https://x.example', '/').href).toBe('https://x.example/')
  })

  it('validates a payload', () => {
    const ok = shared.parseBuiltPayload({
      deployUrl: 'https://preview-1.vercel.app',
      routes: ['/', '/pricing/', '/pricing', { path: '/login', frame: 'Sign in' }],
      commit: 'abc123',
    })
    expect(ok).toEqual({
      ok: true,
      payload: {
        deployUrl: 'https://preview-1.vercel.app',
        routes: [{ path: '/' }, { path: '/pricing' }, { path: '/login', frame: 'Sign in' }],
        commit: 'abc123',
      },
    })
    expect(shared.parseBuiltPayload(null)).toMatchObject({ ok: false, status: 400 })
    expect(shared.parseBuiltPayload({ routes: ['/'] })).toMatchObject({ ok: false, status: 400 })
    expect(shared.parseBuiltPayload({ deployUrl: 'ftp://x.example', routes: ['/'] })).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(shared.parseBuiltPayload({ deployUrl: 'https://x.example', routes: [] })).toMatchObject({ ok: false })
    expect(shared.parseBuiltPayload({ deployUrl: 'https://x.example', routes: ['nope'] })).toMatchObject({
      ok: false,
    })
    const tooMany = Array.from({ length: shared.BUILT_MAX_ROUTES + 1 }, (_, i) => `/p${i}`)
    expect(shared.parseBuiltPayload({ deployUrl: 'https://x.example', routes: tooMany })).toMatchObject({
      ok: false,
    })
  })

  it('refuses local deploy URLs with a 422, like the drift CI hook', () => {
    for (const deployUrl of ['http://localhost:3000', 'http://10.0.0.2', 'http://169.254.169.254', 'http://[::1]']) {
      expect(shared.parseBuiltPayload({ deployUrl, routes: ['/'] }), deployUrl).toMatchObject({
        ok: false,
        status: 422,
      })
    }
  })
})

describe('signatures', () => {
  const body = Buffer.from('{"deployUrl":"https://x.example","routes":["/"]}')
  it('accepts the outbound webhook scheme', () => {
    const now = 1_791_216_000_000
    const signature = signBuilt('bhsec_test', now, body)
    expect(signatureProblem('bhsec_test', { timestamp: String(now), signature }, body, now)).toBeNull()
  })

  it('refuses a wrong secret, a tampered body, a stale or missing timestamp', () => {
    const now = 1_791_216_000_000
    const signature = signBuilt('bhsec_test', now, body)
    expect(signatureProblem('bhsec_other', { timestamp: String(now), signature }, body, now)).toMatch(/match/)
    expect(signatureProblem('bhsec_test', { timestamp: String(now), signature }, Buffer.from('{}'), now)).toMatch(
      /match/,
    )
    expect(signatureProblem('bhsec_test', { timestamp: String(now), signature }, body, now + 6 * 60_000)).toMatch(
      /clock/,
    )
    expect(signatureProblem('bhsec_test', { signature }, body, now)).toMatch(/Timestamp/)
    expect(signatureProblem('bhsec_test', { timestamp: String(now) }, body, now)).toMatch(/match/)
  })
})

describe('the Built page delivery', () => {
  let canvasId: string
  const actor = () => actions.resolveActor({ name: 'Preview deploy', kind: 'user' })
  let assets = 0
  let comparisons: { frameId: string; shippedFrameId?: string; score?: number }[] = []

  const deps = (overrides: Partial<Deps> = {}): Deps => ({
    capture: async (url, width) => ({
      png: await png(width, 300),
      finalUrl: url.href,
      title: 'page',
      width,
      height: 300,
    }),
    renderDesign: async (frame) => png(Math.round(frame.width), Math.round(frame.height)),
    score: async () => ({ score: 12.5, diffPixels: 1, totalPixels: 8, width: 1, height: 1 }),
    assertPublic: async (u) => new URL(u),
    now: () => 42,
    storeAsset: async () => ({ id: `asset${++assets}`, mime: 'image/png', ext: 'png', size: 1 }) as never,
    saveComparison: async (record) => {
      comparisons.push(record)
      return record
    },
    ...overrides,
  })

  beforeEach(() => {
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    assets = 0
    comparisons = []
    canvasId = store.createCanvas('built', 'kevin').id
  })

  const design = (name: string, width = 400, height = 300) =>
    actions.createFrame(canvasId, { name, x: 0, y: 0, width, height, html: `<p>${name}</p>` }, actor())!

  const deliver = async (
    routes: (string | { path: string; frame?: string })[],
    state: Parameters<typeof runDelivery>[0]['state'] = { captures: {}, mappings: {}, builtPageId: null },
    overrides: Partial<Deps> = {},
  ) => {
    const parsed = shared.parseBuiltPayload({ deployUrl: 'https://preview.example.com', routes })
    if (!parsed.ok) throw new Error(parsed.error)
    return runDelivery(
      {
        canvasId,
        delivery: newDelivery(parsed.payload, 1),
        payload: parsed.payload,
        state,
        actor: actor(),
        ownerId: 'kevin',
      },
      deps(overrides),
    )
  }

  it('creates the Built page and places each route beside its designed frame', async () => {
    const pricing = design('Pricing page', 400, 300)
    const out = await deliver(['/pricing', '/unknown'])
    const canvas = store.getCanvas(canvasId)!
    const page = canvasPages(canvas).find((p) => p.id === out.builtPageId)
    expect(page?.name).toBe('Built')
    expect(out.delivery.status).toBe('done')

    const [priced, unknown] = out.delivery.routes
    expect(priced).toMatchObject({
      route: '/pricing',
      status: 'captured',
      designFrameId: pricing.id,
      matchedBy: 'name',
      score: 12.5,
    })
    expect(priced!.driftUrl).toContain(`frame=${pricing.id}`)
    expect(priced!.driftUrl).toContain(`drift=${priced!.comparisonId}`)
    const built = store.getFrame(priced!.builtFrameId!)!
    const snapshot = store.getFrame(out.captures['/pricing']!.designSnapshotFrameId!)!
    expect(framePageId(canvas, built)).toBe(out.builtPageId)
    expect(framePageId(canvas, snapshot)).toBe(out.builtPageId)
    /* designed on the left, shipped on the right, same row */
    expect(snapshot.x).toBe(0)
    expect(built.x).toBe(400 + shared.BUILT_GAP_X)
    expect(built.y).toBe(snapshot.y)
    expect(built.width).toBe(400)
    expect(built.html).toContain('/a/asset1.png')
    expect(snapshot.name).toBe('Designed — Pricing page')
    expect(comparisons).toEqual([expect.objectContaining({ frameId: pricing.id, shippedFrameId: built.id })])

    /* no design: captured at the default width, no comparison, a row below */
    expect(unknown).toMatchObject({ route: '/unknown', status: 'captured' })
    expect(unknown!.designFrameId).toBeUndefined()
    const lone = store.getFrame(unknown!.builtFrameId!)!
    expect(lone.width).toBe(shared.BUILT_DEFAULT_WIDTH)
    expect(lone.y).toBeGreaterThan(built.y + built.height)
  })

  it('updates the same frames on a re-delivery instead of duplicating them', async () => {
    design('Home')
    const first = await deliver(['/'])
    const framesAfterFirst = store.getCanvas(canvasId)!.frames.length
    const builtId = first.captures['/']!.builtFrameId
    store.updateFrame(builtId, { x: 900, y: 700 }, 'kevin')

    const second = await deliver(['/'], { captures: first.captures, mappings: {}, builtPageId: first.builtPageId })
    expect(store.getCanvas(canvasId)!.frames.length).toBe(framesAfterFirst)
    expect(second.builtPageId).toBe(first.builtPageId)
    expect(second.captures['/']!.builtFrameId).toBe(builtId)
    expect(second.captures['/']!.designSnapshotFrameId).toBe(first.captures['/']!.designSnapshotFrameId)
    const built = store.getFrame(builtId)!
    /* kept where the user moved it, with the new capture inside */
    expect(built.x).toBe(900)
    expect(built.html).toContain('/a/asset3.png')
    expect(canvasPages(store.getCanvas(canvasId)!).filter((p) => p.name === 'Built')).toHaveLength(1)
  })

  it('recreates a capture the user deleted', async () => {
    design('Home')
    const first = await deliver(['/'])
    store.deleteFrame(first.captures['/']!.builtFrameId)
    const second = await deliver(['/'], { captures: first.captures, mappings: {}, builtPageId: first.builtPageId })
    expect(second.captures['/']!.builtFrameId).not.toBe(first.captures['/']!.builtFrameId)
    expect(store.getFrame(second.captures['/']!.builtFrameId)).toBeDefined()
  })

  it('reports a failing route and still lands the others', async () => {
    design('Home')
    const out = await deliver(['/', '/broken'], undefined, {
      capture: async (url, width) => {
        if (url.pathname === '/broken') throw new Error('the page would not load')
        return { png: await png(width, 300), finalUrl: url.href, title: 'x', width, height: 300 }
      },
    })
    expect(out.delivery.routes.map((r) => r.status)).toEqual(['captured', 'failed'])
    expect(out.delivery.routes[1]!.error).toMatch(/would not load/)
    expect(out.captures['/broken']).toBeUndefined()
  })

  it('refuses a deploy that resolves to a private address', async () => {
    const out = await deliver(['/'], undefined, {
      assertPublic: async () => {
        throw new Error('host is not reachable from this server')
      },
    })
    expect(out.delivery.routes[0]).toMatchObject({ status: 'failed' })
    expect(out.delivery.routes[0]!.error).toMatch(/private address/)
  })

  it('keeps the capture when the design will not render', async () => {
    design('Home')
    const out = await deliver(['/'], undefined, {
      renderDesign: async () => {
        throw new Error('no renderer')
      },
    })
    expect(out.delivery.routes[0]).toMatchObject({ status: 'captured' })
    expect(out.delivery.routes[0]!.score).toBeUndefined()
    expect(out.captures['/']!.designSnapshotFrameId).toBeUndefined()
  })
})

describe('matchDesignFrame', () => {
  it('prefers the payload, then the mapping, then the name, and skips Built frames', () => {
    const canvasId = store.createCanvas('match', 'kevin').id
    const actor = actions.resolveActor({ name: 'kevin', kind: 'user' })
    const make = (name: string) => actions.createFrame(canvasId, { name, width: 10, height: 10, html: '' }, actor)!
    const login = make('Login')
    const signIn = make('Sign in')
    const own = make('Built — /login')
    const canvas = store.getCanvas(canvasId)!
    expect(matchDesignFrame(canvas, { path: '/login' }, {})).toMatchObject({ frame: login, by: 'name' })
    expect(matchDesignFrame(canvas, { path: '/login' }, { '/login': signIn.id })).toMatchObject({
      frame: signIn,
      by: 'mapping',
    })
    expect(matchDesignFrame(canvas, { path: '/login', frame: 'sign in' }, { '/login': login.id })).toMatchObject({
      frame: signIn,
      by: 'payload',
    })
    expect(matchDesignFrame(canvas, { path: '/login', frame: login.id }, {})).toMatchObject({ by: 'payload' })
    expect(
      matchDesignFrame(canvas, { path: '/login', frame: own.id }, {}, { excluded: new Set([own.id]) }),
    ).toMatchObject({ frame: login, by: 'name' })
    expect(matchDesignFrame(canvas, { path: '/nothing' }, {})).toBeUndefined()
  })
})

describe('enqueue', () => {
  it('runs one canvas’s deliveries one at a time', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const a = enqueue('c1', async () => {
      order.push('a:start')
      await gate
      order.push('a:end')
    })
    const b = enqueue('c1', async () => {
      order.push('b')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['a:start'])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
  })
})
