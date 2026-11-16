/**
 * Loading server-rendered images (library thumbnails in the gallery, frame
 * previews on a zoomed-out stage): a few requests at a time
 * (a page of tiles never fires hundreds at once), and the answer read by
 * status, so a renderer that is busy (503 + Retry-After) or an anonymous
 * viewer past its render budget (429 + Retry-After) is retried rather than
 * taken for a broken image.
 */

export type ThumbLoad =
  /** `stale`: the server sent an older render while it draws the current one */
  | { kind: 'ok'; blob: Blob; stale: boolean }
  /** the server is drawing it: ask again after `retryAfterMs` */
  | { kind: 'busy'; retryAfterMs: number }
  /** a real failure (404, 500, a broken response): show the fallback */
  | { kind: 'failed' }

/** Requests in flight at once. */
export const MAX_IN_FLIGHT = 6
/** Tries before a busy thumbnail gives up and shows the fallback. */
export const MAX_TRIES = 5
const MAX_DELAY_MS = 30_000

/** How long to wait before try `attempt` (1 is the first retry): what the
 *  server asked, else a doubling backoff, capped, with a little jitter so a
 *  page of tiles does not come back at the same instant. */
export function retryDelay(attempt: number, retryAfterMs: number, random: () => number = Math.random): number {
  const backoff = 1000 * 2 ** Math.max(0, attempt - 1)
  const base = Math.min(MAX_DELAY_MS, backoff)
  return Math.max(retryAfterMs, Math.round(base * (0.9 + random() * 0.2)))
}

/** Retry-After in ms: seconds or an HTTP date; 5s when unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 5000
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : 5000
}

let active = 0
const waiting: (() => void)[] = []

function next() {
  while (active < MAX_IN_FLIGHT && waiting.length) waiting.shift()!()
}

async function fetchThumb(url: string, signal: AbortSignal): Promise<ThumbLoad> {
  let res: Response
  try {
    res = await fetch(url, { signal, credentials: 'same-origin' })
    /* a network blip (offline, dropped connection, a body that never
       finished) is retried like a busy renderer: bounded backoff, then
       the fallback — never a permanent black tile for a transient cause */
    if (!res.ok)
      return res.status === 503 || res.status === 429
        ? { kind: 'busy', retryAfterMs: retryAfterMs(res.headers.get('Retry-After')) }
        : { kind: 'failed' }
    return { kind: 'ok', blob: await res.blob(), stale: res.headers.get('X-Doop-Preview') === 'stale' }
  } catch (error) {
    if (signal.aborted) throw error
    return { kind: 'busy', retryAfterMs: 0 }
  }
}

/** One thumbnail, in turn with the others. Aborting drops it from the
 *  line, or cancels it in flight (the promise then rejects). */
export function loadThumb(url: string, signal: AbortSignal): Promise<ThumbLoad> {
  return new Promise((resolve, reject) => {
    const drop = () => {
      const at = waiting.indexOf(start)
      if (at >= 0) waiting.splice(at, 1)
      reject(new DOMException('aborted', 'AbortError'))
    }
    function start() {
      signal.removeEventListener('abort', drop)
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
      active++
      fetchThumb(url, signal)
        .then(resolve, (error: unknown) => (signal.aborted ? reject(error) : resolve({ kind: 'failed' })))
        .finally(() => {
          active--
          next()
        })
    }
    signal.addEventListener('abort', drop, { once: true })
    waiting.push(start)
    next()
  })
}

/** Requests in flight and waiting (tests). */
export function thumbLoaderStats(): { active: number; waiting: number } {
  return { active, waiting: waiting.length }
}
