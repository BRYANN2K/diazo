import { afterEach, describe, expect, it, vi } from 'vitest'

/* the remote fetch and the account lookup are the two seams a provider
 * call crosses; both are faked so the key flow is observable */
const remoteCalls = vi.hoisted(() => [] as { url: string; options: Record<string, unknown> }[])
vi.mock('../server/assets.ts', () => ({
  fetchRemote: vi.fn(async (url: string, _max: number, options: Record<string, unknown>) => {
    remoteCalls.push({ url, options })
    /* a minimal valid mp4 header */
    return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)])
  }),
}))
const pinnedCalls = vi.hoisted(() => [] as { url: string; headers?: Record<string, string> }[])
const pinnedReplies = vi.hoisted(() => ({ queue: [] as { status: number; location?: string; body?: Buffer }[] }))
vi.mock('../server/publicUrl.ts', () => ({
  parsePublicHttpUrl: vi.fn((raw: string) => new URL(raw)),
  fetchPinnedPublicUrl: vi.fn(async (url: URL, init: RequestInit) => {
    pinnedCalls.push({ url: url.href, headers: (init.headers ?? {}) as Record<string, string> })
    const next = pinnedReplies.queue.shift() ?? { status: 200, body: Buffer.from('x') }
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: new Headers(next.location ? { location: next.location } : {}),
      body: next.body
        ? {
            getReader: () => {
              let sent = false
              return {
                read: async () =>
                  sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: next.body! }),
                cancel: async () => {},
              }
            },
          }
        : null,
    }
  }),
}))
vi.mock('../server/modelAccounts.ts', () => ({
  getAccounts: vi.fn(async () => [{ kind: 'gemini-key', enabled: true, apiKey: 'TEST_GEMINI_KEY' }]),
}))
const fetchCalls = vi.hoisted(() => [] as { url: string; init: RequestInit }[])
const fetchReplies = vi.hoisted(() => ({ queue: [] as Record<string, unknown>[] }))

const { downloadVideo, sniffVideoMime, generateVideo, VideoGenError } = await import('../server/videoGen.ts')
const { fetchRemote } = await import('../server/assets.ts')

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} })
  const body = fetchReplies.queue.shift() ?? {}
  return new Response(JSON.stringify(body), { status: 200 })
}) as typeof fetch

afterEach(() => {
  remoteCalls.length = 0
  pinnedCalls.length = 0
  pinnedReplies.queue.length = 0
  fetchCalls.length = 0
  fetchReplies.queue.length = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('sniffVideoMime', () => {
  const head = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand, 'latin1')])

  it('accepts real mp4 and webm signatures', () => {
    expect(sniffVideoMime(head('mp42'))).toBe('video/mp4')
    expect(sniffVideoMime(head('isom'))).toBe('video/mp4')
    expect(sniffVideoMime(head('M4V '))).toBe('video/mp4')
    expect(sniffVideoMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))).toBe('video/webm')
  })

  it('refuses images, audio-only brands and junk', () => {
    /* heic/heix are still pictures, M4A is audio — none of them is a
     * clip the timeline can play */
    expect(sniffVideoMime(head('heic'))).toBeUndefined()
    expect(sniffVideoMime(head('heix'))).toBeUndefined()
    expect(sniffVideoMime(head('M4A '))).toBeUndefined()
    expect(sniffVideoMime(Buffer.from('<!DOCTYPE html><html>'))).toBeUndefined()
    expect(sniffVideoMime(Buffer.from('ftyp'))).toBeUndefined()
    expect(sniffVideoMime(head('xxxx'))).toBeUndefined()
  })
})

describe('downloadVideo', () => {
  it('streams through the pinned fetch under the video cap, headers passed along', async () => {
    const buf = await downloadVideo('https://generativelanguage.googleapis.com/v1beta/files/v1:download', {
      'x-goog-api-key': 'K',
    })
    expect(remoteCalls).toHaveLength(1)
    expect(remoteCalls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/files/v1:download')
    expect(remoteCalls[0]!.options.headers).toEqual({ 'x-goog-api-key': 'K' })
    expect(buf.length).toBeGreaterThan(0)
  })

  it('refuses a body that is not video', async () => {
    vi.mocked(fetchRemote).mockResolvedValueOnce(Buffer.from('<html>nope</html>'))
    await expect(downloadVideo('https://example.com/v')).rejects.toThrow(VideoGenError)
  })

  it('wraps transport failures in VideoGenError', async () => {
    vi.mocked(fetchRemote).mockRejectedValueOnce(new Error('fetch failed: HTTP 403'))
    await expect(downloadVideo('https://example.com/v')).rejects.toThrow(VideoGenError)
  })
})

describe('fetchRemote credential forwarding', () => {
  it('re-sends caller headers on same-origin redirects only', async () => {
    pinnedReplies.queue.push(
      { status: 302, location: 'https://generativelanguage.googleapis.com/other' },
      { status: 302, location: 'https://evil.example/clip.mp4' },
      { status: 200, body: Buffer.from('ok') },
    )
    /* the real implementation under the mocked publicUrl pins */
    const real = (await vi.importActual<typeof import('../server/assets.ts')>('../server/assets.ts')).fetchRemote
    await real('https://generativelanguage.googleapis.com/start', 1024, {
      headers: { 'x-goog-api-key': 'SECRET' },
    })
    expect(pinnedCalls).toHaveLength(3)
    expect(pinnedCalls[0]!.headers?.['x-goog-api-key']).toBe('SECRET')
    expect(pinnedCalls[1]!.headers?.['x-goog-api-key']).toBe('SECRET')
    expect(pinnedCalls[2]!.headers?.['x-goog-api-key']).toBeUndefined()
  })
})

describe('gemini video key handling', () => {
  it('sends the key as a header, never inside a url', async () => {
    vi.useFakeTimers()
    fetchReplies.queue.push(
      { name: 'models/gemini-omni-1.2-flash/operations/op1' },
      {
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/v9:download' } },
            ],
          },
        },
      },
    )
    const pending = generateVideo('u1', { prompt: 'a boat', model: 'gemini-omni-1.2-flash', seconds: 8 })
    await vi.advanceTimersByTimeAsync(60_000)
    const out = await pending
    expect(out.recipe.provider).toBe('gemini')
    const urls = fetchCalls.map((c) => c.url)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(url).not.toContain('key=')
      expect(new URL(url).host).toBe('generativelanguage.googleapis.com')
    }
    expect(urls[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.2-flash:predictLongRunning',
    )
    expect(urls[1]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.2-flash/operations/op1')
    const heads = fetchCalls.map((c) => new Headers(c.init.headers))
    expect(heads[0]!.get('x-goog-api-key')).toBe('TEST_GEMINI_KEY')
    expect(heads[1]!.get('x-goog-api-key')).toBe('TEST_GEMINI_KEY')
    /* the download carried the key in a header, and only to google */
    expect(remoteCalls[0]!.options.headers).toEqual({ 'x-goog-api-key': 'TEST_GEMINI_KEY' })
  })

  it('refuses a download uri off the fixed google host', async () => {
    vi.useFakeTimers()
    fetchReplies.queue.push(
      { name: 'models/gemini-omni-1.2-flash/operations/op2' },
      {
        done: true,
        response: {
          generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://evil.example/steal?k=' } }] },
        },
      },
    )
    const pending = generateVideo('u1', { prompt: 'x', model: 'gemini-omni-1.2-flash', seconds: 8 })
    const assertion = expect(pending).rejects.toThrow(/not on generativelanguage\.googleapis\.com/)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(remoteCalls).toHaveLength(0)
  })

  it('refuses a malformed operation name', async () => {
    fetchReplies.queue.push({ name: 'https://evil.example/x' })
    await expect(generateVideo('u1', { prompt: 'x', model: 'gemini-omni-1.2-flash', seconds: 8 })).rejects.toThrow(
      /malformed operation name/,
    )
    expect(fetchCalls).toHaveLength(1)
  })
})
