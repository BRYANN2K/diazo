import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadThumb, retryAfterMs, retryDelay } from '../src/lib/thumbLoader'

/* The loader's one dependency is fetch: drive its answers and rejections and
   watch the load kinds the cache acts on. */
const respond = (init: { status?: number; body?: string; headers?: Record<string, string> }) => {
  const { status = 200, body = 'x', headers = {} } = init
  return Promise.resolve(new Response(body, { status, headers }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('retryDelay', () => {
  it('honours Retry-After, doubles its own backoff, and stays bounded', () => {
    const rand = () => 0.5 // no jitter: the base comes back untouched
    expect(retryDelay(1, 12_000, rand)).toBe(12_000)
    expect(retryDelay(1, 0, rand)).toBe(1_000)
    expect(retryDelay(3, 0, rand)).toBe(4_000)
    expect(retryDelay(1, 60_000, () => 0)).toBe(60_000)
    expect(retryDelay(20, 0, rand)).toBe(30_000) // capped
  })
})

describe('retryAfterMs', () => {
  it('reads seconds, an HTTP date, and falls back on junk', () => {
    expect(retryAfterMs('2')).toBe(2_000)
    expect(retryAfterMs(null)).toBe(5_000)
    expect(retryAfterMs('garbage')).toBe(5_000)
    const soon = new Date(Date.now() + 3_000).toUTCString()
    expect(retryAfterMs(soon)).toBeGreaterThan(0)
    expect(retryAfterMs(soon)).toBeLessThanOrEqual(3_000)
  })
})

describe('loadThumb', () => {
  it('returns the decoded bytes and the stale marker', async () => {
    vi.stubGlobal('fetch', () => respond({ body: 'img', headers: { 'X-Doop-Preview': 'stale' } }))
    const res = await loadThumb('/i/a.jpg', new AbortController().signal)
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') expect(res.stale).toBe(true)
  })

  it('treats 503 and 429 as busy, honouring Retry-After', async () => {
    for (const status of [503, 429]) {
      vi.stubGlobal('fetch', () => respond({ status, headers: { 'Retry-After': '2' } }))
      const res = await loadThumb('/i/a.jpg', new AbortController().signal)
      expect(res).toEqual({ kind: 'busy', retryAfterMs: 2_000 })
    }
  })

  it('treats a network failure as retryable, not as a verdict', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const res = await loadThumb('/i/a.jpg', new AbortController().signal)
    expect(res).toEqual({ kind: 'busy', retryAfterMs: 0 })
  })

  it('treats a real error status as failed', async () => {
    vi.stubGlobal('fetch', () => respond({ status: 404 }))
    const res = await loadThumb('/i/a.jpg', new AbortController().signal)
    expect(res.kind).toBe('failed')
  })

  it('rejects when the asker lets go mid-flight', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    )
    let called = false
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => {
      called = true
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )
    })
    const abort = new AbortController()
    const p = loadThumb('/i/a.jpg', abort.signal)
    await vi.waitFor(() => expect(called).toBe(true))
    abort.abort()
    await expect(p).rejects.toThrow('aborted')
  })
})
